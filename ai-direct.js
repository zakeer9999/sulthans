/* Browser-direct mode for the assistant.
 *
 * There is no server here. The widget talks to Groq over fetch and to Postgres
 * through the Supabase client the app already signed in, so the whole thing
 * runs on a phone with nothing installed.
 *
 * Why that is allowed: the twelve ai_* functions are `security definer` and
 * granted to `authenticated`, not only to `service_role`. The admin password
 * opens a real Supabase Auth session (store-supabase.js -> staffSignIn), so the
 * browser holds a JWT that may execute them. No secret key is involved, and
 * none would work anyway — Supabase refuses secret keys from a browser origin.
 *
 * What it costs, stated plainly: the Groq key sits in config.js, readable by
 * anyone who opens the page source. It is rate-limited, rotatable, and buys an
 * attacker nothing but free tokens. The Supabase secret key is NOT here and
 * must never be.
 *
 * What is missing next to the server build: Instagram, Facebook, Google
 * reviews, competitors, trends and the review auto-reply. Those need secrets
 * that cannot live in a browser, so this mode reads the restaurant's own
 * numbers and nothing else. It says so when asked.
 */

const GROQ = 'https://api.groq.com/openai/v1';
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/openai';
const GEMINI_NATIVE = 'https://generativelanguage.googleapis.com/v1beta';
/* The alias, not a pinned id: gemini-2.5-flash was retired under us once
   already, and an unattended fallback should not 404 the day Google rolls. */
const GEMINI_CHAT = 'gemini-flash-latest';
const CHAT = 'openai/gpt-oss-120b';
const CHAT_SMALL = 'openai/gpt-oss-20b';
const NATIVE = 'qwen/qwen3.8-27b';

/* Reasoning budget. gpt-oss thinks before it answers and on a short question
   spends more on thinking than on the reply; 'low' cut a test from 313 tokens
   to 118 with no loss. On a free tier that is a shift's worth of questions
   instead of half of one. */
const EFFORT = 'low';

/* One entry per question the model may ask. Names match the server build's
   tools so the prompt reads the same in both modes; the rpc field is the
   Postgres function and args maps the model's arguments onto its parameters. */
