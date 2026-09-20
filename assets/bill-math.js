/* Sulthan's — the bill, as the counter's screen sees it.
   A mirror of bill_compute() in supabase/counter.sql, and only a mirror: these
   figures drive the live display while a cashier is typing, and the figures
   that get stored and printed are the ones Postgres returned. Kept in the same
   order of operations as the SQL so the two never disagree on screen — if you
   change one, change both.

   The order matters more than the arithmetic. Section 15(3) of the CGST Act
   allows a discount to be excluded from the taxable value only if it is given
   at the time of supply and shown on the invoice, which means it comes off
   BEFORE tax. A bill that taxes the gross and then discounts the total is
   non-compliant on every line, and the error is invisible: the numbers look
   plausible, they are simply wrong. */
(function () {
  const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n) || 0));

  /* Is a rule live at this moment, for a bill this size? Windows are minutes
     from midnight, and one that crosses midnight (22:00-02:00 = 1320-120) is
     read as wrapping rather than as an empty range. */
  function live(d, gross, at) {
    if (!d || d.active === false) return false;
    if (gross < (Number(d.min_order) || 0)) return false;
    const now = at || new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    if (Array.isArray(d.days) && d.days.length && d.days.indexOf(now.getDay()) < 0) return false;
    if (d.from_min == null || d.to_min == null) return true;
    if (d.from_min <= d.to_min) return mins >= d.from_min && mins < d.to_min;
    return mins >= d.from_min || mins < d.to_min;
  }

  /* lines:     [{dishId, name, qty, price, categoryId}]
     house:     the restaurant row — gst_rate, gst_mode, service_rate,
                service_on, pack_fee, round_off
     opts:      {discountIds:[], flat, pct, serviceOn, packOn, packFee, roundOff}
     discounts: every rule the house has; the auto ones apply unasked. */
  function compute(lines, house, opts, discounts, at) {
    const h = house || {}, o = opts || {};
    const rate = Number(h.gst_rate) || 0;
    const mode = h.gst_mode || 'exclusive';

    const L = (lines || []).map(l => ({
      ...l, amount: r2((Number(l.qty) || 0) * (Number(l.price) || 0)), discount: 0,
    }));
    const gross = r2(L.reduce((s, l) => s + l.amount, 0));

    const want = new Set(o.discountIds || []);
    const rules = (discounts || [])
      .filter(d => want.has(d.id) || d.auto)
      .filter(d => live(d, gross, at))
      .filter(d => !(d.needs_manager && !o.approver));

    let lineDisc = 0, billDisc = 0;
    const names = [];
    rules.forEach(d => {
      if (d.scope === 'bill') {
        billDisc += d.kind === 'flat' ? Number(d.value) || 0 : r2(gross * (Number(d.value) || 0) / 100);
        names.push(d.name);
        return;
      }
      L.forEach(l => {
        const hit = d.scope === 'item' ? l.dishId === d.dish_id : l.categoryId === d.category_id;
        if (!hit) return;
        const cut = d.kind === 'flat'
          ? Math.min((Number(d.value) || 0) * (Number(l.qty) || 0), l.amount - l.discount)
          : r2(l.amount * (Number(d.value) || 0) / 100);
        l.discount = r2(l.discount + cut);
        lineDisc += cut;
        if (names.indexOf(d.name) < 0) names.push(d.name);
      });
    });

    // The hand-typed discount, on top of what the rules found. This is the one
    // a cashier's cap governs — a configured rule was approved by whoever
    // configured it.
    if (o.flat) billDisc += Math.max(Number(o.flat) || 0, 0);
    if (o.pct) billDisc += r2((gross - lineDisc) * clamp(o.pct, 0, 100) / 100);

    lineDisc = r2(lineDisc);
    billDisc = r2(Math.min(billDisc, gross - lineDisc));
    const discount = r2(lineDisc + billDisc);
    const taxable = r2(gross - discount);

    const serviceOn = o.serviceOn == null ? !!h.service_on : !!o.serviceOn;
    const service = serviceOn && Number(h.service_rate) > 0
      ? r2(taxable * Number(h.service_rate) / 100) : 0;
    const pack = o.packOn ? (o.packFee != null ? Number(o.packFee) : Number(h.pack_fee) || 0) : 0;
    const dlv = Number(o.dlv) || 0;

    // Charges sit inside the taxable base: a restaurant bill is a composite
    // supply, so the packing and the service are taxed with the food.
    const base = r2(taxable + service + pack + dlv);

    let tax = 0, total = base;
    if (mode === 'exclusive') { tax = r2(base * rate / 100); total = r2(base + tax); }
    else if (mode === 'inclusive') { tax = r2(base - base * 100 / (100 + rate)); total = base; }

    const roundOff = o.roundOff == null ? h.round_off !== false : !!o.roundOff;
    let rounding = 0;
    if (roundOff) { rounding = r2(Math.round(total) - total); total = Math.round(total); }

    const cgst = r2(tax / 2);
    return {
      lines: L, gross, discount, discountNote: names.join(', '),
      lineDiscount: lineDisc, billDiscount: billDisc,
      taxable, service, serviceRate: Number(h.service_rate) || 0, pack, dlv,
      gstMode: mode, gstRate: rate, cgst, sgst: r2(tax - cgst),
      rounding, total: r2(total),
      discountPct: gross > 0 ? r2(discount / gross * 100) : 0,
    };
  }

  /* ---- splitting ----------------------------------------------------------
     A split divides a bill that has already been computed, so every share is
     cut from the same compliant total. Dividing the food and taxing each share
     separately would round three times and end up a rupee off the bill the
     customer is looking at.

     Equal:  N ways, with the paisa that will not divide handed to the first
             share rather than left unclaimed.
     Items:  a map of dishId -> share index; each share pays its own lines'
             proportion of the total, charges and tax included.
     Custom: fixed amounts, and the remainder becomes the last share. */
  function splitEqual(total, n) {
    const ways = Math.max(1, Math.round(n) || 1);
    const each = Math.floor((total * 100) / ways) / 100;
    const parts = Array.from({ length: ways }, () => each);
    parts[0] = r2(parts[0] + (total - each * ways));
    return parts.map((amount, i) => ({ label: 'Person ' + (i + 1), amount: r2(amount) }));
  }

  function splitByItems(bill, assign, ways) {
    const n = Math.max(1, Math.round(ways) || 1);
    const net = bill.lines.map(l => ({ id: l.dishId, net: r2(l.amount - l.discount) }));
    const sum = net.reduce((s, x) => s + x.net, 0) || 1;
    const parts = Array.from({ length: n }, (_, i) => ({
      label: 'Person ' + (i + 1), amount: 0,
      items: bill.lines.filter(l => (assign[l.dishId] || 0) === i).map(l => l.name + ' x' + l.qty),
    }));
    net.forEach(x => {
      const i = Math.min(assign[x.id] || 0, n - 1);
      parts[i].amount = r2(parts[i].amount + bill.total * x.net / sum);
    });
    // The rounding remainder lands on the largest share, where a paisa is least
    // likely to be argued about.
    const drift = r2(bill.total - parts.reduce((s, p) => s + p.amount, 0));
    if (drift) {
      const big = parts.reduce((a, b) => (b.amount > a.amount ? b : a), parts[0]);
      big.amount = r2(big.amount + drift);
    }
    return parts;
  }

  function splitCustom(total, amounts) {
    const fixed = (amounts || []).map(a => r2(a)).filter(a => a > 0);
    const taken = r2(fixed.reduce((s, a) => s + a, 0));
    const rest = r2(total - taken);
    const parts = fixed.map((amount, i) => ({ label: 'Person ' + (i + 1), amount }));
    if (rest > 0.009) parts.push({ label: 'Person ' + (fixed.length + 1), amount: rest });
    return parts;
  }

  /* What is still owed on a bill being settled across several tenders. */
  function tenderLeft(total, tenders) {
    const paid = (tenders || []).reduce((s, t) => s + (Number(t.amount) || 0), 0);
    return r2(total - paid);
  }

  /* The drawer, counted. Indian notes and a loose-coin total. */
  const NOTES = [500, 200, 100, 50, 20, 10, 5, 2, 1];
  function denomTotal(denom) {
    return r2(NOTES.reduce((s, n) => s + n * (Number((denom || {})[n]) || 0), 0)
      + (Number((denom || {}).coin) || 0));
  }

  window.BILL_MATH = { compute, live, splitEqual, splitByItems, splitCustom, tenderLeft, denomTotal, NOTES, r2 };
})();
