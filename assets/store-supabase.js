/* Sulthan's — Supabase backend for the app's `db` store.
   Registers itself as a lib on load. The app attaches it only when config.js
   carries credentials; otherwise nothing here runs and the localStorage store
   stays in charge. Writes are optimistic: local state changes first (so the UI
   never waits on the network), then the same change is mirrored to Postgres.
   Reads come back through Realtime, so a price change or an 86'd dish lands on
   every open device within a second. */
(function () {
  function deviceId() {
    let d = null;
    try { d = localStorage.getItem('sulthans.dev'); } catch (e) {}
    if (!d) {
      d = 'd' + Math.random().toString(36).slice(2, 10);
      try { localStorage.setItem('sulthans.dev', d); } catch (e) {}
    }
    return d;
  }

  const CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';

  const loadScript = src => new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = res; s.onerror = () => rej(new Error('could not load ' + src));
    document.head.appendChild(s);
  });

  const qtyOf = items => {
    const m = {};
    (items || []).forEach(i => { m[i.id] = (m[i.id] || 0) + i.qty; });
    return m;
  };
  const ms = t => new Date(t).getTime();
  const DEAD_KEY = 'sul.cleared.ids.v2';

  class Remote {
    constructor(sb, db, cfg) {
      this.sb = sb; this.db = db; this.cfg = cfg;
      this.dishId = {}; this.dishSlug = {}; this.catId = {}; this.orderId = {}; this.callId = {};
      this.gone = db.clearedLoad ? db.clearedLoad() : this.goneLoad();
      this.dead = this.idsLoad();    // label -> {ids, at}: rows a clear covered, quarantined until the server agrees they are closed
      /* Every open row id the last read saw, per label — including the ones that
         lost the newest-row contest. A clear quarantines from this map with no
         await in front of it, which is what makes the quarantine win the race
         against a hydrate already in flight. */
      this.lastOpen = {};
      this.closing = {};             // retry throttle, per label
      this.staff = false; this.queue = Promise.resolve();
    }

    async boot() {
      const { data: rest, error } = await this.sb.from('restaurants')
        .select('id,slug,name,table_count,payment_qr')
        .eq('slug', this.cfg.restaurantSlug || 'sulthans').maybeSingle();
      if (error) throw error;
      if (!rest) throw new Error('no restaurant row for slug "' + (this.cfg.restaurantSlug || 'sulthans') + '" — run supabase/seed.sql');
      this.rid = rest.id;
      const { data: sess } = await this.sb.auth.getSession();
      this.staff = !!(sess && sess.session);
      await this.hydrate();
      this.listen();
      return this;
    }

    /* A cleared row id is quarantined, not just hidden. Hiding is local; the
       row stays open on the server whenever the close write is refused, and the
       next round for that table would then be appended to it — which is how a
       cleared ticket came back carrying its old items and its old opened_at.
       Quarantine outlives the hide: a quarantined id is never read as a ticket
       and never reused for new items, and it is released only when the server
       stops reporting it open. */
    idsLoad() {
      try {
        const m = JSON.parse(localStorage.getItem(DEAD_KEY) || '{}');
        // No age cutoff: a quarantined row is released when the server reports it
        // closed and not before. Expiring one that is still open would put its
        // items back on the table's ticket, which is the whole bug.
        Object.keys(m).forEach(k => {
          const e = m[k];
          if (!e || !Array.isArray(e.ids) || !e.ids.length) delete m[k];
        });
        return m;
      } catch (e) { return {}; }
    }
    idsSave() {
      try { localStorage.setItem(DEAD_KEY, JSON.stringify(this.dead)); } catch (e) {}
    }
    deadIds(label) {
      const e = this.dead[label];
      return (e && e.ids) || [];
    }
    markDead(label, ids) {
      if (!ids || !ids.length) return;
      const had = this.deadIds(label);
      this.dead[label] = { ids: [...new Set([...had, ...ids])], at: Date.now() };
      this.idsSave();
    }
    // Called with the ids the server still reports open. Anything else the
    // quarantine was holding is genuinely closed, so it stops being carried.
    releaseDead(openNow) {
      let touched = false;
      Object.keys(this.dead).forEach(label => {
        const rest = this.deadIds(label).filter(id => openNow.has(id));
        if (rest.length === this.deadIds(label).length) return;
        touched = true;
        if (rest.length) this.dead[label] = { ids: rest, at: this.dead[label].at };
        else delete this.dead[label];
      });
      if (touched) this.idsSave();
    }
    // The open rows under a label, right now. Snapshotting the ids is what keeps
    // a later insert out of a close that was decided earlier.
    async openIds(label) {
      const { data } = await this.sb.from('orders').select('id')
        .eq('restaurant_id', this.rid).eq('table_label', label).eq('status', 'open');
      return (data || []).map(r => r.id);
    }
    /* An UPDATE the policy refuses is not an error: Postgres reports success
       and zero rows changed. Now that closing requires a staff session, an
       expired one would therefore look exactly like a clean close, and the
       ticket would sit open on the server while the board showed it gone. So
       the rows come back with .select() and a zero count is treated as a
       refusal: sign in again and try once more. */
    async closeIds(ids, retried) {
      if (!ids || !ids.length) return null;
      const { data, error } = await this.sb.from('orders')
        .update({ status: 'closed', closed_at: new Date().toISOString() })
        .in('id', ids).select('id');
      if (error) return error;
      if ((data || []).length) return null;

      // Nothing matched. Either the rows were already closed by another device,
      // or this session has lapsed. Ask the server which.
      const { data: live } = await this.sb.from('orders')
        .select('id').in('id', ids).eq('status', 'open');
      if (!live || !live.length) return null;    // already closed elsewhere

      if (!retried && this.reauth) {
        const ok = await this.reauth().catch(() => false);
        if (ok) return this.closeIds(ids, true);
      }
      return { message: 'Signed out \u2014 clearing a table needs a staff session.' };
    }

    goneLoad() {
      try {
        const m = JSON.parse(localStorage.getItem('sul.cleared.v1') || '{}');
        const cutoff = Date.now() - 3 * 3600e3;    // one sitting; a mark older than that has no visit left to hide
        Object.keys(m).forEach(k => { if (!(Number(m[k]) > cutoff)) delete m[k]; });
        return m;
      } catch (e) { return {}; }
    }
    goneSave() {
      if (this.db.clearedSave) return this.db.clearedSave();
      try { localStorage.setItem('sul.cleared.v1', JSON.stringify(this.gone)); } catch (e) {}
    }

    /* Readiness columns are additive, so the client treats them as optional and
       finds out from the server which shape it is talking to. */
    orderCols() {
      const base = 'id,table_label,opened_at,device_id,hold_at,paid_amount,claim_at,claim_total';
      const tail = ',order_items(dish_id,qty,unit_price)';
      return base + (this.ready$ === false ? '' : ',ready_at,served_at') + tail;
    }

    /* ---------- read: server -> db.state ---------- */
    async hydrate() {
      const sb = this.sb, rid = this.rid;
      const fbCols = this.staff ? 'dish_id,stars,comment,created_at' : 'dish_id,stars,created_at';
      const svcCols = this.staff ? 'stars,comment,created_at,table_label' : 'stars,created_at,table_label';
      // guest_mobile is revoked from anon, so asking for it while signed out
      // fails the whole select rather than returning null.
      const slotCols = 'id,num,kind,bill,guest_name,device_id,hold_at,staff_made,created_at'
        + (this.staff ? ',guest_mobile' : '');
      const [cats, dishes, orders, calls, ratings, fb, svc, room, slots] = await Promise.all([
        sb.from('categories').select('id,key,hidden').eq('restaurant_id', rid),
        sb.from('dishes').select('id,slug,price,prep_minutes,available,hidden,hls_url,poster_url').eq('restaurant_id', rid),
        sb.from('orders').select(this.orderCols()).eq('restaurant_id', rid).eq('status', 'open'),
        sb.from('waiter_calls').select('id,table_label,called_at').eq('restaurant_id', rid).is('attended_at', null),
        sb.from('dish_ratings').select('dish_id,avg_stars,votes'),
        sb.from('dish_feedback').select(fbCols).order('created_at', { ascending: false }).limit(500),
        sb.from('service_feedback').select(svcCols).eq('restaurant_id', rid).order('created_at', { ascending: false }).limit(300),
        sb.from('restaurants').select('table_count').eq('id', rid).maybeSingle(),
        sb.from('floor_slots').select(slotCols).eq('restaurant_id', rid).order('created_at'),
      ]);

      const next = { dishes: {}, cats: {}, orders: {}, waiter: [], feedback: [], service: [], ratings: {} };

      (cats.data || []).forEach(c => {
        this.catId[c.key] = c.id;
        if (c.hidden) next.cats[c.key] = { hidden: true };
      });
      (dishes.data || []).forEach(d => {
        this.dishId[d.slug] = d.id; this.dishSlug[d.id] = d.slug;
        const o = {};
        if (d.price != null) o.price = Number(d.price);
        if (d.prep_minutes != null) o.mins = d.prep_minutes;
        if (d.available === false) o.avail = false;
        if (d.hidden) o.hidden = true;
        if (Object.keys(o).length) next.dishes[d.slug] = o;
        if (d.hls_url) {
          this.media = this.media || {};
          this.media[d.slug] = { hls: d.hls_url, poster: d.poster_url || null };
        }
      });
      const dupes = [], stuck = [], dupeOf = [];
      // Newest first, so the row kept for a label is the current visit and the
      // stale ones behind it are the ones closed.
      const rows = (orders.data || []).slice()
        .sort((a, b) => (Date.parse(b.opened_at) || Date.now()) - (Date.parse(a.opened_at) || Date.now()));
      const openBy = {};
      const localOrders = (this.db && this.db.state && this.db.state.orders) || {};
      rows.forEach(o => {
        // Recorded before any skip, so a clear can quarantine the leftovers a
        // table collected as well as the row that is currently winning.
        (openBy[o.table_label] = openBy[o.table_label] || []).push(o.id);
        // A quarantined row is not a ticket, whatever else is true of it.
        if (this.deadIds(o.table_label).indexOf(o.id) >= 0) { stuck.push(o.id); return; }
        // A row that is not quarantined is whoever is sitting there now, so the
        // label's hide is spent and lifts — the new ticket shows immediately.
        if (this.gone[o.table_label]) this.dropGone(o.table_label);
        // Two open rows under one label cannot both be the ticket. The newest is
        // the visit; anything older is a leftover from a clear that did not land,
        // and it is closed rather than left to shadow the real one.
        if (next.orders[o.table_label]) { dupes.push(o.id); dupeOf.push([o.table_label, o.id]); return; }
        /* Which portions have gone out is per-line state the server has no column
           for, so a read rebuilt every ticket as fully pending and the floor
           display put a served ticket straight back in the queue a second later.
           served_at is the fact the server does keep: a stamped ticket left the
           kitchen whole. Anything short of that is carried over from this
           device's own state, matched on the visit so a cleared label cannot
           inherit the last one's marks. */
        const prev = localOrders[o.table_label];
        const servedAt = ms(o.served_at) || null;
        /* Matched on the row id this client is tracking, not on a timestamp: a
           locally placed order carries at = Date.now() while the server row
           carries its own opened_at, so a time comparison was false for exactly
           the tickets that needed carrying over. */
        const sameVisit = !!prev && this.orderId[o.table_label] === o.id;
        this.orderId[o.table_label] = o.id;
        next.orders[o.table_label] = {
          at: ms(o.opened_at),
          // The hold travels with the ticket, so the two-hour table lock is the
          // same fact on every phone in the room and survives a reload.
          dev: o.device_id || null,
          holdAt: ms(o.hold_at) || ms(o.opened_at),
          paidAmt: Number(o.paid_amount) || 0,
          // The guest's own "I've paid" travels with the ticket: without it the
          // counter's device could not see a claim the guest made on theirs, and
          // a reload asked the guest for money they had already sent.
          claimAt: ms(o.claim_at) || null,
          claimTot: o.claim_total == null ? null : Number(o.claim_total),
          // The counter's press, on every phone. Without this the guest kept
          // counting down a bag that was already packed, because "ready" lived
          // only in the local state of the device that pressed it.
          ready: !!o.ready_at,
          served: ms(o.served_at) || null,
          unassigned: /^U/.test(o.table_label),
          items: (o.order_items || []).map(i => {
            const slug = this.dishSlug[i.dish_id] || i.dish_id;
            const line = { id: slug, qty: i.qty, price: Number(i.unit_price) };
            const was = sameVisit ? (prev.items || []).find(x => x.id === slug) : null;
            const sent = servedAt ? i.qty : Math.min(i.qty, (was && was.sent) || 0);
            if (sent) {
              line.sent = sent;
              // Per-portion times are local; a ticket read back as served has only
              // the one stamp to go on, so the missing portions borrow it.
              const log = (was && was.sentLog) || [];
              line.sentLog = log.length >= sent ? log.slice(0, sent)
                : log.concat(Array.from({ length: sent - log.length }, () => servedAt || Date.now()));
            }
            return line;
          }),
        };
      });
      (calls.data || []).forEach(c => {
        const at = ms(c.called_at);
        this.callId[at] = c.id;
        next.waiter.push({ table: c.table_label, at });
      });
      (ratings.data || []).forEach(r => {
        const slug = this.dishSlug[r.dish_id];
        if (slug) next.ratings[slug] = { count: Number(r.votes), sum: Number(r.avg_stars) * Number(r.votes) };
      });
      (fb.data || []).forEach(f => next.feedback.push({
        dishId: this.dishSlug[f.dish_id] || f.dish_id, stars: f.stars,
        text: f.comment || '', at: ms(f.created_at),
      }));
      (svc.data || []).forEach(s => next.service.push({
        stars: s.stars, text: s.comment || '', at: ms(s.created_at), table: s.table_label,
      }));

      /* The room: how many numbered tables the floor has, and the walk-in slots
         beside them. Both were local-only, so the count staff raised on one phone
         and the name a parcel guest typed on theirs reached nobody. holdMins has
         no column yet, so the rest of floor is carried forward rather than wiped
         by the merge. */
      if (room.data && room.data.table_count != null) {
        next.floor = Object.assign({}, (this.db.state || {}).floor, { tables: room.data.table_count });
      }
      if (!slots.error) {
        next.uslots = (slots.data || []).map(r => ({
          id: r.id, num: r.num == null ? null : r.num, kind: r.kind || null,
          bill: r.bill || null, name: r.guest_name || null,
          mobile: r.guest_mobile || null, dev: r.device_id || null,
          holdAt: ms(r.hold_at) || null, staff: !!r.staff_made, at: ms(r.created_at),
        }));
        /* A slot this device just created may not be on the server yet — the
           insert and the realtime echo race each other. Without this the guest's
           own parcel key vanished from under them for a beat. */
        const seen = new Set(next.uslots.map(x => x.id));
        ((this.db.state || {}).uslots || []).forEach(x => {
          if (!seen.has(x.id) && Date.now() - (x.at || 0) < 15000) next.uslots.push(x);
        });
      }

      // Feedback rows are ordered newest-first for the cap; the app expects oldest-first.
      next.feedback.reverse(); next.service.reverse();
      const errs = [cats, dishes, orders, calls, ratings, fb, svc, room, slots].map(r => r.error).filter(Boolean);
      if (errs.length) console.warn('[supabase] partial read:', errs.map(e => e.message).join(' | '));
      // A missing readiness column is a migration that has not been run yet, not
      // a broken app: drop back to the columns that do exist and read again, so
      // orders keep flowing while ready-sync waits for security.sql.
      if (orders.error && this.ready$ !== false && /ready_at|served_at/.test(orders.error.message || '')) {
        this.ready$ = false;
        console.warn('[supabase] orders.ready_at missing — run supabase/security.sql to enable bag-ready sync');
        return this.hydrate();
      }
      // Rows the server no longer reports open have nothing left to hide behind.
      if (!orders.error) {
        this.okAt = Date.now();
        this.lastOpen = openBy;
        const openNow = new Set((orders.data || []).map(r => r.id));
        this.releaseDead(openNow);
        /* A cached row that is no longer open belongs to a visit somebody else
           ended. Dropped, so the next round finds or opens a real ticket instead
           of writing into the closed one. */
        Object.keys(this.orderId).forEach(label => {
          if (!openNow.has(this.orderId[label])) delete this.orderId[label];
        });
      }
      if (dupes.length) {
        // Quarantined as well as closed: if the close is refused, these must not
        // come back as tickets on the next read.
        dupeOf.forEach(([label, id]) => this.markDead(label, [id]));
        this.sb.from('orders').update({ status: 'closed', closed_at: new Date().toISOString() })
          .in('id', dupes).then(() => {}, () => {});
      }
      // Cleared here but still open there: finish the job rather than letting the
      // ticket sit invisible on one device and live on every other.
      const retry = [...new Set(stuck)].filter(id => !(this.closing[id] && Date.now() - this.closing[id] < 4000));
      retry.forEach(id => { this.closing[id] = Date.now(); });
      if (retry.length) {
        this.closeIds(retry).then(err => {
          if (err) {
            this.fail(err.message, 'sweep');
            console.warn('[supabase] a cleared ticket will not close — run supabase/security.sql:', err.message);
          } else this.ok('sweep');   // the sweep caught up: withdraw the warning it raised
        }, () => {});
      }
      this.db.adopt(next);
      return this.media || {};
    }

    /* Coalesced: a reconnect fires the browser's online event and the channel
       rejoin within a second of each other, and both want the same read. */
    resync() {
      clearTimeout(this.rt);
      this.rt = setTimeout(() => {
        this.hydrate()
          .then(() => { this.onLive && this.onLive(); })
          .catch(e => console.warn('[supabase] resync failed', e.message));
      }, 120);
    }

    online() {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
      if (!this.okAt) return false;
      return this.chState === 'SUBSCRIBED' || Date.now() - this.okAt < 30000;
    }

    /* ---------- realtime ---------- */
    listen() {
      const bump = (fast) => {
        clearTimeout(this.t);
        this.t = setTimeout(() => this.hydrate().catch(e => console.warn('[supabase] refresh failed', e.message)), fast ? 40 : 250);
      };
      this.ch = this.sb.channel('sulthans-service');
      ['dishes', 'categories', 'orders', 'order_items', 'waiter_calls', 'dish_feedback', 'service_feedback',
       'restaurants', 'floor_slots']
        .forEach(table => this.ch.on('postgres_changes', { event: '*', schema: 'public', table },
          p => bump(table === 'orders' && !!(p && p.new && p.new.ready_at))));
      /* The subscribe status is the connection: SUBSCRIBED means the socket is
         up and this device is being told about changes. Reported outward so the
         panel's live dot is showing the truth rather than navigator.onLine,
         which stays true on a wifi with no route out. */
      this.ch.subscribe(st => {
        const was = this.chState;
        this.chState = st;
        /* A rejoin is not a resume: postgres_changes delivers nothing that
           happened while the socket was down, so every order, call and parcel
           from that window would stay invisible until a manual reload. The
           socket coming back is the cue to re-read the floor. */
        if (st === 'SUBSCRIBED' && was && was !== 'SUBSCRIBED') this.resync();
        this.onLive && this.onLive();
      });
    }

    /* ---------- write: diff db.state before/after a patch ---------- */
    sync(before, after) {
      const jobs = [];
      const keys = o => Object.keys(o || {});

      new Set([...keys(before.dishes), ...keys(after.dishes)]).forEach(slug => {
        const a = before.dishes[slug] || {}, b = after.dishes[slug] || {}, p = {};
        if (a.price !== b.price && b.price != null) p.price = b.price;
        if (a.mins !== b.mins && b.mins != null) p.prep_minutes = b.mins;
        if (a.avail !== b.avail) p.available = b.avail !== false;
        if (a.hidden !== b.hidden) p.hidden = !!b.hidden;
        if (Object.keys(p).length) jobs.push(() => this.upd('dishes', this.dishId[slug], p));
      });

      new Set([...keys(before.cats), ...keys(after.cats)]).forEach(key => {
        const a = before.cats[key] || {}, b = after.cats[key] || {};
        if (a.hidden !== b.hidden) jobs.push(() => this.upd('categories', this.catId[key], { hidden: !!b.hidden }));
      });

      const bO = keys(before.orders), aO = keys(after.orders);
      /* The items are copied here, at diff time, not read when the job runs.
         `after` IS the live state object, and a round arrives as two patches in
         one tick: the slot claim creates the ticket (no items yet), the send
         appends the lines. The first patch queued this job and the second one
         filled the very array it was about to read — so openOrder inserted the
         whole round, and the second patch's own delta job inserted it again.
         That is the parcel showing every dish twice at double the money. A
         snapshot of what existed when the ticket appeared keeps each line the
         business of exactly one job. */
      aO.filter(k => bO.indexOf(k) < 0).forEach(k => {
        const o = after.orders[k] || {};
        const frozen = { ...o, items: (o.items || []).map(l => ({ ...l })) };
        jobs.push(() => this.openOrder(k, frozen));
      });
      /* Quarantine on the spot, in the same tick as the patch. closeOrder runs
         behind the write queue and behind at least one await, and a realtime
         refresh triggered by anything else — a waiter call being attended, a
         second device ordering — can land in that gap. Until this ran there, a
         cleared row was not yet quarantined, so the read took it for the live
         ticket, lifted the label's hide and put the old items back on the board
         carrying their original opened_at. Marking here closes that window: by
         the time any read can happen, the rows are already not tickets. */
      bO.filter(k => aO.indexOf(k) < 0).forEach(k => {
        this.markDead(k, [this.orderId[k], ...(this.lastOpen[k] || [])].filter(Boolean));
        jobs.push(() => this.closeOrder(k));
      });
      aO.filter(k => bO.indexOf(k) >= 0).forEach(k => {
        const was = qtyOf(before.orders[k].items), now = after.orders[k].items || [];
        const added = [];
        Object.entries(qtyOf(now)).forEach(([id, qty]) => {
          const delta = qty - (was[id] || 0);
          if (delta > 0) {
            const line = now.find(i => i.id === id) || {};
            added.push({ id, qty: delta, price: line.price });
          }
        });
        if (added.length) jobs.push(() => this.addItems(k, added));
        // Settlement is mirrored so the amount lives in Postgres, where the
        // trigger stamps paid_at and paid_by and refuses a write that no staff
        // session made. A guest's attempt fails here and the row stays honest.
        const pa = Number(after.orders[k].paidAmt) || 0;
        if (pa !== (Number(before.orders[k].paidAmt) || 0)) {
          jobs.push(async () => this.upd('orders', this.orderId[k] || await this.orderFor(k), { paid_amount: pa }));
        }
        // A claim is the guest's word, so anon may write it — the trigger freezes
        // paid_amount, not this. Mirrored as an absolute total claimed against,
        // which makes the write idempotent: a retry cannot inflate it.
        // Ready and served are stamped, not counted, so writing them twice is
        // harmless — and a bag un-marked at the counter clears them again.
        const ra = !!after.orders[k].ready, rb = !!before.orders[k].ready;
        const sa = after.orders[k].served || null, sb2 = before.orders[k].served || null;
        if ((ra !== rb || sa !== sb2) && this.ready$ !== false) {
          /* served_at used to ride along as `sa ? stamp : null` on every ready
             change, so any read-back that dropped local served while ready stayed
             true wiped a stamp the counter had already made — silently, because
             nulling a column is a legal write, not a refusal. No press produces
             that state: un-marking a bag clears the ticket outright, and a second
             round clears ready and served together. So served only ever clears
             when ready does. */
          const stamp = { ready_at: ra ? new Date().toISOString() : null };
          if (sa) stamp.served_at = new Date(sa).toISOString();
          else if (!ra) stamp.served_at = null;
          jobs.push(async () => this.upd('orders', this.orderId[k] || await this.orderFor(k), stamp));
        }
        const ca = after.orders[k].claimAt || null, cb = before.orders[k].claimAt || null;
        const ct = after.orders[k].claimTot, cs = before.orders[k].claimTot;
        if (ca !== cb || ct !== cs) {
          jobs.push(async () => this.upd('orders', this.orderId[k] || await this.orderFor(k), {
            claim_at: ca ? new Date(ca).toISOString() : null,
            claim_total: ca && ct != null ? ct : null,
          }));
        }
      });

      /* The room, mirrored the same way as everything else: a diff of the local
         collections. The server refuses a guest's attempt (restaurants_staff_update
         is authenticated-only), so the count can only move from a signed-in phone. */
      const tb = (before.floor || {}).tables, ta = (after.floor || {}).tables;
      if (ta != null && ta !== tb) jobs.push(() => this.upd('restaurants', this.rid, { table_count: ta }));

      const bSlot = {}, aSlot = {};
      // Local slot key -> column, so a diff of the local keys can name its own patch.
      const SLOT_COL = {
        num: 'num', kind: 'kind', bill: 'bill', name: 'guest_name',
        dev: 'device_id', holdAt: 'hold_at', mobile: 'guest_mobile',
      };
      (before.uslots || []).forEach(x => { bSlot[x.id] = x; });
      (after.uslots || []).forEach(x => { aSlot[x.id] = x; });
      Object.keys(aSlot).forEach(id => {
        const b = bSlot[id], a = aSlot[id];
        const row = {
          num: a.num == null ? null : a.num, kind: a.kind || null, bill: a.bill || null,
          guest_name: a.name || null,
          device_id: a.dev || null, hold_at: a.holdAt ? new Date(a.holdAt).toISOString() : null,
        };
        /* A signed-out phone cannot READ guest_mobile (no column grant), so its
           local copy of someone's number is null whether or not one was given.
           Sending that null back would wipe the number the guest typed the moment
           their second round renewed the hold — the counter would watch a parcel
           go anonymous mid-visit. So null means "unknown, leave it alone", and a
           release says what it means with '' instead: an explicit clear, written
           as null, so the next customer does not inherit the last one's number. */
        const canWriteMobile = this.staff || a.mobile != null;
        if (canWriteMobile) row.guest_mobile = a.mobile || null;
        const keys = ['num', 'kind', 'bill', 'name', 'dev', 'holdAt'];
        if (canWriteMobile) keys.push('mobile');
        /* staff_made was written only on the branch below that first creates the
           slot, so staff taking over a row that already existed left the flag
           false — and the guard reads it to decide whether a guest phone may
           delete the slot at all, which made a staff-held slot guest-deletable.
           Only a signed-in device may send it: the guard refuses it from anon. */
        if (this.staff) { row.staff_made = !!a.staff; keys.push('staff'); }
        if (!b) {
          /* Upsert, not insert: two devices can reach for the same parcel key at
             once, and a slot that arrived by hydrate between the snapshot and the
             write would otherwise collide on (restaurant_id, id) and throw. */
          jobs.push(() => this.upsertSlot(Object.assign({
            id, restaurant_id: this.rid, staff_made: !!a.staff,
          }, row)));
        } else {
          /* Only the keys that moved. The whole row went with every change, so one
             edited field re-sent five stale ones: the counter typing a bill number
             while another staff phone renewed the hold had it overwritten by that
             phone's last-hydrated value. The trigger cannot catch this one — staff
             are not gated by it — so the client has to stop sending columns it was
             not asked to change. A release still moves every key at once, which is
             what the guard's release arm needs to see. */
          const moved = keys.filter(k => a[k] !== b[k]);
          if (moved.length) {
            const patch = {};
            moved.forEach(k => { patch[SLOT_COL[k]] = row[SLOT_COL[k]]; });
            jobs.push(() => this.updSlot(id, patch));
          }
        }
      });
      Object.keys(bSlot).filter(id => !aSlot[id]).forEach(id => jobs.push(() => this.delSlot(id)));

      after.waiter.slice(before.waiter.length).forEach(w => jobs.push(() => this.call(w)));
      before.waiter.filter(w => !after.waiter.some(x => x.at === w.at))
        .forEach(w => jobs.push(() => this.upd('waiter_calls', this.callId[w.at], { attended_at: new Date().toISOString() })));

      after.feedback.slice(before.feedback.length).forEach(f => jobs.push(() => this.ins('dish_feedback', {
        dish_id: this.dishId[f.dishId], stars: f.stars, comment: f.text || null,
      })));
      after.service.slice(before.service.length).forEach(s => jobs.push(() => this.ins('service_feedback', {
        restaurant_id: this.rid, stars: s.stars, comment: s.text || null, table_label: s.table || null,
      })));

      if (jobs.length) this.run(jobs);
    }

    /* Slots are keyed by (restaurant_id, id), so they need their own pair rather
       than upd/ins' single-id shape. A refused slot write is reported like a
       refused close: it silently costs the guest their name, mobile and hold at
       the next hydrate, which is exactly the failure this app keeps hitting. */
    async upsertSlot(row) {
      const { error } = await this.sb.from('floor_slots')
        .upsert(row, { onConflict: 'restaurant_id,id' });
      if (error) throw this.slotErr(error);
    }

    /* floor-slot-guard.sql refuses a bill number or a staff flag written without a
       staff session, by name. That message is for a developer; the counter needs
       to know which press did not take and what fixes it. */
    slotErr(error) {
      const msg = (error && (error.message || error) + '') || '';
      if (/only staff may set/.test(msg)) {
        const what = /bill/.test(msg) ? 'The bill number' : 'That table';
        return new Error('Signed out \u2014 ' + what + ' needs a staff session.');
      }
      return error instanceof Error ? error : new Error(msg);
    }
    /* Read back, then re-authenticate once and retry — the same path closeIds,
       delSlot and upd already take. This was the one write that skipped it: a
       single refusal was terminal, so a bill number typed against a lapsed
       session was lost even though the session came back a moment later. */
    async updSlot(id, patch, retried) {
      const { data, error } = await this.sb.from('floor_slots').update(patch)
        .eq('restaurant_id', this.rid).eq('id', id).select('id');
      if (error) throw this.slotErr(error);
      if (!(data || []).length) {
        /* Refused, not missing: the row is there and the server would not let
           this device change it. Silent here is how a lost parcel name looks
           like a sync bug, so it reaches the panel the same way a refused close
           does. */
        const { data: live } = await this.sb.from('floor_slots').select('id')
          .eq('restaurant_id', this.rid).eq('id', id);
        if (!live || !live.length) return;   // released elsewhere, nothing to report

        if (!retried && this.reauth && await this.reauth().catch(() => false)) {
          return this.updSlot(id, patch, true);
        }
        console.warn('[supabase] slot ' + id + ' not ours to change');
        /* The message for the counter rides on the error rather than being raised
           here: reporting it here and then throwing meant the batch catch called
           fail() a second time with the thrown text, and the toast the counter
           actually read was 'refused: slot Umtpjljiwnx5 is not ours to change'. */
        throw this.refusal('refused: slot ' + id + ' is not ours to change', this.slotRefusedMsg(patch));
      }
    }

    /* The slot id is a generated string and it was going out to the floor display
       verbatim. Name the press instead, the way refusedMsg does for orders. */
    slotRefusedMsg(patch) {
      const cols = Object.keys(patch || {});
      if (cols.some(c => /bill/.test(c))) return 'Signed out \u2014 the bill number was not saved.';
      if (cols.some(c => /paid|settle/.test(c))) return 'Signed out \u2014 that payment was not saved.';
      return 'Signed out \u2014 that parcel was not saved.';
    }
    /* The last write that still read a refusal as success. A DELETE the policy
       refuses returns no error and no rows — indistinguishable from a delete that
       found nothing — so a signed-out phone releasing a table it does not own
       looked like a clean release, and the slot came back at the next hydrate
       with nothing said. Anon may only release its own guest-made slots
       (slots_guest_release), which is exactly the case staff hit.

       So: read the rows back, and on none, ask the server whether the row is
       still there. Gone means someone else released it and there is nothing to
       report; still there means refused, which is worth one silent re-auth and
       then a banner. */
    async delSlot(id, retried) {
      const { data, error } = await this.sb.from('floor_slots').delete()
        .eq('restaurant_id', this.rid).eq('id', id).select('id');
      if (error) throw this.slotErr(error);
      if ((data || []).length) return;

      const { data: live } = await this.sb.from('floor_slots').select('id')
        .eq('restaurant_id', this.rid).eq('id', id);
      if (!live || !live.length) return;

      if (!retried && this.reauth && await this.reauth().catch(() => false)) {
        return this.delSlot(id, true);
      }
      console.warn('[supabase] slot ' + id + ' not ours to release');
      throw this.refusal('refused: slot ' + id + ' is not ours to release', 'Signed out \u2014 that table was not released.');
    }

    /* One refusal, two readers: `message` for the console and the replay log,
       `staffMsg` for the person at the counter. */
    refusal(logMsg, staffMsg) {
      const e = new Error(logMsg);
      e.staffMsg = staffMsg;
      return e;
    }

    /* Every refusal goes through here. A batch used to decide it had succeeded
       from the absence of a thrown error, but closeOrder swallows its refusal on
       purpose (so the tombstone stands and hydrate retries) and updSlot's zero-row
       refusal never throws either — so the all-clear wiped the very banner those
       two had just raised. The flag outlives the batch that set it and is only
       reset when a new one starts. */
    /* Refusals come from four places that run concurrently: a sync batch, the
       hydrate retry sweep, closeOrder, and a fresh sign-in. A single flag let any
       one of them call the all-clear on a refusal another had just raised — the
       sweep finishing a stale close would wipe the banner for a serve that had
       genuinely failed a moment earlier. Each source withdraws only its own, and
       the banner stands while any is outstanding. */
    fail(msg, key) {
      (this._failed || (this._failed = new Set())).add(key || 'batch');
      /* Kept so the panel can ask later. Signing back in used to clear the banner
         unconditionally, which meant a refusal raised while the counter was on
         another screen was gone before it could be read — and the only evidence
         it ever happened was in a console nobody on the floor can open. */
      this._lastFail = msg || '';
      this._failCount = (this._failCount || 0) + 1;
      this.onCloseFail && this.onCloseFail(msg);
    }

    /* What is still outstanding, for the panel and for the dev line. */
    refusals() {
      return {
        open: (this._failed && this._failed.size) || 0,
        seen: this._failCount || 0,
        last: this._lastFail || '',
        queued: (this._refused && this._refused.length) || 0,
      };
    }

    ok(key) {
      const set = this._failed || (this._failed = new Set());
      set.delete(key || 'batch');
      if (!set.size) this.onCloseOk && this.onCloseOk();
    }

    run(jobs) {
      this.queue = this.queue.then(async () => {
        /* One verdict per batch, not per job. sync() sends a slot release, a slot
           claim and the order inserts together; clearing the latch after each
           success meant a refusal in job N was erased by job N+1 before any
           banner could render it — the same reported-as-success shape as the
           original stamp bug. */
        let failed = false;
        for (const job of jobs) {
          try {
            await job();
          } catch (e) {
            const msg = e && (e.message || e) + '';
            /* This latch stops the pass stamping for the rest of the session, so it
               may only fire for the one thing it was built for: a database without
               the columns. It used to fire on any message naming them — including a
               refusal — so one blocked serve quietly turned off every serve after
               it, and the floor display went back to reverting tickets with nothing
               in the console the second time. */
            if (/ready_at|served_at/.test(msg) && /does not exist|schema cache|PGRST204|could not find/i.test(msg)) {
              this.ready$ = false;
              console.warn('[supabase] no ready_at/served_at columns — run supabase/serve-stamp.sql');
            }
            /* A refusal means the app and the database now disagree, and the next
               hydrate resolves that against the guest — so it has to be visible.
               A dropped connection is not that: it retries on its own, and
               latching a permanent banner over a passing blip only teaches staff
               to ignore the banner. The column-shape latch above is separate: a
               setup fault that says what to run. */
            const transport = /failed to fetch|networkerror|load failed|timeout|aborted/i.test(msg);
            // A blip must not latch a banner — nor declare all-clear over one
            // already up, so it counts as a failure for the verdict either way.
            failed = true;
            if (transport) {
              console.warn('[supabase] write failed, will retry:', msg);
            } else {
              /* Keyed apart from 'batch' on purpose. A refusal used to latch under
                 the batch key, so the very next ordinary write called ok('batch'),
                 emptied the set and withdrew the banner — usually within a second,
                 because a hydrate follows every patch. The counter saw the value
                 revert with nothing on screen saying why. A refusal outlives other
                 traffic and only clears on a fresh staff sign-in, which is the one
                 thing that actually resolves it. */
              this.fail((e && e.staffMsg) || msg, 'refused');
              /* Held for replay. The local copy of a refused write is erased by the
                 next hydrate and the server never took it, so signing in afterwards
                 had nothing left to re-send: the counter typed a bill number, saw it
                 revert, signed in, and the number was simply gone. Keeping the job
                 means the sign-in that fixes the session also finishes the write.
                 Bounded, because a database misconfigured against this app would
                 otherwise pile up every refusal of the shift. */
              const q = (this._refused || (this._refused = []));
              if (q.length < 20) q.push({ job, msg });
              console.warn('[supabase] the server refused this write:', msg);
            }
          }
        }
        if (!failed) this.ok('batch');
      });
    }

    /* An UPDATE the policy refuses reports success with zero rows changed — the
       same silent shape that made a lapsed session look like a clean close. So
       every update reads its rows back, and a zero-row result is a refusal: sign
       in again and try once. The serve press is the one that mattered, because a
       served_at that never landed puts the ticket back in the pending queue on
       the next read — which is what the floor display kept doing. */
    async upd(table, id, patch, retried) {
      if (!id) return;
      const { data, error } = await this.sb.from(table).update(patch).eq('id', id).select('id');
      if (error) throw error;
      if ((data || []).length) return;
      // The row may simply be gone (cleared elsewhere) rather than protected.
      const { data: live } = await this.sb.from(table).select('id').eq('id', id);
      if (!live || !live.length) return;
      if (!retried && this.reauth && await this.reauth().catch(() => false)) {
        return this.upd(table, id, patch, true);
      }
      throw this.refusal('refused: no staff session for ' + table + ' update', this.refusedMsg(table, patch));
    }
    /* Named by what the press was, not by the table it landed in: "orders did not
       save" reads as a clearing problem and sends staff to the wrong screen. */
    refusedMsg(table, patch) {
      const cols = Object.keys(patch || {});
      /* Not phrased as a sign-out, because attending is the one write a signed-in
         session used to be the thing that BROKE (no authenticated policy on
         waiter_calls). Signing in again cannot fix it, so it does not offer to. */
      if (cols.indexOf('attended_at') >= 0) {
        return 'The bell did not clear on the server \u2014 it may ring again.';
      }
      /* ready_at and served_at travel in one patch, so the columns alone do not
         say which press it was. The values do: a ready stamp with nothing served
         is the bag press, and calling that one "the serve" sent staff to the
         wrong screen looking for a ticket that was never marked out. */
      if (cols.some(c => c === 'served_at' || c === 'ready_at')) {
        return patch.ready_at && !patch.served_at
          ? 'Signed out \u2014 bag ready did not save. Sign in to mark bags ready.'
          : 'Signed out \u2014 the serve did not save. Sign in to mark food out.';
      }
      if (cols.indexOf('paid_amount') >= 0) {
        return 'Signed out \u2014 the payment did not save. Sign in to settle.';
      }
      return 'Signed out \u2014 a change to ' + table + ' did not save.';
    }
    async ins(table, row) {
      const { error } = await this.sb.from(table).insert(row);
      if (error) throw error;
    }
    async call(w) {
      const { data, error } = await this.sb.from('waiter_calls')
        .insert({ restaurant_id: this.rid, table_label: String(w.table || '') }).select('id').single();
      if (error) throw error;
      this.callId[w.at] = data.id;
    }
    async orderFor(label, order) {
      const dead = this.deadIds(label);
      const cached = this.orderId[label];
      if (cached && dead.indexOf(cached) < 0) {
        const { data: still, error } = await this.sb.from('orders')
          .select('id').eq('id', cached).eq('status', 'open').limit(1);
        // A failed check is not proof of a closed row; keep the cache and let
        // the write take its chances rather than opening a duplicate ticket.
        if (error || (still && still.length)) return cached;
      }
      delete this.orderId[label];
      const { data: open } = await this.sb.from('orders').select('id')
        .eq('restaurant_id', this.rid).eq('table_label', label).eq('status', 'open')
        .order('opened_at', { ascending: false }).limit(20);
      // Skipping the quarantined rows is what forces a fresh ticket after a
      // clear, instead of this round landing inside the one that was cleared.
      const live = (open || []).map(r => r.id).filter(id => dead.indexOf(id) < 0);
      if (live[0]) { this.orderId[label] = live[0]; return live[0]; }
      const { data, error } = await this.sb.from('orders')
        .insert({
          restaurant_id: this.rid, table_label: label,
          // Who opened it. security.sql lets a guest append only where this
          // matches the x-device-id header their own requests carry.
          device_id: (order && order.dev) || deviceId(),
          hold_at: new Date((order && order.holdAt) || Date.now()).toISOString(),
        }).select('id').single();
      if (error) throw error;
      this.orderId[label] = data.id;
      return data.id;
    }
    async openOrder(label, order) {
      if (this.gone[label] || this.deadIds(label).length) {
        // Runs a moment before a fresh row for this table is inserted. Quarantine
        // first, close second: if the close is refused the ids still cannot be
        // reused, so the new round gets its own ticket either way.
        /* Both sets, never one or the other. Picking the quarantine alone left
           any row that arrived after the clear — or that the clear's own read
           missed — open under this label, and the round being placed now would
           be appended to it. */
        const ids = [...new Set([...this.deadIds(label), ...(this.lastOpen[label] || []), ...await this.openIds(label)])];
        this.markDead(label, ids);
        delete this.lastOpen[label];
        delete this.orderId[label];
        const err = await this.closeIds(ids);
        // The hide lifts here regardless: the guest is ordering again, so the
        // label has to be visible. What keeps the cleared items off the ticket
        // is the quarantine, which stands until the server confirms the close.
        this.dropGone(label);
        this.goneSave();
        if (err) console.warn('[supabase] cleared rows for ' + label + ' will not close — new round gets a fresh ticket:', err.message);
      }
      const id = await this.orderFor(label, order);
      if (order && order.items && order.items.length) await this.addItems(label, order.items);
      return id;
    }
    async addItems(label, lines) {
      const orderId = await this.orderFor(label);
      // Each round renews the hold, matching the sliding window in the app.
      if (!/^U/.test(label)) {
        // Renewing the hold is housekeeping, not a staff action: a refusal here
        // says nothing worth interrupting the counter with.
        this.sb.from('orders').update({ hold_at: new Date().toISOString() })
          .eq('id', orderId).then(() => {}, () => {});
      }
      const rows = lines
        .filter(l => this.dishId[l.id])
        .map(l => ({ order_id: orderId, dish_id: this.dishId[l.id], qty: l.qty, unit_price: l.price || 0 }));
      if (rows.length) await this.ins('order_items', rows);
    }
    /* Lifts the hide on a label. The quarantine is deliberately left alone —
       it is released by releaseDead once the server stops reporting those rows
       open, so a refused close cannot put their items back on the ticket. */
    dropGone(label) {
      if (this.db.clearedDrop) this.db.clearedDrop(label); else delete this.gone[label];
    }

    async closeOrder(label) {
      // Tombstone first: a hydrate already in flight would otherwise land after
      // this and put the ticket back, and the app would then re-open it as a
      // fresh row — which is how cleared orders returned with a duplicate each
      // time the board was cleared.
      const known = this.orderId[label];
      this.gone[label] = Date.now();
      this.goneSave();
      delete this.orderId[label];
      /* Every open row under the label, not just the one this client was
         tracking. A table that collected stale open rows over earlier visits
         would otherwise have one row quarantined and the rest read straight
         back as tickets — the "cleared orders adding up again" on tables that
         had been ordered on before. */
      const ids = [...new Set([
        ...(known ? [known] : []), ...(this.lastOpen[label] || []),
        ...this.deadIds(label), ...await this.openIds(label),
      ])];
      this.markDead(label, ids);
      delete this.lastOpen[label];
      // Every open row under the label, not one row by id: a label carrying two
      // open rows would otherwise keep the leftover and read back as a live ticket.
      const error = await this.closeIds(ids);
      if (error) {
        /* The board is already clear to the person who cleared it, so the
           tombstone stands and the next read tries again — but silence here is
           what let a lapsed session look like a clean close, so the panel is
           told and says so. */
        this.fail(error.message, 'close');
        console.warn('[supabase] could not close ' + label + ' — retrying on next read:', error.message);
      } else this.ok('close');
    }

    /* Signing out has to reach the stored session, not just the panel's own
       flag: persistSession keeps a token in storage that outlives the page, and
       the clear and payment guards now read that session as the authority. A
       sign-out that left it behind would leave the panel locked and the database
       still accepting. */
    async staffSignOut() {
      this.staff = false;
      this.reauth = null;
      try { await this.sb.auth.signOut(); } catch (e) {}
    }

    /* Staff session: makes guest comments readable (RLS keeps them out of anon reach). */
    async staffSignIn(email, password) {
      const { error } = await this.sb.auth.signInWithPassword({ email, password });
      if (error) return false;
      this.staff = true;
      /* Kept so a lapsed session can be rebuilt without the counter noticing.
         The token refreshes itself while the tab is awake, but a phone left
         locked through a quiet hour can come back past its expiry, and the
         first thing pressed is usually a clear. */
      this.reauth = async () => {
        const { error: e } = await this.sb.auth.signInWithPassword({ email, password });
        this.staff = !e;
        return !e;
      };
      await this.replayRefused();
      await this.hydrate();
      return true;
    }

    /* The sign-in that restores the session also finishes what the missing one
       refused. This used to clear the latch wholesale on the assumption that a
       fresh session answered every refusal — it answers the CAUSE, but the writes
       themselves were already lost, so the banner came down over a bill number
       that never landed. Now the banner only comes down for writes that actually
       went through on the retry. */
    async replayRefused() {
      const q = this._refused || [];
      this._refused = [];
      let stuck = null;
      for (const { job, msg } of q) {
        try { await job(); } catch (e) { stuck = stuck || msg; }
      }
      if (stuck) {
        /* fail() re-latches on its own key, so the banner stands. Something other
           than the session is refusing these — a guard the app is genuinely on the
           wrong side of — and saying "signed out" again would send staff back to
           the keypad for the rest of the shift. */
        this.fail('Signed in, but the server still refused that change. It was not saved.', 'refused');
        return false;
      }
      this._failed = new Set();
      this.onCloseOk && this.onCloseOk();
      return true;
    }
  }

  const lib = {
    name: 'store',
    async attach(db, cfg) {
      if (!cfg || !cfg.supabaseUrl || !cfg.supabaseAnonKey) return null;
      if (!window.supabase) await loadScript(CDN);
      /* Every request carries the phone's own id. The guest update policy in
         security.sql compares it against the ticket's device_id, so a guest can
         append to their own order and to no one else's — the comparison happens
         in Postgres, where the browser cannot reach it. Same id the app uses for
         the table hold, read from the same key. */
      const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true },
        realtime: { params: { eventsPerSecond: 5 } },
        global: { headers: { 'x-device-id': deviceId() } },
      });
      return new Remote(sb, db, cfg).boot();
    },
  };

  (window.SULTHANS_LIBS = window.SULTHANS_LIBS || {}).store = lib;
  window.dispatchEvent(new CustomEvent('sulthans:lib', { detail: 'store' }));
})();