const TOOLS = [
  {
    name: 'salesSummary',
    rpc: 'ai_sales_summary',
    /* Takings are counter business. The guest app's admin panel is opened on a
       phone that lives in a pocket and gets handed around; the counter is a
       signed-in till. Same assistant, but revenue is only read out on the
       till — see MONEY below for the figures stripped everywhere else. */
    counterOnly: true,
    args: a => ({ p_days: a.days ?? 7 }),
    schema: {
      description:
        'Overall trading for a period: revenue, bill count, covers, average bill, discount given, and the split by day, tender and channel. Read this first — it is the frame every other number is judged against.',
      parameters: { type: 'object', properties: { days: { type: 'integer', description: 'Business days back. 7 is a week.' } }, required: ['days'] },
    },
  },
  {
    name: 'topDishes',
    rpc: 'ai_top_dishes',
    /* Ranked, so off the counter it still answers "what sells" after the
       figures are taken out of it — see ranked() below. */
    ranked: true,
    args: a => ({ p_days: a.days ?? 7, p_limit: a.limit ?? 10 }),
    schema: {
      description:
        'Best-selling dishes ranked by revenue, with quantity and average price alongside. Quantity and revenue often disagree — shakes carry the count, biryani carries the money — so look at both.',
      parameters: { type: 'object', properties: { days: { type: 'integer' }, limit: { type: 'integer' } }, required: ['days'] },
    },
  },
  {
    name: 'slowMovers',
    rpc: 'ai_slow_movers',
    args: a => ({ p_days: a.days ?? 14, p_limit: a.limit ?? 10 }),
    schema: {
      description:
        'Dishes still on the menu that barely sold in the period. The rows returned ARE the slow movers. Use two weeks or more, or one quiet week reads as a dead dish.',
      parameters: { type: 'object', properties: { days: { type: 'integer' }, limit: { type: 'integer' } }, required: ['days'] },
    },
  },
  {
    name: 'dishRatings',
    rpc: 'ai_dish_ratings',
    /* A small house rates a dish a handful of times a month, not a handful of
       times a week. Seven days and three votes is a threshold built for a
       chain; here it returns nothing and reads as "no ratings exist", which is
       false. Ninety days and one vote is what this kitchen actually has. */
    args: a => ({ p_days: a.days ?? 90, p_worst: a.worst !== false, p_min_votes: a.minVotes ?? 1 }),
    schema: {
      description:
        'Guest ratings per dish, worst or best first, with vote count and quantity sold. A badly rated dish that sells well is a recipe problem; promoting it makes the problem bigger. Ratings are sparse — leave days and minVotes alone unless asked for a specific window, and if a narrow window comes back empty widen it before saying there are none.',
      parameters: {
        type: 'object',
        properties: { days: { type: 'integer' }, worst: { type: 'boolean', description: 'true for worst rated first' }, minVotes: { type: 'integer' } },
      },
    },
  },
  {
    /* dishRatings aggregates stars and throws the words away, so asked what a
       guest actually wrote the assistant said the system keeps no comments —
       while the feedback page, reading the same table, printed them. The text
       is in dish_feedback.comment and service_feedback.comment; there was no
       tool pointed at it. Comments are staff-only by column grant, so this
       reads only with a staff session and says so when it has none rather
       than reporting them as non-existent. */
    name: 'feedbackComments',
    run: async (sb, rid, a) => {
      const days = Math.min(Math.max(Number(a.days) || 90, 1), 365);
      const cap = Math.min(Number(a.limit) || 40, 100);
      const since = new Date(Date.now() - days * 864e5).toISOString();
      const like = String(a.dish || '').trim().replace(/[%,()]/g, '');

      let q = sb.from('dish_feedback')
        .select('stars,comment,created_at,dishes!inner(name_en,restaurant_id)')
        .eq('dishes.restaurant_id', rid)
        .not('comment', 'is', null)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(cap);
      if (like) q = q.ilike('dishes.name_en', '%' + like + '%');

      const { data, error } = await q;
      if (error) {
        /* Not "there are none" — "they are not readable from here". */
        if (/permission|denied|not exist/i.test(error.message)) {
          return { unreadable: true, hint: 'Written comments are staff-only and this session is not signed in as staff. Say the comments exist but need a staff sign-in to read; do not say none were left.' };
        }
        throw new Error(error.message);
      }

      const dish = (data || [])
        .filter(r => (r.comment || '').trim())
        .map(r => ({
          dish: r.dishes && r.dishes.name_en, stars: r.stars,
          said: r.comment.trim(), at: r.created_at,
        }));

      let service = [];
      if (!like) {
        const { data: sv } = await sb.from('service_feedback')
          .select('stars,comment,created_at,table_label')
          .eq('restaurant_id', rid)
          .not('comment', 'is', null)
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(Math.min(cap, 30));
        service = (sv || []).filter(r => (r.comment || '').trim())
          .map(r => ({ table: r.table_label || undefined, stars: r.stars, said: r.comment.trim(), at: r.created_at }));
      }

      if (!dish.length && !service.length) {
        return { empty: true, hint: like
          ? 'No written comment on a dish matching "' + like + '" in the last ' + days + ' days. Most ratings are stars only. Widen days or drop the dish filter before concluding there are none.'
          : 'No written comments in the last ' + days + ' days — ratings in this window were stars only.' };
      }
      return { days, dish, service };
    },
    schema: {
      description:
        'What guests actually WROTE: the free-text comment left with a rating, per dish, plus service comments, newest first with stars and date. This is the tool for "what did customers say", "any written feedback", "what are the complaints", "read me the reviews" or anything quoting a guest. dishRatings gives only averages — the words live here, so ALWAYS call this before saying comments are not stored or none exist. Comments are sparse: leave days alone unless a window was asked for.',
      parameters: {
        type: 'object',
        properties: {
          dish: { type: 'string', description: 'part of a dish name to filter to one dish' },
          days: { type: 'integer', description: 'lookback window, default 90' },
          limit: { type: 'integer' },
        },
      },
    },
  },
  {
    /* The board the admin panel and the floor screen are both looking at lives
       in this page's own store, not in a table an rpc can reach — so asked what
       table 7 has or which ticket is oldest, the assistant had only the menu to
       answer from and said the floor was not something it could see. The page
       hands its snapshot in and this tool is the door to it. Plates, notes and
       ages; no amounts, because takings stay counter business whichever tool
       the question arrives through. */
    name: 'openOrders',
    local: true,
    run: (sb, rid, a, ctx) => {
      const snap = ctx && typeof ctx.floor === 'function' ? ctx.floor() : null;
      if (!snap) return { unavailable: true, hint: 'The live board is not readable from this screen. Say so rather than guessing what is open.' };
      if (!snap.orders || !snap.orders.length) return { empty: true, hint: 'Nothing open on the board right now — no tables seated and no parcels waiting.' };
      return snap;
    },
    schema: {
      description:
        'The live board as it stands: every open ticket with its board number, its table or parcel label, the dishes on it with quantities, notes and how many portions have gone out, and how long it has been open. This is the tool for anything about service right now — which tables are seated, what a table ordered, what is still to go out, which ticket has been open longest — and the tool to read before acting on a ticket by number. It is a live read: call it again rather than trusting what the board looked like earlier in the conversation.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    /* Service stars had no reader. dishRatings is per dish and feedbackComments
       only returns rows with words, so "how was service this month" — mostly
       stars with no comment — got "I don't have a tool". */
    name: 'serviceRatings',
    run: async (sb, rid, a) => {
      const now = new Date();
      let from, to = now, label;
      if (a.period === 'last_month') { from = new Date(now.getFullYear(), now.getMonth() - 1, 1); to = new Date(now.getFullYear(), now.getMonth(), 1); label = 'last month'; }
      else if (a.period === 'this_week') { from = new Date(now); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - ((from.getDay() + 6) % 7)); label = 'this week'; }
      else if (a.period === 'today') { from = new Date(now); from.setHours(0, 0, 0, 0); label = 'today'; }
      else if (a.days) { from = new Date(now - Math.min(Number(a.days), 365) * 864e5); label = 'last ' + a.days + ' days'; }
      else { from = new Date(now.getFullYear(), now.getMonth(), 1); label = 'this month'; }
      const { data, error } = await sb.from('service_feedback')
        .select('stars,comment,table_label,created_at').eq('restaurant_id', rid)
        .gte('created_at', from.toISOString()).lt('created_at', to.toISOString())
        .order('created_at', { ascending: false }).limit(2000);
      if (error) return unreadable(error);
      const rows = data || [];
      if (!rows.length) return { period: label, empty: true, hint: 'No service ratings were left ' + label + '.' };
      const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      rows.forEach(r => { dist[r.stars] = (dist[r.stars] || 0) + 1; });
      const avg = rows.reduce((n, r) => n + r.stars, 0) / rows.length;
      const byTable = {};
      rows.forEach(r => { const t = r.table_label || 'walk-in'; (byTable[t] = byTable[t] || []).push(r.stars); });
      const weekly = {};
      rows.forEach(r => { const d = new Date(r.created_at); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); const k = d.toISOString().slice(0, 10); (weekly[k] = weekly[k] || []).push(r.stars); });
      const mean = xs => Math.round(xs.reduce((n, x) => n + x, 0) / xs.length * 100) / 100;
      return {
        period: label, ratings: rows.length, average: Math.round(avg * 100) / 100,
        starsBreakdown: dist, lowRatings: dist[1] + dist[2],
        byWeek: Object.entries(weekly).sort().map(([wk, xs]) => ({ weekOf: wk, ratings: xs.length, average: mean(xs) })),
        tablesRatedLowest: Object.entries(byTable).map(([t, xs]) => ({ table: t, ratings: xs.length, average: mean(xs) })).sort((x, y) => x.average - y.average).slice(0, 5),
        comments: rows.filter(r => (r.comment || '').trim()).slice(0, 20).map(r => ({ stars: r.stars, table: r.table_label || undefined, said: r.comment.trim(), at: r.created_at })),
      };
    },
    schema: {
      description: 'Service ratings (the stars guests give the service itself, not a dish) for a period: count, average, 1–5 star breakdown, low ratings, week-by-week trend, lowest-rated tables and any written service comments. Use for any question about service rating, service score, how service was, or service feedback. Default period is this month.',
      parameters: {
        type: 'object',
        properties: {
          period: { type: 'string', enum: ['today', 'this_week', 'this_month', 'last_month'] },
          days: { type: 'integer', description: 'rolling window instead of a named period' },
        },
      },
    },
  },
  {
    /* Browsing on the free tier: Groq's browser_search on the chat key. Gemini
       search grounding was tried first and returned 429 on every model for
       this free key, so it is gone. */
    name: 'webResearch',
    run: async (sb, rid, a, ctx) => {
      const ask = String(a.question || '').trim();
      if (!ask) return { error: 'question required' };
      /* Prompts built on invented dishes advertise food the kitchen does not
         cook. Hand the model the real menu ranked by what sells and rates,
         and make it pick from that list only. Names only, no figures. */
      let dishes = '';
      if (a.imagePrompts) {
        const [top, rated] = await Promise.all([
          sb.rpc('ai_top_dishes', { p_rid: rid, p_days: 30, p_limit: 12 }),
          sb.rpc('ai_dish_ratings', { p_rid: rid, p_days: 90, p_worst: false, p_min_votes: 1 }),
        ]);
        const nm = r => r.name_en || r.name || r.dish;
        const best = (top.data || []).map(nm).filter(Boolean);
        const loved = (rated.data || []).slice(0, 8).map(nm).filter(Boolean);
        const facts = await dishDossier(sb, rid, a.dish ? [a.dish] : best.slice(0, 5), !!a.dish);
        dishes = ' OUR DISHES — best sellers this month, in order: ' + (best.join(', ') || 'none recorded') +
          '. Highest rated: ' + (loved.join(', ') || 'none recorded') + '.' +
          (a.dish ? ' The owner wants to feature: ' + a.dish + '.' : '') +
          (facts.length ? ' DISH FACTS — describe these dishes only from this, never invent ingredients or garnish: ' + JSON.stringify(facts) : '');
      }
      const want = a.imagePrompts
        ? ' Then write ' + Math.min(Number(a.imagePrompts) || 3, 6) + ' image-generation prompts. Each prompt must feature ONE dish from OUR DISHES only (never invent or swap in a dish we do not serve), chosen because it best fits a specific live trend, weather, festival or local event you found and dated above — state that pairing and why in one line above the prompt, favouring best sellers. Describe the dish accurately as it is served in Tamil Nadu. Then give subject, setting, lighting, camera angle, style, aspect ratio, and any overlay text in quotes. After each prompt add a 15\u201330 second reel idea for the same dish and pairing: shots in order, audio, and on-screen text.'
        : '';
      const prompt = 'You are researching for ' + PLACE.restaurantName + ', a restaurant in ' + PLACE.town + ', India. Use the local language of that town. Today is ' + new Date().toDateString() + '. ' +
        'Search the web and answer with current, specific, practical findings, as short bullets, naming sources with their date.' +
        ' Only trends that are live in the last 30 days (an AI image style, a reel format, an audio, a meme, a local festival or the week\'s weather), each named exactly as people search for it, with where it is trending and the date of the source that shows it. First search for what is trending on Instagram and Reels this week in India and Tamil Nadu; a trend with no source dated within 30 days of today is dropped, however famous it was. Never fall back on trends you remember. The owner will usually not name a trend: find the top 3 live ones yourself and rank them by fit for a Tamil Nadu biryani restaurant. Drop anything older, and never give evergreen advice such as farm-to-table, healthy eating, behind-the-scenes or user-generated content.' +
        ' Question: ' + ask + dishes + want;
      const [notes, weather, pages] = await Promise.all([trendNotes(), weekWeather(), trendPages()]);
      let r = await groqResearch(ctx.groqKey, prompt + notes + weather + pages);
      if (r && r.unavailable && ctx.groqKey) { await new Promise(z => setTimeout(z, 7000)); r = await groqResearch(ctx.groqKey, prompt + notes + weather + pages); }
      if (r && r.unavailable && (notes || pages)) return { busy: true, hint: 'Live web search is busy. Answer from these saved trend notes, trend pages and weather only; do not claim any other trend is live, and say live search was busy in one short line at the end.', saved: (notes + weather + pages).slice(0, 6000), dishes };
      return r;
    },
    schema: {
      description: 'Live web research: current social media trends (Instagram reels, food trends, hashtags), marketing and campaign ideas, festivals and local events in the restaurant\'s town, and what competitors or the food scene are doing. Set imagePrompts to also get ready-to-use image-generation prompts for posts and campaign creatives. Use whenever the answer needs anything outside the restaurant\'s own data. Pass on the sources it names.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'what to research, in full' },
          imagePrompts: { type: 'integer', description: 'how many image-generation prompts to write (0 for none)' },
          dish: { type: ['string', 'null'], description: 'a specific dish the owner wants to promote, if named; omit otherwise' },
        },
        required: ['question'],
      },
    },
  },
  {
    name: 'dishDetails',
    run: async (sb, rid, a) => {
      const r = await dishDossier(sb, rid, [String(a.dish || '')], true);
      return r.length ? { dishes: r } : { empty: true, hint: 'No dish on the menu matches "' + a.dish + '".' };
    },
    schema: {
      description: 'Everything about one dish for describing or advertising it: listed ingredients, recipe ingredients, the chef\'s note, spice level, star rating and what guests wrote about it. Use before writing any copy, caption or description of a dish.',
      parameters: { type: 'object', properties: { dish: { type: 'string', description: 'dish name or part of it' } }, required: ['dish'] },
    },
  },
  {
    name: 'kitchenBottlenecks',
    rpc: 'ai_kitchen_bottlenecks',
    args: a => ({ p_days: a.days ?? 7 }),
    schema: {
      description:
        "Where the kitchen loses time: average, median and 90th-percentile minutes per prep stage against that stage's own target, plus the slowest dishes and worst hours.",
      parameters: { type: 'object', properties: { days: { type: 'integer' } }, required: ['days'] },
    },
  },
  {
    name: 'sellouts',
    rpc: 'ai_sellouts',
    args: a => ({ p_days: a.days ?? 7 }),
    schema: {
      description:
        'Dishes that ran out, how often, and the average hour they went. A dish gone before the evening rush is lost revenue, not a success — the answer is more prep, not more marketing.',
      parameters: { type: 'object', properties: { days: { type: 'integer' } }, required: ['days'] },
    },
  },
  {
    name: 'daypartMix',
    rpc: 'ai_daypart_mix',
    args: a => ({ p_days: a.days ?? 14 }),
    schema: {
      description:
        'Trade by hour of day and by weekday. Use it to place a promotion where there is capacity: an offer pointed at an hour already full costs margin and gains nothing.',
      parameters: { type: 'object', properties: { days: { type: 'integer' } }, required: ['days'] },
    },
  },
  {
    /* Why a dish is off, not merely that it is. The menu tool carries
       available:false and nothing else, so asked why the chicken patiala was
       off the assistant said no reason was recorded — while the stock page,
       reading the same rows, printed "Short of Chicken". The reason has been
       in dish_offs all along; there was no tool pointed at it. Off-menu is a
       service fact, not a figure, so it reads in both apps. */
    name: 'dishesOff',
    rpc: 'dishes_off',
    args: () => ({}),
    schema: {
      description:
        'Every dish that is off right now and why, in words: short of a named ingredient, cook not in, takes too long tonight, off the menu today, or no reason given. Also who took it off and when. ALWAYS use this before saying a reason is unknown — asked which dishes are unavailable or why one is, this is the tool, not the menu.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    /* Everything below reads tables straight, the way the pages that show the
       same rows do. Off the counter only takings and pay are withheld, so none
       of these select a pay rate, a bill value or a salary line. */
    name: 'staffRoster',
    run: async (sb, rid, a) => {
      const days = Math.min(Math.max(Number(a.days) || 7, 1), 60);
      const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
      const ahead = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
      const today = new Date().toISOString().slice(0, 10);
      const [st, at, sh] = await Promise.all([
        sb.from('staff').select('id,name,role,active').eq('restaurant_id', rid).order('name'),
        sb.from('attendance').select('staff_id,day,in_at,out_at,break_mins,note').eq('restaurant_id', rid).gte('day', since).order('in_at', { ascending: false }).limit(400),
        sb.from('shifts').select('staff_id,day,starts_at,ends_at,note').eq('restaurant_id', rid).gte('day', today).lte('day', ahead).order('starts_at').limit(200),
      ]);
      if (st.error) return unreadable(st.error);
      const who = Object.fromEntries((st.data || []).map(p => [p.id, p.name]));
      const hrs = r => r.out_at ? Math.round(((new Date(r.out_at) - new Date(r.in_at)) / 36e5 - (r.break_mins || 0) / 60) * 10) / 10 : undefined;
      return {
        staff: (st.data || []).map(p => ({ name: p.name, role: p.role, active: p.active })),
        onFloorNow: (at.data || []).filter(r => r.day === today && !r.out_at).map(r => ({ name: who[r.staff_id], since: r.in_at })),
        attendance: (at.data || []).map(r => ({ name: who[r.staff_id], day: r.day, in: r.in_at, out: r.out_at || undefined, hoursWorked: hrs(r), note: r.note || undefined })),
        rosterNext7Days: (sh.data || []).map(r => ({ name: who[r.staff_id], day: r.day, from: r.starts_at, to: r.ends_at, note: r.note || undefined })),
      };
    },
    schema: {
      description: 'The team: every staff member with role and whether active, who is clocked in right now, attendance (in/out times and hours worked) for the last N days, and the roster for the next 7 days. Use for who is working, who was late or absent, who is on tomorrow, hours put in. Pay is not in here.',
      parameters: { type: 'object', properties: { days: { type: 'integer', description: 'attendance lookback, default 7' } } },
    },
  },
  {
    name: 'stock',
    run: async (sb, rid, a) => {
      const days = Math.min(Math.max(Number(a.days) || 7, 1), 90);
      const since = new Date(Date.now() - days * 864e5).toISOString();
      const [ing, mv] = await Promise.all([
        sb.from('ingredients').select('id,name,unit,stock,reorder_level,cost,supplier,active').eq('restaurant_id', rid).eq('active', true).order('name'),
        sb.from('stock_moves').select('ingredient_id,kind,qty,note,created_at').eq('restaurant_id', rid).in('kind', ['receive', 'waste', 'count', 'correct']).gte('created_at', since).order('created_at', { ascending: false }).limit(200),
      ]);
      if (ing.error) return unreadable(ing.error);
      const name = Object.fromEntries((ing.data || []).map(i => [i.id, i.name]));
      const items = (ing.data || []).map(i => ({
        name: i.name, unit: i.unit, stock: Number(i.stock), reorderAt: Number(i.reorder_level),
        low: Number(i.stock) <= Number(i.reorder_level), costPerUnit: i.cost == null ? undefined : Number(i.cost), supplier: i.supplier || undefined,
      }));
      if (!items.length) return { empty: true, hint: 'No ingredients are set up in stock yet.' };
      return {
        low: items.filter(i => i.low).map(i => i.name),
        ingredients: items,
        recentMoves: (mv.data || []).map(m => ({ ingredient: name[m.ingredient_id], kind: m.kind, qty: Number(m.qty), note: m.note || undefined, at: m.created_at })),
      };
    },
    schema: {
      description: 'Kitchen stock: every ingredient with its balance, unit, reorder level, cost per unit and supplier, which are low, and the recent receipts, wastage and counts. Use for what is running low, what to order, what was wasted, who supplies what.',
      parameters: { type: 'object', properties: { days: { type: 'integer', description: 'lookback for stock moves, default 7' } } },
    },
  },
  {
    name: 'customers',
    run: async (sb, rid, a) => {
      const cap = Math.min(Number(a.limit) || 25, 100);
      const like = String(a.search || '').trim().replace(/[%,()]/g, '');
      let q = sb.from('customers').select('name,raw_mobile,mobile,orders_count,last_order_at,last_table,wa_opt_out,notes,created_at', { count: 'exact' }).eq('restaurant_id', rid);
      if (like) q = q.or('name.ilike.%' + like + '%,mobile.ilike.%' + like + '%');
      if (a.lapsedDays) q = q.lt('last_order_at', new Date(Date.now() - Number(a.lapsedDays) * 864e5).toISOString());
      q = a.sort === 'recent' ? q.order('last_order_at', { ascending: false, nullsFirst: false }) : a.sort === 'new' ? q.order('created_at', { ascending: false }) : q.order('orders_count', { ascending: false });
      const { data, error, count } = await q.limit(cap);
      if (error) return unreadable(error);
      return {
        matching: count,
        customers: (data || []).map(c => ({ name: c.name || undefined, mobile: c.raw_mobile || c.mobile, visits: c.orders_count, lastVisit: c.last_order_at || undefined, lastTable: c.last_table || undefined, optedOutOfWhatsApp: c.wa_opt_out || undefined, notes: c.notes || undefined, firstSeen: c.created_at })),
      };
    },
    schema: {
      description: 'The customer book: name, mobile, number of visits, last visit, last table, notes, WhatsApp opt-out, and how many customers match. Use for regulars, new customers, who has not come back, looking someone up by name or number.',
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'part of a name or mobile number' },
          sort: { type: 'string', enum: ['visits', 'recent', 'new'] },
          lapsedDays: { type: 'integer', description: 'only customers not seen in this many days' },
          limit: { type: 'integer' },
        },
      },
    },
  },
  {
    name: 'onlineReviews',
    run: async (sb, rid, a) => {
      const days = Math.min(Math.max(Number(a.days) || 90, 1), 730);
      const since = new Date(Date.now() - days * 864e5).toISOString();
      let q = sb.from('reviews').select('source,author,stars,body,posted_at,state,hold_reason,sentiment,topics').eq('restaurant_id', rid).gte('posted_at', since).order('posted_at', { ascending: false }).limit(Math.min(Number(a.limit) || 40, 100));
      if (a.source) q = q.eq('source', a.source);
      const [rv, cp] = await Promise.all([q, sb.from('competitors').select('name,kind,distance_m,rating,rating_count,price_level,cuisines').eq('restaurant_id', rid).eq('watched', true).order('distance_m').limit(20)]);
      if (rv.error && cp.error) return unreadable(rv.error);
      return {
        reviews: (rv.data || []).map(r => ({ source: r.source, author: r.author || undefined, stars: r.stars, said: r.body || undefined, at: r.posted_at, state: r.state, heldBecause: r.hold_reason || undefined, sentiment: r.sentiment || undefined, topics: r.topics || undefined })),
        competitors: (cp.data || []).map(c => ({ name: c.name, kind: c.kind, metres: c.distance_m, rating: c.rating == null ? undefined : Number(c.rating), ratingCount: c.rating_count, priceLevel: c.price_level, cuisines: c.cuisines })),
      };
    },
    schema: {
      description: 'Google, Instagram and Facebook reviews with their text, stars, sentiment, topics and reply state (new, held, replied), plus the watched nearby competitors with their rating, review count, distance and price level. In-app dish comments are feedbackComments; this is the public side.',
      parameters: { type: 'object', properties: { days: { type: 'integer' }, source: { type: 'string', enum: ['google', 'instagram', 'facebook', 'in-app'] }, limit: { type: 'integer' } } },
    },
  },
  {
    /* Spending is not takings. Salary advances and wage payouts go through the
       same drawer, so those lines are dropped here, not just their amounts. */
    name: 'expenses',
    run: async (sb, rid, a) => {
      const days = Math.min(Math.max(Number(a.days) || 30, 1), 365);
      const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
      const { data, error } = await sb.from('expenses').select('day,category,amount,mode,note,payee').eq('restaurant_id', rid).gte('day', since).order('day', { ascending: false }).limit(300);
      if (error) return unreadable(error);
      const PAYLINE = /salar|wage|payroll|advance|stipend|bonus|staff pay/i;
      const rows = (data || []).filter(r => !PAYLINE.test([r.category, r.note, r.payee].join(' ')));
      if (!rows.length) return { empty: true, hint: 'No expenses recorded in the last ' + days + ' days.' };
      const byCat = {};
      rows.forEach(r => { byCat[r.category] = Math.round(((byCat[r.category] || 0) + Number(r.amount)) * 100) / 100; });
      return { days, spentByCategory: byCat, lines: rows.map(r => ({ day: r.day, category: r.category, spent: Number(r.amount), mode: r.mode, note: r.note || undefined, payee: r.payee || undefined })) };
    },
    schema: {
      description: 'Money paid out of the drawer for running costs — vegetables, gas, repairs, suppliers — by day and category, with payee and note. Salary and wage payouts are excluded.',
      parameters: { type: 'object', properties: { days: { type: 'integer', description: 'default 30' } } },
    },
  },
  {
    name: 'serviceLog',
    run: async (sb, rid, a) => {
      const days = Math.min(Math.max(Number(a.days) || 7, 1), 90);
      const since = new Date(Date.now() - days * 864e5).toISOString();
      const [wc, cm] = await Promise.all([
        sb.from('waiter_calls').select('table_label,called_at,attended_at').eq('restaurant_id', rid).gte('called_at', since).order('called_at', { ascending: false }).limit(300),
        sb.from('campaigns').select('name,body,state,created_at,finished_at').eq('restaurant_id', rid).order('created_at', { ascending: false }).limit(15),
      ]);
      if (wc.error && cm.error) return unreadable(wc.error);
      const calls = (wc.data || []).map(c => ({ table: c.table_label, at: c.called_at, answeredInMin: c.attended_at ? Math.round((new Date(c.attended_at) - new Date(c.called_at)) / 6e4 * 10) / 10 : undefined }));
      const answered = calls.filter(c => c.answeredInMin != null);
      return {
        waiterCalls: { total: calls.length, unanswered: calls.length - answered.length, avgMinutesToAnswer: answered.length ? Math.round(answered.reduce((n, c) => n + c.answeredInMin, 0) / answered.length * 10) / 10 : undefined, recent: calls.slice(0, 60) },
        whatsappCampaigns: (cm.data || []).map(c => ({ name: c.name, message: c.body, state: c.state, created: c.created_at, finished: c.finished_at || undefined })),
      };
    },
    schema: {
      description: 'Guest waiter calls from the tables — how many, which tables, how long staff took to answer, which went unanswered — and the WhatsApp campaigns sent to customers with their message and status.',
      parameters: { type: 'object', properties: { days: { type: 'integer', description: 'default 7' } } },
    },
  },
  {
    /* The menu itself. Every other tool reads what was sold; none of them
       could answer "what does the chicken dum biryani cost", which is the
       question a counter asks most often. Read straight from the table rather
       than through an ai_* function — a price is a fact about the menu, not an
       analysis of it, and there is nothing to aggregate. */
    name: 'menu',
    run: async (sb, rid, a) => {
      const sel = 'no,name_en,name_ta,price,available,hidden';
      const base = () => sb.from('dishes').select(sel)
        .eq('restaurant_id', rid).eq('hidden', false).order('no');
      const cap = Math.min(Number(a.limit) || 120, 300);
      const like = String(a.search || '').trim();

      let data, error;
      if (!like) {
        ({ data, error } = await base().limit(cap));
      } else {
        /* "mutton fry biryani" is Mutton Fry Piece Biryani on the card. A
           single substring match misses it, because the guest's phrase is not
           a contiguous run of the real name. Match any word, then prefer the
           rows that carry all of them — so the exact dish surfaces first and
           a near miss still returns something to name. */
        const words = like.split(/\s+/).filter(w => w.length > 1).slice(0, 5);
        let q = base();
        (words.length ? words : [like]).forEach(w => {
          const e = w.replace(/[%,()]/g, '');
          q = q.or('name_en.ilike.%' + e + '%,name_ta.ilike.%' + e + '%');
        });
        ({ data, error } = await q.limit(cap));
        if (!error && words.length > 1) {
          const all = (data || []).filter(d => {
            const hay = ((d.name_en || '') + ' ' + (d.name_ta || '')).toLowerCase();
            return words.every(w => hay.includes(w.toLowerCase()));
          });
          if (all.length) data = all;
        }
      }
      if (error) throw new Error(error.message);
      if (!data || !data.length) {
        return like
          ? { empty: true, hint: 'Nothing on the menu matches "' + like + '". Try a single distinctive word from the name before concluding it is not sold.' }
          : { empty: true, hint: 'The menu is empty.' };
      }
      return data.map(d => ({
        no: d.no, name: d.name_en, tamil: d.name_ta || undefined,
        price: Number(d.price), available: d.available !== false,
      }));
    },
    schema: {
      description:
        'The menu as it stands today: dish number, name, price in rupees and whether it is available. Use it for any question about what something costs, what is on the menu, what a dish number is, or whether a dish is being sold — these are facts about the card, not about sales. Pass search to match part of a name; a guest’s wording rarely matches the card exactly, so if a phrase finds nothing, search one distinctive word from it before saying the dish does not exist.',
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'part of a dish name, e.g. "biryani"' },
          limit: { type: 'integer' },
        },
      },
    },
  },
];

function unreadable(err) {
  if (/permission|denied|not exist|rls|policy/i.test(err.message || '')) {
    return { unreadable: true, hint: 'This data needs a staff sign-in and this session does not have one. Say so; do not say the data does not exist.' };
  }
  throw new Error(err.message);
}

/* What a dish actually is: its listed ingredients, the recipe lines, the chef's
   note (chef-notes.js, so the counter gets it too) and what
   guests wrote about it. No prices. */
async function dishDossier(sb, rid, names, fuzzy) {
  names = names.filter(Boolean);
  if (!names.length) return [];
  let q = sb.from('dishes').select('id,slug,name_en,name_ta,spice,ingredients,rating_avg,rating_count').eq('restaurant_id', rid);
  q = fuzzy ? q.ilike('name_en', '%' + names[0].replace(/[%,()]/g, '') + '%').limit(3) : q.in('name_en', names);
  const { data } = await q;
  const notes = await import(new URL('./chef-notes.js', import.meta.url).href).then(m => m.CHEF_NOTES, () => ({}));
  return Promise.all((data || []).map(async d => {
    const [rc, fb] = await Promise.all([
      sb.from('recipes').select('ingredients(name)').eq('dish_id', d.id),
      sb.from('dish_feedback').select('stars,comment').eq('dish_id', d.id).not('comment', 'is', null).order('created_at', { ascending: false }).limit(6),
    ]);
    const recipe = (rc.data || []).map(r => r.ingredients && r.ingredients.name).filter(Boolean);
    return {
      dish: d.name_en, tamil: d.name_ta || undefined, spiceOutOf5: d.spice,
      ingredients: d.ingredients || undefined, recipe: recipe.length ? recipe : undefined,
      chefNote: (notes[d.slug] || {}).en, stars: d.rating_count ? Number(d.rating_avg) : undefined, ratings: d.rating_count || undefined,
      guestsSaid: (fb.data || []).filter(f => (f.comment || '').trim()).map(f => f.stars + '★ ' + f.comment.trim()),
    };
  }));
}

/* Search alone cannot tell what went viral this week, so these three blogs,
   each rewritten weekly by people who watch the feed, are read first and
   handed over as the primary source. r.jina.ai is a free reader that returns
   a page as plain text and allows browser fetches.
   ponytail: three fixed URLs, 3000 characters each; swap a URL here if one
   stops updating, and cache for a day if the free reader starts limiting. */
const TREND_PAGES = [
  ['Tamil Nadu \u2014 what people are searching right now (Google Trends, live)', 'https://trends.google.com/trending/rss?geo=IN-TN'],
  ['Tamil Nadu \u2014 viral and trending stories (News18 Tamil)', 'https://tamil.news18.com/trending/'],
  ['India \u2014 what people are searching right now (Google Trends, live)', 'https://trends.google.com/trending/rss?geo=IN'],
  ['Global Instagram formats and AI image styles (weekly)', 'https://lightreel.ai/blogs/whats-trending-on-instagram'],
  ['Global Instagram Reels formats (weekly)', 'https://newengen.com/insights/instagram-trends/'],
];
/* Provider notes: one public file in the provider's repo, read by every
   restaurant's site. Sections start "## YYYY-MM-DD" (optional "until YYYY-MM-DD");
   sorted newest first, expired ones dropped, empty file = skipped. */
const PLACE = Object.assign({ restaurantName: "Sulthan's", town: 'Aruppukottai, Virudhunagar district, Tamil Nadu', lat: 9.51, lon: 78.10 },
  typeof window !== 'undefined' && window.SULTHANS_CONFIG || {});
const TREND_NOTES_URL = 'https://raw.githubusercontent.com/zakeer9999/MarvotechEvery/main/trends.md';
async function trendNotes() {
  let text = '';
  try { const r = await fetch(TREND_NOTES_URL, { cache: 'no-store' }); if (r.ok) text = await r.text(); } catch (e) {}
  const today = new Date().toISOString().slice(0, 10);
  const rows = text.split(/^## /m).slice(1)
    .map(s => ({ s: s.trim(), d: (s.match(/^\d{4}-\d{2}-\d{2}/) || [''])[0], u: (s.match(/until (\d{4}-\d{2}-\d{2})/) || [])[1] }))
    .filter(n => n.d && n.d <= today && (!n.u || n.u >= today))
    .sort((x, y) => y.d.localeCompare(x.d)).slice(0, 15)
    .map(n => { const [h, ...body] = n.s.split('\n'); return '- [' + h.trim() + '] ' + body.join(' ').replace(/\s+/g, ' ').trim(); })
    .join('\n').slice(0, 4000);
  if (!rows) return '';
  return '\n\nPROVIDER TREND NOTES, newest first. Weigh these first, newest most, but do not just restate them: combine them with the live web trends, weather, festivals and this restaurant\'s own data below, and keep a strong web or local trend even when no note covers it. ' +
    'Where two notes cover the same occasion or style, the newer one wins; use older notes only for what newer ones do not cover. ' +
    'Pick the note that fits today\'s date, weather and occasion, then pick the dish from OUR DISHES that suits it best (spice, heat, sweetness, portion, what sells here). Never copy a dish named in a note unless we serve it:\n' + rows;
}
/* The same notes as a list, for the Content Studio's "trend of the week". */
export async function trendNoteList() {
  let text = '';
  try { const r = await fetch(TREND_NOTES_URL, { cache: 'no-store' }); if (r.ok) text = await r.text(); } catch (e) {}
  const today = new Date().toISOString().slice(0, 10);
  return text.split(/^## /m).slice(1)
    .map(s => ({ s: s.trim(), d: (s.match(/^\d{4}-\d{2}-\d{2}/) || [''])[0], u: (s.match(/until (\d{4}-\d{2}-\d{2})/) || [])[1] }))
    .filter(n => n.d && n.d <= today && (!n.u || n.u >= today))
    .sort((x, y) => y.d.localeCompare(x.d)).slice(0, 9)
    .map(n => { const [h, ...body] = n.s.split('\n'); return { date: n.d, until: n.u || '', title: h.replace(/^\d{4}-\d{2}-\d{2}\s*(until \d{4}-\d{2}-\d{2})?\s*[-:\u2014]?\s*/, '').trim() || 'Trend note', body: body.join('\n').trim() }; });
}
/* Free, no key. Coordinates from config.js. */
async function weekWeather() {
  try {
    const r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=' + PLACE.lat + '&longitude=' + PLACE.lon + '&daily=temperature_2m_max,precipitation_sum&timezone=Asia%2FKolkata&forecast_days=7');
    const d = (await r.json()).daily;
    return '\n\nWEATHER, ' + PLACE.town + ', next 7 days (max \u00b0C / rain mm): ' +
      d.time.map((t, i) => t.slice(5) + ' ' + Math.round(d.temperature_2m_max[i]) + '/' + d.precipitation_sum[i]).join(', ') +
      '. Match dishes to it (hot days: coolers, lighter plates; rain: hot, spicy, fried).';
  } catch (e) { return ''; }
}
async function trendPages() {
  const read = async ([label, u]) => {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 12000);
    try {
      const r = await fetch('https://r.jina.ai/' + u, { signal: ac.signal, headers: { 'X-Return-Format': 'text' } });
      if (!r.ok) return '';
      const s = (await r.text()).replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ');
      const at = /trends\.google/.test(u) ? 0 : Math.max(0, s.search(/last updated|updated every|this week|\u0b9f\u0bcd\u0bb0\u0bc6\u0ba3\u0bcd\u0b9f\u0bbf\u0b99\u0bcd/i));
      return '\n\n[' + label + ']\n' + s.slice(at, at + 2500);
    } catch (e) { return ''; } finally { clearTimeout(t); }
  };
  const got = (await Promise.all(TREND_PAGES.map(read))).join('');
  return got ? '\n\nLIVE TREND SOURCES, fetched just now. The Tamil Nadu sources come first and decide relevance: build on what Tamil Nadu is searching and talking about this week (a film release, a match, a festival, the weather, a viral local moment). Use a global format or AI image style only if search shows it is catching on in India or Tamil Nadu, and say so. Ignore items unrelated to food, local culture or entertainment:' + got : '';
}

/* Everything the Content Studio needs without a tool round: the menu, facts
   for the best sellers, saved trend notes, weather and trend pages. */
export async function studioContext(sb, rid, menu) {
  const [top, notes, weather, pages] = await Promise.all([
    sb.rpc('ai_top_dishes', { p_rid: rid, p_days: 30, p_limit: 12 }).catch(() => ({})),
    trendNotes().catch(() => ''), weekWeather().catch(() => ''), trendPages().catch(() => ''),
  ]);
  const best = ((top && top.data) || []).map(r => r.name_en || r.name || r.dish).filter(Boolean);
  let facts = [];
  try { facts = await dishDossier(sb, rid, (best.length ? best : menu).slice(0, 8), false); } catch (e) {}
  return { best, facts, trends: (notes + weather + pages).slice(0, 7000) };
}

/* Creative reference pages for the Content Studio: generic reel formats, food
   photography composition and caption craft. One page per group is read each
   day, rotating by date so consecutive days lean on different sources. */
const CREATIVE_PAGES = {
  reel: [
    ['Otter: Reels ideas for restaurants', 'https://www.tryotter.com/blog/restaurant-tips/instagram-reels-ideas-for-restaurants'],
    ['Surf: 100 Reel ideas for restaurants', 'https://surf.to/resources/100-instagram-reel-ideas-restaurants'],
    ['FlowShorts: food Reels ideas with hooks', 'https://flowshorts.app/instagram-reels-ideas/food'],
    ['Button Up Media: restaurant Reel ideas', 'https://www.buttonupmedia.com/blog/restaurant-reel-ideas-that-get-customers'],
    ['Filmora: trending food Reel ideas', 'https://filmora.wondershare.com/vlog-tips/instagram-food-reel-ideas.html'],
    ['AiGrow: restaurant Reels ideas', 'https://aigrow.me/restaurant-reels-ideas/'],
  ],
  photo: [
    ['Expert Photography: food composition', 'https://expertphotography.com/food-photography-composition'],
    ['Samantha Seeley: composition elements', 'https://www.samanthaseeley.com/compositional-elements-for-food-photography/'],
    ['Recipe Kit: composition tips', 'https://recipekit.com/blogs/our-blog/10-food-photography-composition-tips-for-delicious-photos'],
    ['Regan Baroni: colour and shape', 'https://reganbaroni.com/blog/food-photography/food-photography-composition-tips/'],
    ['Two Loves Studio: composition techniques', 'https://twolovesstudio.com/blog/10-techniques-composition-in-food-photography/'],
    ['Bootstrapped Ventures: creative composition', 'https://bootstrapped.ventures/food-photography-composition/'],
  ],
  caption: [
    ['TouchBistro: restaurant captions', 'https://www.touchbistro.com/blog/restaurant-instagram-captions/'],
    ['Qamarero: witty restaurant captions', 'https://qamarero.com/en/blog/best-restaurant-instagram-captions-150-witty-engaging-ideas/'],
    ['ResDiary: captions by occasion', 'https://resdiary.com/blog/restaurant-captions-for-instagram'],
    ['Skweezer: creative restaurant captions', 'https://skweezer.net/blog/instagram-category/food/restaurant/captions'],
    ['GloriaFood: restaurant post captions', 'https://www.gloriafood.com/restaurant-social-media-post-captions'],
  ],
};
export async function creativeRefs() {
  const day = Math.floor((Date.now() + 5.5 * 3600e3) / 864e5), ck = 'creativeRefs:' + day;
  try { const c = JSON.parse(localStorage.getItem(ck)); if (c && c.text) return c; } catch (e) {}
  const picks = Object.entries(CREATIVE_PAGES).map(([g, list], i) => [g, ...list[(day + i * 2) % list.length]]);
  const read = async ([g, label, u]) => {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 12000);
    try {
      const r = await fetch('https://r.jina.ai/' + u, { signal: ac.signal, headers: { 'X-Return-Format': 'text' } });
      if (!r.ok) return null;
      const s = (await r.text()).replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ');
      const at = Math.max(0, s.search(/\b1\.\s|#1\b|idea|tip|caption/i));
      return { g, label, url: u, body: s.slice(at, at + 1600) };
    } catch (e) { return null; } finally { clearTimeout(t); }
  };
  const got = (await Promise.all(picks.map(read))).filter(Boolean);
  const out = { refs: got.map(({ g, label, url }) => ({ g, label, url })), text: got.map(x => '\n\n[' + x.label + '] (' + x.g + ')\n' + x.body).join('') };
  if (out.text) try { localStorage.setItem(ck, JSON.stringify(out)); } catch (e) {}
  return out;
}

async function groqResearch(key, prompt) {
  if (!key) return { unavailable: true, hint: 'No search engine key is set. Say web research is off.' };
  const res = await fetch(GROQ + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ model: CHAT_SMALL, reasoning_effort: 'low', messages: [{ role: 'user', content: prompt }], tools: [{ type: 'browser_search' }], max_tokens: 2400, temperature: 0.4 }),
  });
  if (!res.ok) return { unavailable: true, hint: 'Web search is busy right now (' + res.status + '). Say so and suggest trying again in a minute.' };
  const m = (((await res.json()).choices || [])[0] || {}).message || {};
  const text = String(m.content || '').trim();
  return text ? { findings: text.slice(0, 5000) } : { empty: true, hint: 'The search came back empty. Say so.' };
}

const byName = Object.fromEntries(TOOLS.map(t => [t.name, t]));

const counterScope = scope => scope === 'counter';

/* The model cannot ask for what it is not offered, so the tool list itself is
   cut rather than the answers being talked out of it afterwards. The execution
   side refuses too, in case a name is carried over from the conversation. */
const wireFor = scope => TOOLS
  .filter(t => counterScope(scope) || !t.counterOnly)
  .map(t => ({
    type: 'function',
    function: { name: t.name, description: t.schema.description, parameters: t.schema.parameters },
  }));

/* Money that survives on a tool otherwise fine to read off a phone: topDishes
   ranks by revenue, sellouts counts lost sales. Outside the counter the
   ranking stays and the rupees go. Menu prices are not in here — a price is
   printed on the card the guest is holding. */
const MONEY = /(^|_)(revenue|sales|amount|amt|takings|turnover|collections?|earnings|income|discounts?|tender|pay|paid|wages?|salary|salaries|payroll|rate|stipend|bonus|ctc|take_home|avg_bill|average_bill|bill_value|ticket_size)($|_)/i;
const BARE_TOTAL = /^(total|net|gross)$/i;

/* A count is a total with one multiplication left in it. Plates sold against
   the menu price is the day's takings by another route, and hours against a
   rate is a salary; both were reachable off the counter while topDishes handed
   out quantities and the menu handed out prices. So off the till the position
   in the list survives and the counts go with the rupees. */
const COUNTS = /^(bills|bill_count|covers)$/i;

const blockedKey = k => MONEY.test(k) || BARE_TOTAL.test(k) || COUNTS.test(k);

function stripMoney(v) {
  if (Array.isArray(v)) return v.map(stripMoney);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) if (!blockedKey(k)) out[k] = stripMoney(v[k]);
    return out;
  }
  return v;
}

/* Stripped of its figures, a ranked list no longer says it was ranked, and a
   model handed an unlabelled list reorders it in the answer. The position is
   the part that is readable off the counter, so it is written in. */
function ranked(v) {
  return Array.isArray(v)
    ? v.map((row, i) => (row && typeof row === 'object' && !Array.isArray(row) ? { rank: i + 1, ...row } : row))
    : v;
}

/* The output guard. Code, not prompt.
 *
 * Cutting the tools stops the figure being read. It does not stop the model
 * reaching a figure some other way and writing it down — adding up what it was
 * given, remembering a number from earlier in the conversation, or simply
 * inventing one under a direct question. A prompt line is a request; this is
 * the last thing between that sentence and the screen.
 *
 * Sentence by sentence, so a legitimate answer is not thrown away with the one
 * clause that broke the rule: "Chicken biryani outsells everything" survives,
 * "that is about ₹42,000 for the week" does not.
 */
const OFF_COUNTER = 'Takings and pay are only readable in the counter app.';

/* A currency figure, in the forms the model actually writes. */
const FIGURE = /(?:\u20b9|\brs\.?|\binr\b)\s?\d|\b\d[\d,.]*\s?(?:rupees|lakhs?|crores?|k)\b|\b(?:\d{1,3}(?:,\d{2,3})+|\d{4,})\b(?!\s*(?:plates?|portions?|orders?|units?|kg|g|l|ml|pcs?|pieces?|customers?|guests?|visits?|votes?|ratings?|reviews?|times?|calls?|hours?|mins?|minutes?))/i;

/* Words that make a figure a takings or pay figure. "Card" is deliberately
   absent: in this house the card is the menu, and a price read off it is fine. */
const TAKINGS =
  /\b(revenue|sales|takings|turnover|collections?|earnings|income|average bill|avg bill|per[- ]bill|discounts?|tender split|salar(?:y|ies)|wages?|payroll|stipend|bonus)\b/i;

/* "Total" on its own is ordinary English — three dishes in total. It only
   counts against a figure standing next to it. */
const LOOSE =
  /\b(?:grand\s+)?(?:total|totals|totall?ed|gross|net)\b[^.!?]{0,28}?(?:\u20b9|\brs\.?|\binr\b)\s?\d|(?:\u20b9|\brs\.?|\binr\b)\s?[\d,.]+[^.!?]{0,28}?\b(?:in\s+)?(?:total|gross|net)\b/i;

/* Spending and stock value are readable; a "total spent ₹…" is not takings. */
const OUTGOING = /\b(expenses?|spent|spend|spending|costs?|costing|supplier|purchases?|bought|wastage|waste|stock value|per kg|per unit)\b/i;

const leaks = s => (TAKINGS.test(s) && FIGURE.test(s)) || (LOOSE.test(s) && !OUTGOING.test(s));

export function guardReply(text, scope) {
  if (counterScope(scope) || !text) return text;

  /* The dictation block is data for the counter, not prose, and splitting it
     into sentences would shred it. Prose is guarded; the fence passes. */
  const at = text.indexOf('```');
  const prose = at === -1 ? text : text.slice(0, at);
  const fence = at === -1 ? '' : text.slice(at);

  const kept = [];
  let cut = 0;
  for (const s of prose.match(/[^.!?\n]+[.!?]*[\n]*/g) || [prose]) {
    if (leaks(s)) cut++;
    else kept.push(s);
  }

  let out = kept.join('').replace(/\n{3,}/g, '\n\n').trim();
  if (cut) out = out ? out + '\n\n' + OFF_COUNTER : OFF_COUNTER;
  return (fence ? out + '\n\n' + fence : out).trim();
}

/* Dictation is offered in both scopes. The admin panel lands a dictated round
   in the same cart behind the same send button the counter uses, so gating the
   instruction on scope only made admin dictation silently impossible. */
export function systemPrompt({ tables, scope }) {
  return `You are the business manager for ${PLACE.restaurantName}, a restaurant in ${PLACE.town}${
    tables ? ` with ${tables} tables` : ''
  }. Currency is INR; write amounts as \u20b9714 or \u20b91,240.

Read the numbers with your tools before answering. Never guess a figure, never
round one into a better story, and never present your own estimate as a reading.
If a figure is unavailable, say which one and stop.

Prices, dish numbers and what is on the card come from the menu tool. Reach for
it before saying you do not have something: a price question is almost never a
sales question.

Whether a dish is off comes from the menu tool; WHY it is off comes from
dishesOff, which words the reason. The menu only knows a dish is unavailable,
so do not conclude from it that no reason was recorded — read dishesOff first.

For trends, marketing ideas, festivals, the local scene or image prompts for
posts, call webResearch; do not say you cannot browse. Pass along its sources.
Asked for post, campaign or content ideas with no trend named, call it with
imagePrompts set anyway: finding the live trend is your job, not the owner's.

Ratings come in three tools: dishRatings has dish stars, averages and vote
counts, serviceRatings has the service stars with trend and breakdown, and
feedbackComments has the words a guest typed. Asked what
anyone said, wrote, complained about or praised, call feedbackComments. Never
say the system stores only stars or keeps no comments — it keeps them, and a
guest quote is quoted verbatim, not paraphrased into a sentiment.
${counterScope(scope) ? '' : `
You are running in the main app, not at the counter. Exactly two things are
withheld here: sales money (revenue, daily or total sales, average bill, bill
counts, discounts, tender split) and staff pay (salary, wage, rate, payroll,
advances). You have no tool for either.

Everything else is yours to read and discuss: plates and quantities sold,
dish rankings, slow movers, ratings and written comments, online reviews and
competitors, stock and wastage, running expenses, staff, attendance, hours
worked and the roster, customers and their visits, waiter calls, campaigns,
dishes off, kitchen timings, busy hours and the menu with its prices. Use the
tools for these freely; never refuse them as restricted.

Do not turn quantities into money — no plates times price, no hours times a
rate — and do not repeat a sales or pay figure from earlier in this
conversation. Asked for takings or for what anyone is paid, say it is only
available in the counter app, and answer the rest of the question.
`}

The live board — who is seated, what is on each open ticket, how long it has
been open, what has gone out — comes from openOrders, not from the menu. Read
it before answering anything about service as it stands, and read it again
rather than trusting a board you saw earlier in the conversation. Tickets are
numbered the way the board numbers them, so "order three" is the third one it
lists back to you.
${counterScope(scope) ? '' : `
Staff close tables through you. Asked to rate a ticket and close it, read the
board first so the dishes you name are the dishes actually on it, say back in
one short sentence what you are about to record, and end with a fenced block on
its own line:

\`\`\`close
{"order":3,"dishes":[{"name":"Chicken Biryani","stars":5},{"name":"Faluda","stars":4}],"service":4}
\`\`\`

order is the board number; use table instead when they named a table. Dish
names exactly as the menu prints them. Spoken positions map in board order —
"five for the first, four for the next, three for the rest" fills the remaining
dishes with the last number given, so every dish on the ticket carries a star
count. service is the rating for the service itself and is omitted when nobody
gave one.

Nothing fires from this block on its own either: the panel shows the ratings for
one press, because closing a ticket takes it off the board and nothing on that
screen can put it back. Never emit it unless closing was actually asked for.
`}

A tool result carrying no_sales_in_window means nothing was sold in that
period: say there is no sales data yet, name no dishes, and do not retry the
tool. Otherwise read the rows you were given and answer from them. Never call
the same tool twice with identical arguments.

You are running without a server, so you can read this restaurant's own numbers
and nothing else. You have no access to Instagram, Facebook, Google reviews,
competitors, weather or search. If asked about any of those, say plainly that it
needs the server build \u2014 do not improvise an answer.

Answer like a manager briefing the owner between services: the number, what it
means, and what you would do. Short paragraphs, no headings, no bullet lists
unless you are naming more than three things. Never open with a restatement of
the question.

Staff also dictate orders to you. When someone is telling you what a table
wants, repeat it back as one short English sentence and then, on its own line at
the very end, a fenced block:

\`\`\`kot
{"table":"7","items":[{"name":"Chicken Biryani","qty":2,"note":"less spicy"}],"steps":["send","authorise","first"]}
\`\`\`

Dish names exactly as the menu prints them, in English, whatever language they
spoke. Omit table if they did not say one.

steps is how far they asked you to take the round, in this order, and you
include only the ones they actually asked for:

  send       put the round on the ticket \u2014 "send it to the kitchen", "punch it"
  authorise  the counter's own check on that ticket \u2014 "authorise it", "approve
             it", "push it to the kitchen". This is the press that puts food on
             the kitchen screen; send on its own only files it for checking.
  first      mark every dish on it cook first \u2014 "rush it", "priority", "cook
             it first"
  hold       park it on the board instead \u2014 "hold it", "wait on it"

Omit steps entirely when they only read out the food. A step nobody asked for is
food cooked without anyone checking it, so never add one to be helpful.

Nothing fires from this block on its own: the counter shows the whole chain for a
human to confirm with one press, because voice mishears a dish name eventually.
Never emit the block for anything that is not an order.`;
}

async function chatCall(base, key, body) {
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try {
      const j = await res.json();
      const e = Array.isArray(j) ? j[0] && j[0].error : j.error;
      msg = (e && e.message) || msg;
    } catch (e) {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/* A round can change engines mid-answer. Groq does not know Gemini's
   extra_content; Gemini 3 rejects a tool call in history without a thought
   signature, so Groq-made calls carry Google's documented skip value. */
const mapCalls = (msgs, f) => msgs.map(m => m.tool_calls ? { ...m, tool_calls: m.tool_calls.map(f) } : m);
const groqChat = (key, body) => chatCall(GROQ, key, {
  ...body, messages: mapCalls(body.messages, ({ extra_content, ...c }) => c),
});

/* Gemini speaks the same request shape through Google's OpenAI-compatible
   endpoint, so the tool wire and the message history cross over unchanged.
   reasoning_effort is Groq's own field and is dropped on the way. */
/* "High demand" 503s hit one Gemini model at a time; the lite model sits on a
   separate pool. Try flash, then lite, then flash once more after a pause. */
async function geminiChat(key, body) {
  let last;
  for (const [model, wait] of [[GEMINI_CHAT, 0], ['gemini-flash-lite-latest', 0], [GEMINI_CHAT, 4000], ['gemini-flash-lite-latest', 3000]]) {
    if (wait) await new Promise(r => setTimeout(r, wait));
    try { return await geminiOnce(key, body, model); }
    catch (e) { last = e; if (e.status !== 503 && e.status !== 429 && e.status !== 500) throw e; }
  }
  throw last;
}

function geminiOnce(key, body, model) {
  const { reasoning_effort, max_tokens, ...rest } = body;
  /* Gemini 3 thinks before it answers and bills the thought against
     max_tokens, so a ceiling sized for Groq returns an empty message with
     finish_reason 'length'. Low effort plus more room; the tool loop needs a
     short answer, not a long deliberation. */
  return chatCall(GEMINI, key, {
    ...rest,
    messages: mapCalls(rest.messages, c => c.extra_content ? c : { ...c, extra_content: { google: { thought_signature: 'skip_thought_signature_validator' } } }),
    model,
    reasoning_effort: 'low',
    max_tokens: Math.max(max_tokens || 0, 2400),
  });
}

/* Three rungs, tried in order: the big Groq model, the small one, then Gemini
   on its separate quota. Only a rate limit or an overload steps down — a bad
   key or a bad request throws, because retrying it changes nothing.

   Stateless on purpose: nothing remembers the failure, so the step back up to
   the big model needs no timer and no counter. */
async function chatWithFallback(key, body, geminiKey) {
  const busy = e => e.status === 429 || e.status === 413 || e.status === 503;
  /* Groq's free per-minute token cap trips on the second tool round (system
     prompt + tools + results) and says "try again in 6.2s". Waiting that out
     beats handing the answer to Gemini while Gemini is also overloaded. */
  const waitFor = e => { const m = /try again in (?:(\d+)m)?([\d.]+)s/i.exec(e.message || ''); return m ? (Number(m[1] || 0) * 60 + Number(m[2])) * 1000 : 0; };
  const groq = async model => {
    try { return await groqChat(key, { ...body, model, reasoning_effort: EFFORT }); }
    catch (e) {
      const ms = waitFor(e);
      if (!busy(e) || !ms || ms > 20000) throw e;
      await new Promise(r => setTimeout(r, ms + 300));
      return groqChat(key, { ...body, model, reasoning_effort: EFFORT });
    }
  };
  try {
    return await groq(CHAT);
  } catch (e) {
    if (!busy(e)) throw e;
    try {
      return await groq(CHAT_SMALL);
    } catch (e2) {
      if (!geminiKey || !busy(e2)) return groq(NATIVE);
      /* Last rung: Qwen on Groq has its own daily quota, so it is often still
         free when both gpt-oss models and every Gemini pool are spent. */
      try { return await geminiChat(geminiKey, body); }
      catch (e3) { if (!busy(e3) && e3.status !== 500) throw e3; return groq(NATIVE); }
    }
  }
}

/* One tool-free completion for long creative JSON (Content Studio). Gemini goes
   first: its free per-minute budget fits the long brief that trips Groq's 8k
   cap, and it writes the long reply without being cut off. Groq is the fallback. */
export async function creativeChat(key, geminiKey, system, prompt) {
  const messages = [{ role: 'system', content: system }, { role: 'user', content: prompt }];
  const pick = j => (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  let last;
  if (geminiKey) try { const t = pick(await geminiChat(geminiKey, { messages, max_tokens: 16000, temperature: 0.9 })); if (t) return t; } catch (e) { last = e; }
  for (const model of [CHAT, CHAT_SMALL]) {
    if (!key) break;
    try { const t = pick(await groqChat(key, { model, messages, max_tokens: 4000, temperature: 0.9, reasoning_effort: 'low' })); if (t) return t; } catch (e) { last = e; }
  }
  throw last || new Error('no reply');
}

/**
 * Run the tool loop in the browser.
 *
 * sb   — the app's authenticated Supabase client (db.remote.sb)
 * rid  — restaurant uuid (db.remote.rid)
 * onPhase — called with 'thinking' | a tool name, for the status line
 */
export async function runDirect({ key, geminiKey, sb, rid, system, messages, onPhase, scope, ctx, maxSteps = 6 }) {
  const msgs = [{ role: 'system', content: system }, ...messages];

  for (let step = 0; step < maxSteps; step++) {
    onPhase && onPhase(step === 0 ? 'thinking' : 'reading');

    const json = await chatWithFallback(key, {
      messages: msgs,
      tools: wireFor(scope),
      tool_choice: 'auto',
      temperature: 0.4,
      max_tokens: 1400,
    }, geminiKey);

    const m = (json.choices && json.choices[0] && json.choices[0].message) || {};
    const calls = m.tool_calls || [];

    if (!calls.length) return guardReply(String(m.content || '').trim(), scope);

    msgs.push({ role: 'assistant', content: m.content || null, tool_calls: calls });

    for (const call of calls) {
      const spec = byName[call.function.name];
      onPhase && onPhase(call.function.name);

      if (!spec) {
        msgs.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: 'no such tool' }) });
        continue;
      }

      /* Named from earlier in the conversation rather than from the wire. The
         refusal is a tool result, not a throw, so the answer continues. */
      if (spec.counterOnly && !counterScope(scope)) {
        msgs.push({
          role: 'tool', tool_call_id: call.id,
          content: JSON.stringify({
            error: 'counter_only',
            hint: 'Takings and pay are only readable in the counter app. Say so and do not estimate the figure.',
          }),
        });
        continue;
      }

      let args = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch (e) {}

      let payload;
      try {
        const { data, error } = spec.run
          ? { data: await spec.run(sb, rid, args, { ...ctx, groqKey: key }), error: null }
          : await sb.rpc(spec.rpc, { p_rid: rid, ...spec.args(args) });
        /* Handed back rather than thrown: the model can say "that is not
           available" and carry on, where a throw ends the whole answer. */
        payload = error
          ? { error: error.message, hint: 'This figure is unavailable. Do not guess it.' }
          : data ?? { empty: true, hint: 'No data in this window yet.' };
      } catch (e) {
        payload = { error: String(e.message || e), hint: 'This figure is unavailable. Do not guess it.' };
      }

      /* The menu keeps its prices; everything else loses its rupees and its
         counts off the counter, so a blocked total cannot be rebuilt from a
         tool that was allowed through. What is left of a ranked list is the
         ranking, labelled as one. */
      if (!counterScope(scope) && spec.rpc) {
        payload = stripMoney(payload);
        if (spec.ranked) payload = ranked(payload);
      }

      msgs.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(payload) });
    }
  }

  /* Out of steps. Ask for the answer with the tools taken away, so the last
     word is a reply rather than a silence. */
  const last = await chatWithFallback(key, {
    messages: msgs.concat([
      { role: 'user', content: 'Answer now from what you have read. Do not call any more tools.' },
    ]),
    temperature: 0.3,
    max_tokens: 900,
  }, geminiKey);
  return guardReply(String(
    (((last.choices || [])[0] || {}).message || {}).content || 'I could not finish that one.',
  ).trim(), scope);
}

/* ---- voice ----------------------------------------------------------------
 *
 * Gemini is the ear. It hears Tamil, Telugu and Indian-accented English, tells
 * us which one it was, and hands back English for the tool loop to reason in.
 * Whisper on Groq is the fallback: same output shape, minus the language.
 *
 * Whisper alone could not say what was spoken, so the reply language came from
 * whatever the mic button was set to. Gemini reports it, so the answer comes
 * back in the language the floor actually used.
 */

const LISTEN = `A restaurant staff member is speaking to the counter system, in
Tamil, Telugu, or English with an Indian accent. Identify the language actually
spoken and give the meaning in English.

Dish names stay as spoken — biryani, faluda, porotta, parotta are names, not
words to translate. Numbers are quantities. If the audio is unclear, return your
best reading rather than nothing; a human confirms it on screen.`;

const HEARD_SCHEMA = {
  type: 'OBJECT',
  properties: { lang: { type: 'STRING', enum: ['en', 'ta', 'te'] }, english: { type: 'STRING' } },
  required: ['lang', 'english'],
};

function b64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

async function hearGemini(key, blob) {
  const res = await fetch(
    GEMINI_NATIVE + '/models/' + GEMINI_CHAT + ':generateContent?key=' + encodeURIComponent(key),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { inline_data: { mime_type: blob.type || 'audio/webm', data: await b64(blob) } },
              { text: LISTEN },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: HEARD_SCHEMA,
          temperature: 0.2,
        },
      }),
    },
  );
  if (!res.ok) {
    const err = new Error(await res.text().catch(() => 'HTTP ' + res.status));
    err.status = res.status;
    throw err;
  }
  const j = await res.json();
  const txt = (((j.candidates || [])[0] || {}).content || {}).parts;
  const out = JSON.parse((txt && txt[0] && txt[0].text) || '{}');
  const english = String(out.english || '').trim();
  if (!english) throw new Error('nothing heard');
  return { text: english, lang: out.lang || 'und', via: 'gemini' };
}

async function hearWhisper(key, blob) {
  const form = new FormData();
  form.append('file', blob, 'audio.webm');
  form.append('model', 'whisper-large-v3');
  // /translations, not /transcriptions: this leg exists to produce English.
  const res = await fetch(GROQ + '/audio/translations', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + key },
    body: form,
  });
  if (!res.ok) {
    const err = new Error(await res.text().catch(() => 'HTTP ' + res.status));
    err.status = res.status;
    throw err;
  }
  const { text } = await res.json();
  /* Whisper does not report the source language on this endpoint, so 'und'
     sends the caller back to the mic button's own setting. */
  return { text: String(text || '').trim(), lang: 'und', via: 'whisper' };
}

/** Returns { text, lang, via }. Gemini first, Whisper when it cannot answer. */
export async function hear(key, blob, geminiKey) {
  if (geminiKey) {
    try {
      return await hearGemini(geminiKey, blob);
    } catch (e) {
      if (!key) throw e;
    }
  }
  return hearWhisper(key, blob);
}

const LANG_NAME = { ta: 'Tamil', te: 'Telugu' };

/* Spoken register, not written. A Tamil speaker at a counter says "chicken
   biryani" and "parcel" in English inside a Tamil sentence; translating those
   produces words nobody orders by — the earlier model offered "கோழி பிரியாணி",
   literally fowl biryani, which is correct and useless. */
function speakPrompt(name, text) {
  return `Put this into natural spoken ${name} — the mixed everyday speech staff
actually use at a counter, not formal written ${name}.

Write in ${name} script throughout, including the English words. Dish names,
menu words and counter vocabulary keep their English wording, spelled in
${name} letters: chicken biryani, parcel, bill, table, half, full. Do not
replace them with native equivalents — nobody orders a fowl biryani. Numbers
and currency amounts stay as digits.

Return only the ${name}, nothing else.

${text}`;
}

/* Gemini first on the way out, as on the way in. It writes better Tamil and
   Telugu than Qwen does — correct script, the mixed counter register, and it
   does not quietly drop the English dish names. Qwen stays as the fallback:
   it is a fifth of the tokens, so when Gemini's quota is gone the reply is
   rougher but still in the right language. */
export async function intoLanguage(key, text, lang, geminiKey) {
  const name = LANG_NAME[lang];
  if (!name || !text) return text;
  const body = { temperature: 0.3, max_tokens: 700, messages: [{ role: 'user', content: speakPrompt(name, text) }] };
  const pick = j => String((((j.choices || [])[0] || {}).message || {}).content || '').trim();
  let out = '';
  if (geminiKey) {
    try {
      out = pick(await geminiChat(geminiKey, body));
    } catch (e) {
      if (!key) throw e;
    }
  }
  if (!out && key) {
    try {
      out = pick(await groqChat(key, { ...body, model: NATIVE }));
    } catch (e) {
      if (!geminiKey) throw e;
    }
  }
  return out || text;
}

/* ---- speaking aloud -------------------------------------------------------
 *
 * The browser's own speechSynthesis has no Tamil or Telugu voice on most of
 * the devices this runs on: iOS reads the script with an English voice and it
 * comes out as noise, Android often refuses outright. Gemini's TTS models
 * speak both properly, so native replies are generated as audio here and the
 * browser only plays the file. English stays on speechSynthesis — it is free,
 * instant, and good enough.
 *
 * No 'latest' alias exists for the TTS models, so this one is pinned and will
 * need changing when Google retires it; the caller falls back to the browser
 * voice rather than going silent if it 404s.
 */
const GEMINI_TTS = 'gemini-2.5-flash-preview-tts';
/* Kore is the steady, unhurried one. A counter reply is information, not
   performance, and the bright voices oversell a sales figure. */
const TTS_VOICE = 'Kore';

function wavFromPcm(bytes, rate) {
  const head = new ArrayBuffer(44);
  const v = new DataView(head);
  const tag = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  tag(0, 'RIFF'); v.setUint32(4, 36 + bytes.length, true); tag(8, 'WAVE');
  tag(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  tag(36, 'data'); v.setUint32(40, bytes.length, true);
  return new Blob([head, bytes], { type: 'audio/wav' });
}

function unb64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Gemini reads the reply aloud. Returns a WAV Blob, or null when there is no
 * key — the caller then uses the browser voice.
 *
 * text should already be in the target language: this leg is a voice, not a
 * translator, and asking it to do both makes it paraphrase.
 */
export async function nativeAudio(geminiKey, text, lang) {
  if (!geminiKey || !text) return null;
  const name = LANG_NAME[lang];
  const say = name
    ? `Read this out in ${name}, calmly and at an even pace, the way a counter assistant speaks to the owner:\n\n${text}`
    : `Read this out calmly and at an even pace:\n\n${text}`;

  const res = await fetch(
    GEMINI_NATIVE + '/models/' + GEMINI_TTS + ':generateContent?key=' + encodeURIComponent(geminiKey),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: say }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: TTS_VOICE } } },
        },
      }),
    },
  );
  if (!res.ok) {
    const err = new Error(await res.text().catch(() => 'HTTP ' + res.status));
    err.status = res.status;
    throw err;
  }
  const j = await res.json();
  const part = ((((j.candidates || [])[0] || {}).content || {}).parts || [])
    .find(p => p.inlineData || p.inline_data);
  const inline = part && (part.inlineData || part.inline_data);
  if (!inline || !inline.data) throw new Error('no audio returned');

  /* Raw signed 16-bit PCM, 24 kHz by default — no container, so no <audio>
     will touch it until a WAV header is in front. The rate is declared in the
     mime type; read it rather than assuming, in case a model ships at 16 kHz. */
  const mime = inline.mimeType || inline.mime_type || '';
  const rate = Number((mime.match(/rate=(\d+)/) || [])[1]) || 24000;
  return wavFromPcm(unb64(inline.data), rate);
}
