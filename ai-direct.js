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
    run: async (sb, rid, a, ctx) => {
      const snap = ctx && typeof ctx.floor === 'function' ? ctx.floor() : null;
      if (snap) return floorRead(snap);
      /* Screens without the board in memory (the counter's AI desks) read the
         open tickets from the database instead of saying they cannot see any. */
      const db = await floorFromDb(sb, rid, ctx);
      if (db) return floorRead(db);
      return { unavailable: true, hint: 'The live board is not readable from this screen. Say so rather than guessing what is open.' };
    },
    schema: {
      description:
        'The live board as it stands. Returns seating (tables in the room, how many are occupied and free, and which ones — already counted, read these figures as given and never recount), clearingNext (seated tables ranked by how soon they should free up, with the reason), and every open ticket with its board number, table or parcel label, when it was seated and for how long, each dish with quantity, when it was ordered, how many portions have gone out and when the last one went out, and what is still pending. This is the tool for anything about service right now — how many tables are occupied or free, which table will clear next, what a table ordered, what is still to go out, which ticket has been open longest — and the tool to read before acting on a ticket by number. It is a live read: call it again for every such question rather than trusting an earlier answer.',
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
    /* The expert library: articles from trusted cooking and restaurant blogs,
       downloaded twice a day by the kb edge function. One indexed query, so a
       voice answer does not wait on live browsing. */
    name: 'expertTips',
    run: async (sb, rid, a) => {
      const q = String(a.query || '').trim();
      if (!q) return { error: 'query required' };
      const topic = ['cooking', 'service', 'operations', 'cost', 'sales', 'staff'].includes(a.topic) ? a.topic : null;
      let { data, error } = await sb.rpc('kb_search', { p_q: q, p_topic: topic, p_limit: clamp(a.limit, 1, 8, 5) });
      if (error) return unreadable(error);
      if (!(data || []).length && topic) ({ data } = await sb.rpc('kb_search', { p_q: q, p_topic: null, p_limit: clamp(a.limit, 1, 8, 5) }));
      if (!(data || []).length) return { empty: true, hint: 'Nothing in the saved expert library matches. Say so in one line, then answer only from this restaurant\'s own data; do not fall back on generic advice.' };
      return { passages: data.map(r => ({ source: r.source, title: r.title, date: r.published, url: r.url, text: r.passage })) };
    },
    schema: {
      description: 'Saved expert library: passages from trusted cooking and restaurant-management blogs (recipes and technique, service, operations, food cost, sales and marketing), refreshed automatically. Use for any request to improve a dish, cook faster, cut cost, raise sales, improve service, or for tips and tricks. Search with the specific dish, ingredient or problem words.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'specific keywords: dish, ingredient, technique or problem, e.g. "biryani rice sticky dum" or "food cost portion waste"' },
          topic: { type: 'string', enum: ['cooking', 'service', 'operations', 'cost', 'sales', 'staff'], description: 'optional filter' },
          limit: { type: 'integer', description: 'default 5' },
        },
        required: ['query'],
      },
    },
  },
  {
    /* AI Engine screens as the counter last computed them. Off the counter the
       rupee fields go; portions, percentages and festival patterns stay. */
    name: 'aiEngine',
    run: async (sb, rid, a, ctx) => {
      const want = ['menuIntel', 'insights'].includes(a.section) ? [a.section] : ['menuIntel', 'insights'];
      const { data, error } = await sb.from('ai_engine_snapshot').select('section,body,at').eq('restaurant_id', rid).in('section', want);
      if (error) return unreadable(error);
      if (!(data || []).length) return { empty: true, hint: 'The AI Engine has not published yet. It publishes when the counter app is open. Say so.' };
      const out = {};
      data.forEach(r => { out[r.section] = { computedAt: r.at, ...(ctx && ctx.scope === 'counter' ? r.body : dropSold(stripMoney(r.body))) }; });
      return out;
    },
    schema: {
      description: 'The AI Engine sections. menuIntel (shown as AI Insights): prep forecast per dish for the next 7 days with veg/non-veg split and stock shortfalls, festival sales patterns (veg and non-veg lift before, on and after each festival, next dates), dish performance (gaining and dipping dishes with reasons), and logged recipe tweaks, posts, staff pushes, price changes and offers with their measured effect. insights (shown as AI Planner): weather for the week, upcoming events and holidays, the content plan, recent posts and campaigns.',
      parameters: { type: 'object', properties: { section: { type: 'string', enum: ['menuIntel', 'insights'], description: 'omit for both' } } },
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
      const today = localDay();
      const [st, at, sh] = await Promise.all([
        staffWithJobs(sb, rid),
        sb.from('attendance').select('staff_id,day,in_at,out_at,break_mins,note').eq('restaurant_id', rid).gte('day', since).order('in_at', { ascending: false }).limit(400),
        sb.from('shifts').select('staff_id,day,starts_at,ends_at,note').eq('restaurant_id', rid).gte('day', today).lte('day', ahead).order('starts_at').limit(200),
      ]);
      if (st.error) return unreadable(st.error);
      const who = Object.fromEntries((st.data || []).map(p => [p.id, p.name]));
      const hrs = r => r.out_at ? Math.round(((new Date(r.out_at) - new Date(r.in_at)) / 36e5 - (r.break_mins || 0) / 60) * 10) / 10 : undefined;
      return {
        staff: (st.data || []).map(p => ({ name: p.name, job: p.job, appAccess: p.role, active: p.active })),
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
    /* Bulk cooking: the trays the kitchen tab starts in the guest app. Read by
       both screens, but no assistant had a tool pointed at the table, so "how
       much biryani is left in the pot" had nothing to answer from. */
    name: 'bulkCooking',
    run: async (sb, rid, a) => {
      const days = clamp(a.days, 1, 30, 1);
      const since = new Date(Date.now() - days * 864e5).toISOString();
      const { data, error } = await sb.from('batches')
        .select('id,qty,used,mins,started_at,ready_at,dishes(name_en)')
        .eq('restaurant_id', rid).gte('started_at', since).order('started_at', { ascending: false }).limit(400);
      if (error) {
        if (/does not exist|could not find/i.test(error.message || '')) return { unavailable: true, hint: 'Bulk cooking is not shared with this screen yet (bulk-batches.sql not run). Say so.' };
        return unreadable(error);
      }
      const now = Date.now();
      const trays = (data || []).map(b => {
        const start = Date.parse(b.started_at), readyAt = b.ready_at ? Date.parse(b.ready_at) : start + (b.mins || 0) * 6e4;
        const left = Math.max(0, (b.qty || 0) - (b.used || 0));
        return {
          dish: (b.dishes && b.dishes.name_en) || 'Dish no longer on the menu',
          portions: b.qty, used: b.used || 0, left,
          state: left === 0 ? 'finished' : readyAt <= now ? 'ready' : 'cooking',
          started: clock(b.started_at), startedMinsAgo: minsAgo(b.started_at),
          readyInMins: readyAt > now ? Math.round((readyAt - now) / 6e4) : undefined,
          cookMins: b.mins || undefined,
        };
      });
      if (!trays.length) return { empty: true, hint: 'No bulk trays were started in the last ' + days + (days === 1 ? ' day' : ' days') + '.' };
      const byDish = {};
      trays.forEach(r => {
        const d = byDish[r.dish] = byDish[r.dish] || { dish: r.dish, trays: 0, portionsCooked: 0, portionsUsed: 0, portionsLeft: 0, readyNow: 0, cookingNow: 0 };
        d.trays++; d.portionsCooked += r.portions || 0; d.portionsUsed += r.used; d.portionsLeft += r.left;
        if (r.state === 'ready') d.readyNow += r.left;
        if (r.state === 'cooking') d.cookingNow += r.left;
      });
      return {
        days,
        standingReadyNow: Object.values(byDish).filter(d => d.readyNow).map(d => ({ dish: d.dish, portions: d.readyNow })),
        onTheRangeNow: trays.filter(r => r.state === 'cooking').map(r => ({ dish: r.dish, portions: r.left, readyInMins: r.readyInMins })),
        byDish: Object.values(byDish).sort((x, y) => y.portionsCooked - x.portionsCooked),
        trays: trays.slice(0, 60),
      };
    },
    schema: {
      description: 'Bulk cooking: the trays and pots the kitchen cooks ahead (biryani, gravies). What is standing ready right now and how many portions, what is still on the range and when it will be ready, and per dish how many trays and portions were cooked, used and are left over. Use for anything about bulk orders, bulk cooking, trays, pots, batches, how much of a dish is left or ready, or leftover portions.',
      parameters: { type: 'object', properties: { days: { type: 'integer', description: 'lookback, default 1 (today)' } } },
    },
  },
  {
    /* Per station, not per stage. kitchenBottlenecks answers "which stage is
       slow"; the owner asks "is the tandoor slow", which is the station. */
    name: 'kitchenStations',
    run: async (sb, rid, a) => {
      const days = clamp(a.days, 1, 60, 1);
      const since = new Date(Date.now() - days * 864e5).toISOString();
      const [st, kt] = await Promise.all([
        sb.from('stations').select('id,name,sort').eq('restaurant_id', rid).order('sort'),
        sb.from('kots').select('id,station_id,state,created_at,prep_at,served_at,kot_items(qty)')
          .eq('restaurant_id', rid).gte('created_at', since).neq('state', 'void').limit(4000),
      ]);
      if (st.error) return unreadable(st.error);
      if (kt.error) return unreadable(kt.error);
      const name = Object.fromEntries((st.data || []).map(s => [s.id, s.name]));
      const per = {};
      (kt.data || []).forEach(k => {
        const key = k.station_id || 'none';
        const p = per[key] = per[key] || { station: name[k.station_id] || 'Unrouted', tickets: 0, plates: 0, served: 0, serve: [], start: [], openNow: 0, oldestOpenMins: 0, over25: 0 };
        p.tickets++;
        p.plates += (k.kot_items || []).reduce((n, i) => n + (i.qty || 0), 0);
        if (k.served_at) { const m = (Date.parse(k.served_at) - Date.parse(k.created_at)) / 6e4; p.served++; p.serve.push(m); if (m > 25) p.over25++; }
        else { p.openNow++; p.oldestOpenMins = Math.max(p.oldestOpenMins, minsAgo(k.created_at) || 0); }
        if (k.prep_at) p.start.push((Date.parse(k.prep_at) - Date.parse(k.created_at)) / 6e4);
      });
      (st.data || []).forEach(s => { if (!per[s.id]) per[s.id] = { station: s.name, tickets: 0, plates: 0, served: 0, serve: [], start: [], openNow: 0, oldestOpenMins: 0, over25: 0 }; });
      const rows = Object.values(per).map(p => ({
        station: p.station, tickets: p.tickets, plates: p.plates, ticketsServed: p.served,
        avgMinsToServe: avg(p.serve), medianMinsToServe: pctl(p.serve, .5), p90MinsToServe: pctl(p.serve, .9),
        avgMinsBeforeCookingStarted: avg(p.start), ticketsOver25Mins: p.over25,
        openNow: p.openNow, oldestOpenMins: p.openNow ? p.oldestOpenMins : undefined,
      })).sort((x, y) => (y.avgMinsToServe || 0) - (x.avgMinsToServe || 0));
      if (!rows.some(r => r.tickets)) return { days, stations: rows, empty: true, hint: 'No kitchen tickets in this window. Say so; do not invent timings.' };
      return { days, window: days === 1 ? 'last 24 hours' : 'last ' + days + ' days', stations: rows, note: 'Ranked slowest first by average minutes from ticket to served.' };
    },
    schema: {
      description: 'Each kitchen station (tandoor, biryani, grill, drinks, etc.) side by side: tickets and plates handled, average, median and 90th-percentile minutes from ticket to served, how long tickets waited before cooking started, tickets over 25 minutes, and what is open on each station right now with the oldest wait. Use for individual kitchen station performance, which station is slow or overloaded, and station comparisons. kitchenBottlenecks is by prep stage; this is by station.',
      parameters: { type: 'object', properties: { days: { type: 'integer', description: 'default 1 (today)' } } },
    },
  },
  {
    name: 'staffPerformance',
    run: async (sb, rid, a, ctx) => {
      const days = clamp(a.days, 1, 60, 7);
      const since = new Date(Date.now() - days * 864e5).toISOString();
      const till = ctx && ctx.scope === 'counter';
      const [st, kt, ev, bl, at] = await Promise.all([
        staffWithJobs(sb, rid),
        sb.from('kots').select('staff_id,created_at,served_at,kot_items(qty)').eq('restaurant_id', rid).gte('created_at', since).neq('state', 'void').limit(4000),
        sb.from('kot_item_events').select('staff_id,mins,at,kot_items!inner(kots!inner(restaurant_id))').eq('kot_items.kots.restaurant_id', rid).gte('at', since).limit(5000),
        sb.from('bills').select('staff_id,state,total,settled_at').eq('restaurant_id', rid).gte('created_at', since).in('state', ['printed', 'settled']).limit(4000),
        sb.from('attendance').select('staff_id,day,in_at,out_at,break_mins').eq('restaurant_id', rid).gte('in_at', since).limit(2000),
      ]);
      if (st.error) return unreadable(st.error);
      const p = {};
      const row = id => p[id] = p[id] || { tickets: 0, plates: 0, serve: [], moves: 0, moveMins: [], bills: 0, billed: 0, hours: 0, days: new Set() };
      (kt.data || []).forEach(k => { if (!k.staff_id) return; const r = row(k.staff_id); r.tickets++; r.plates += (k.kot_items || []).reduce((n, i) => n + (i.qty || 0), 0); if (k.served_at) r.serve.push((Date.parse(k.served_at) - Date.parse(k.created_at)) / 6e4); });
      (ev.error ? [] : ev.data || []).forEach(e => { if (!e.staff_id) return; const r = row(e.staff_id); r.moves++; if (e.mins != null) r.moveMins.push(Number(e.mins)); });
      (bl.error ? [] : bl.data || []).forEach(b => { if (!b.staff_id) return; const r = row(b.staff_id); r.bills++; r.billed += Number(b.total) || 0; });
      (at.error ? [] : at.data || []).forEach(x => { const r = row(x.staff_id); r.hours += stintHours(x); r.days.add(x.day); });
      const people = (st.data || []).filter(s => s.active || p[s.id]).map(s => {
        const r = p[s.id] || row(s.id);
        const hrs = Math.round(r.hours * 10) / 10;
        return {
          name: s.name, job: s.job, appAccess: s.role, active: s.active,
          daysWorked: r.days.size, hoursWorked: hrs,
          ticketsPunched: r.tickets, platesPunched: r.plates,
          avgMinsTheirTicketsTookToServe: avg(r.serve),
          kitchenStepsHandled: r.moves || undefined, avgMinsPerKitchenStep: avg(r.moveMins),
          billsHandled: r.bills,
          platesPerHourWorked: hrs ? Math.round(r.plates / hrs * 10) / 10 : undefined,
          ...(till ? { billedValue: Math.round(r.billed) } : {}),
        };
      }).sort((x, y) => y.platesPunched - x.platesPunched || y.hoursWorked - x.hoursWorked);
      return {
        days, staff: people,
        note: 'Tickets punched are orders a person keyed in; kitchen steps are prep moves a cook pressed on the kitchen screen; bills handled are bills they printed or settled. Guest ratings are per table, not per person, so there is no per-person rating.' + (till ? '' : ' Bill values are only readable at the counter.'),
      };
    },
    schema: {
      description: 'Individual staff performance for a period: per person days and hours worked, orders (tickets) and plates they punched, how long their tickets took to serve, kitchen prep steps a cook handled and their average minutes, bills they handled, plates per hour worked' + ' (and at the counter, the value they billed). Use for who performed best, who is slow, comparing waiters or cooks, productivity.',
      parameters: { type: 'object', properties: { days: { type: 'integer', description: 'default 7' } } },
    },
  },
  {
    /* Attendance against the day that was planned: rostered shift if there
       is one, the house's overtime threshold if there is not. Wages follow
       payroll_summary exactly, so this and the wage sheet cannot disagree. */
    name: 'attendanceHours',
    run: async (sb, rid, a, ctx) => {
      const till = ctx && ctx.scope === 'counter';
      const today = localDay();
      let from = /^\d{4}-\d{2}-\d{2}$/.test(a.from || '') ? a.from : '';
      let to = /^\d{4}-\d{2}-\d{2}$/.test(a.to || '') ? a.to : today;
      if (!from) from = a.days ? localDay(new Date(Date.now() - (clamp(a.days, 1, 92, 7) - 1) * 864e5)) : today.slice(0, 8) + '01';
      const [house, st, at, sh, pay] = await Promise.all([
        sb.from('restaurants').select('*').eq('id', rid).maybeSingle(),
        staffWithJobs(sb, rid),
        sb.from('attendance').select('staff_id,day,in_at,out_at,break_mins,note').eq('restaurant_id', rid).gte('day', from).lte('day', to).order('in_at').limit(3000),
        sb.from('shifts').select('staff_id,day,starts_at,ends_at').eq('restaurant_id', rid).gte('day', from).lte('day', to).limit(3000),
        till ? sb.rpc('payroll_summary', { p_rid: rid, p_from: from, p_to: to }) : Promise.resolve({ data: null }),
      ]);
      if (st.error) return unreadable(st.error);
      if (at.error) return unreadable(at.error);
      const h = house.data || {};
      const stdDay = Number(h.ot_after_hours) || 9;
      const brk = houseBreak(ctx);
      const name = Object.fromEntries((st.data || []).map(s => [s.id, s.name]));
      const job = Object.fromEntries((st.data || []).map(s => [s.id, s.job]));
      const plan = {};
      (sh.error ? [] : sh.data || []).forEach(s => { const k = s.staff_id + '|' + s.day; (plan[k] = plan[k] || []).push(s); });
      const worked = {};
      (at.data || []).forEach(r => { const k = r.staff_id + '|' + r.day; (worked[k] = worked[k] || []).push(r); });
      const keys = new Set([...Object.keys(plan), ...Object.keys(worked)]);
      const days = [];
      keys.forEach(k => {
        const [sid, day] = k.split('|');
        const ws = worked[k] || [], ps = plan[k] || [];
        /* Every shift carries the standard break. A clock-out that recorded no
           break has the standard one taken off; a longer one is kept and flagged. */
        const took = ws.reduce((n, r) => n + (r.break_mins || 0), 0);
        const raw = ws.reduce((n, r) => n + stintHours(r), 0);
        const assumed = ws.length && !took && raw > 4 ? brk : 0;
        const hrs = Math.max(0, raw - assumed / 60);
        const planned = ps.reduce((n, s) => n + (Date.parse(s.ends_at) - Date.parse(s.starts_at)) / 36e5, 0);
        const expect = Math.max(0, (ps.length ? planned : stdDay) - brk / 60);
        const still = ws.some(r => !r.out_at);
        const firstIn = ws.length ? ws[0].in_at : null, lastOut = ws.length && !still ? ws[ws.length - 1].out_at : null;
        const win = houseWindow(ctx, h, day);
        const shiftStart = ps.length ? Date.parse(ps.map(s => s.starts_at).sort()[0]) : win.open, shiftEnd = ps.length ? Date.parse(ps.map(s => s.ends_at).sort().slice(-1)[0]) : win.close;
        const late = firstIn ? Math.round((Date.parse(firstIn) - shiftStart) / 6e4) : 0;
        const early = lastOut ? Math.round((shiftEnd - Date.parse(lastOut)) / 6e4) : 0;
        const r1 = x => Math.round(x * 100) / 100;
        days.push({
          staffId: sid, name: name[sid] || 'Unknown', job: job[sid], day,
          lateMeasuredFrom: ps.length ? 'rostered shift start' : 'opening time',
          clockedIn: clock(firstIn), clockedOut: still ? 'still clocked in' : clock(lastOut),
          breakMins: took || assumed || undefined,
          breakNote: assumed ? 'standard ' + brk + '-min break taken off (none recorded)' : took > brk ? 'break ran ' + (took - brk) + ' min over the ' + brk + '-min allowance' : undefined,
          hoursWorked: r1(hrs), expectedHours: r1(expect), expectedFrom: ps.length ? 'rostered shift' : 'standard ' + stdDay + '-hour day',
          extraHours: still ? undefined : r1(Math.max(0, hrs - expect)),
          shortHours: still ? undefined : r1(Math.max(0, expect - hrs)),
          absent: !ws.length && ps.length ? true : undefined,
          lateMins: late > 5 ? late : undefined, leftEarlyMins: early > 5 ? early : undefined,
        });
      });
      days.sort((x, y) => x.day.localeCompare(y.day) || x.name.localeCompare(y.name));
      const payRows = Object.fromEntries(((pay && pay.data && pay.data.rows) || []).map(r => [r.staff_id, r]));
      const totals = Object.values(days.reduce((m, d) => {
        const t = m[d.staffId] = m[d.staffId] || { name: d.name, job: d.job, daysWorked: 0, daysAbsent: 0, hoursWorked: 0, expectedHours: 0, extraHours: 0, shortHours: 0, lateDays: 0, clockedInNow: false };
        if (d.absent) t.daysAbsent++; else t.daysWorked++;
        t.hoursWorked += d.hoursWorked; t.expectedHours += d.expectedHours;
        t.extraHours += d.extraHours || 0; t.shortHours += d.shortHours || 0;
        if (d.lateMins) t.lateDays++;
        if (d.clockedOut === 'still clocked in') t.clockedInNow = true;
        t.id = d.staffId;
        return m;
      }, {})).map(t => {
        const r2 = x => Math.round(x * 100) / 100;
        const out = { name: t.name, job: t.job, daysWorked: t.daysWorked, daysAbsent: t.daysAbsent || undefined, hoursWorked: r2(t.hoursWorked), expectedHours: r2(t.expectedHours), extraHours: r2(t.extraHours), shortHours: r2(t.shortHours), netHours: r2(t.extraHours - t.shortHours), lateDays: t.lateDays || undefined, clockedInNow: t.clockedInNow || undefined };
        const p = payRows[t.id];
        if (till && p) {
          out.payKind = p.pay_kind; out.rate = Number(p.rate);
          out.overtimeHoursPaid = Number(p.ot_hours);
          out.wagesDue = p.pay == null ? 'monthly salary ' + Number(p.rate) + ' (not prorated by attendance)' : Number(p.pay);
          if (p.pay_kind === 'hourly' && t.shortHours) out.valueOfShortHours = Math.round(t.shortHours * Number(p.rate));
        }
        return out;
      }).sort((x, y) => x.name.localeCompare(y.name));
      return {
        restaurantHours: houseHours(ctx, h),
        businessDayStartsAt: (h.day_start_hour ?? 6) + ':00',
        standardDayHours: stdDay, staffBreakMins: brk,
        hoursNote: 'Expected hours are the shift (or standard day) minus the ' + brk + '-minute break.', overtimeMultiplier: Number(h.ot_multiplier) || 1.5,
        window: { from, to },
        today: (() => { const td = days.filter(d => d.day === today && !d.absent); return { day: today, present: td.length, presentNames: td.map(d => d.name), late: td.filter(d => d.lateMins).map(d => ({ name: d.name, job: d.job, clockedIn: d.clockedIn, lateMins: d.lateMins, measuredFrom: d.lateMeasuredFrom })), absentRostered: days.filter(d => d.day === today && d.absent).map(d => d.name) }; })(),
        lateRule: 'Late means clocking in more than 5 minutes after the rostered shift start, or after opening time when the person has no shift that day.',
        totals,
        days: days.slice(-150).map(({ staffId, ...d }) => d),
        ...(till ? { wageNote: pay && pay.error ? 'Wage sheet unreadable: ' + pay.error.message : 'Wages follow the wage sheet: hourly = regular hours x rate + overtime x rate x multiplier; daily = days x rate; monthly salary is not divided by attendance.' } : { wageNote: 'Wages are only readable in the counter app.' }),
      };
    },
    schema: {
      description: 'Restaurant opening hours and staff attendance for a date range: per person and per day the clock-in and clock-out time, breaks, hours worked, the hours expected (rostered shift, or the standard day), extra (overtime) hours, shortage hours, absences, late arrivals and early leaving, plus totals per person' + ' and, at the counter, pay kind, rate, paid overtime and wages due. Includes a today block: how many are present and who came late. Staff with no rostered shift are measured against opening time. Use for restaurant timings, attendance, how many came today, who came late, overtime, extra hours, short hours, and wages. Defaults to this month.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'YYYY-MM-DD' },
          to: { type: 'string', description: 'YYYY-MM-DD' },
          days: { type: 'integer', description: 'rolling window ending today instead of from/to' },
        },
      },
    },
  },
  {
    name: 'restaurantInfo',
    run: async (sb, rid, a, ctx) => {
      const { data, error } = await sb.from('restaurants').select('*').eq('id', rid).maybeSingle();
      if (error) return unreadable(error);
      const h = data || {};
      return {
        name: h.name || PLACE.restaurantName, address: h.address || undefined, phone: h.phone || undefined,
        openingHours: houseHours(ctx, h), staffBreakMins: houseBreak(ctx),
        tables: h.table_count || undefined, businessDayStartsAt: (h.day_start_hour ?? 6) + ':00',
        now: new Date().toLocaleString('en-IN', { weekday: 'long', hour: 'numeric', minute: '2-digit' }),
      };
    },
    schema: {
      description: 'The restaurant itself: opening and closing hours, address, phone, number of tables, when the business day starts, and the current day and time. Use for timings, when we open or close, and how long until closing.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    /* What the room still owes. Printed bills carry their real total; a table
       not yet billed is its lines so far, which is labelled as such rather
       than passed off as the bill. */
    name: 'unpaidOrders',
    counterOnly: true,
    run: async (sb, rid) => {
      let r = await sb.from('orders').select('id,table_label,opened_at,stage,paid_amount,dlv,party_name,order_items(qty,unit_price)').eq('restaurant_id', rid).eq('status', 'open');
      if (r.error) r = await sb.from('orders').select('id,table_label,opened_at,order_items(qty,unit_price)').eq('restaurant_id', rid).eq('status', 'open');
      if (r.error) return unreadable(r.error);
      const ords = r.data || [];
      const ids = ords.map(o => o.id);
      const bl = ids.length ? await sb.from('bills').select('order_id,no,state,total,paid,printed_at').in('order_id', ids).neq('state', 'void') : { data: [] };
      const bill = Object.fromEntries(((bl && bl.data) || []).map(b => [b.order_id, b]));
      const rows = ords.map(o => {
        const b = bill[o.id];
        const d = o.dlv || {};
        const items = (o.order_items || []).reduce((n, i) => n + (i.qty || 0) * (Number(i.unit_price) || 0), 0) + (d.mode === 'door' && d.charge && d.fee != null ? Number(d.fee) : 0);
        const billed = b && b.state !== 'open';
        const total = billed ? Number(b.total) : items;
        const paid = billed ? Math.max(Number(b.paid) || 0, Number(o.paid_amount) || 0) : Number(o.paid_amount) || 0;
        return {
          who: (/^U/.test(o.table_label) ? 'Parcel ' + o.table_label.slice(1) : 'Table ' + o.table_label) + (o.party_name ? ' (' + o.party_name + ')' : ''),
          openedMinsAgo: minsAgo(o.opened_at),
          status: b && b.state === 'printed' ? 'bill printed, waiting for payment' : 'not billed yet',
          billNo: b && b.no || undefined,
          total: Math.round(total), paid: Math.round(paid), due: Math.round(Math.max(0, total - paid)),
          basis: billed ? 'printed bill total' : 'items ordered so far, before tax, charges or discount',
        };
      }).filter(x => x.due > 0).sort((x, y) => y.due - x.due);
      const sum = f => rows.filter(f).reduce((n, x) => n + x.due, 0);
      return {
        ordersAwaitingPayment: rows.length,
        totalToCollect: sum(() => true),
        onPrintedBills: sum(x => x.basis === 'printed bill total'),
        onTablesNotYetBilled: sum(x => x.basis !== 'printed bill total'),
        orders: rows,
        note: 'Figures already added up; quote them as given. Not-yet-billed amounts will change once tax, charges or discounts are applied at billing.',
      };
    },
    schema: {
      description: 'Every open table and parcel that has not paid yet: who, how long open, whether the bill is printed, total, paid so far and amount due, plus the total still to be collected (split into printed bills and tables not billed yet). Use for pending payments, unpaid orders, money still to come in, who has not paid, outstanding amount.',
      parameters: { type: 'object', properties: {} },
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
      const cap = Math.min(Number(a.limit) || 300, 400);
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
      /* "Most expensive" was answered by the model scanning 120 rows and it
         paired the top price with the wrong neighbour (Juicy Mandi at ₹600 —
         that is the Turkish Mandi; the Juicy is ₹580). Sorting is code's job:
         the extremes arrive already picked, name and price on one line. */
      const rows = data.map(d => ({
        no: d.no, name: d.name_en, tamil: d.name_ta || undefined,
        price: Number(d.price), available: d.available !== false,
      }));
      const byPrice = rows.slice().sort((x, y) => y.price - x.price);
      const line = d => d.name + ' \u2014 \u20b9' + d.price;
      if (a.sort === 'price_desc') rows.sort((x, y) => y.price - x.price);
      if (a.sort === 'price_asc') rows.sort((x, y) => x.price - y.price);
      return {
        mostExpensive: byPrice.slice(0, 5).map(line),
        cheapest: byPrice.slice(-5).reverse().map(line),
        note: 'Each price belongs to the name on its own row. For most or least expensive, quote mostExpensive / cheapest exactly.',
        dishes: rows,
      };
    },
    schema: {
      description:
        'The menu as it stands today: dish number, name, price in rupees and whether it is available. Use it for any question about what something costs, what is on the menu, what a dish number is, or whether a dish is being sold — these are facts about the card, not about sales. Pass search to match part of a name; a guest’s wording rarely matches the card exactly, so if a phrase finds nothing, search one distinctive word from it before saying the dish does not exist.',
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'part of a dish name, e.g. "biryani"' },
          sort: { type: 'string', enum: ['price_desc', 'price_asc'] },
          limit: { type: 'integer' },
        },
      },
    },
  },
];


const clamp = (v, lo, hi, dflt) => Math.min(Math.max(Number(v) || dflt, lo), hi);
const localDay = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const minsAgo = t => { const x = t ? (typeof t === 'number' ? t : Date.parse(t)) : 0; return x ? Math.max(0, Math.round((Date.now() - x) / 6e4)) : undefined; };
const clock = t => { const x = t ? (typeof t === 'number' ? t : Date.parse(t)) : 0; return x ? new Date(x).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : undefined; };
const avg = xs => xs.length ? Math.round(xs.reduce((n, x) => n + x, 0) / xs.length * 10) / 10 : undefined;
const pctl = (xs, p) => { if (!xs.length) return undefined; const s = xs.slice().sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10; };
const stintHours = r => Math.max(0, ((r.out_at ? Date.parse(r.out_at) : Date.now()) - Date.parse(r.in_at)) / 36e5 - (r.break_mins || 0) / 60);

/* The board with its arithmetic already done. Asked twice how many tables were
   taken, the model counted a list of tickets twice and got 10 then 9: parcels,
   split parts and a seated table with no food yet were each counted or not by
   chance. Counting is code's job; the model reads the answer. */
async function floorFromDb(sb, rid, ctx) {
  if (!sb || !rid) return null;
  let r = await sb.from('orders').select('id,table_label,opened_at,stage,order_items(dish_id,qty,sent,note)').eq('restaurant_id', rid).eq('status', 'open');
  if (r.error) r = await sb.from('orders').select('id,table_label,opened_at,order_items(dish_id,qty,note)').eq('restaurant_id', rid).eq('status', 'open');
  if (r.error) return null;
  const ids = Array.from(new Set((r.data || []).flatMap(o => (o.order_items || []).map(i => i.dish_id)).filter(Boolean)));
  const dn = {};
  if (ids.length) {
    const d = await sb.from('dishes').select('id,name_en').in('id', ids);
    (d.data || []).forEach(x => { dn[x.id] = x.name_en; });
  }
  const now = Date.now();
  const ago = t => t ? Math.max(0, Math.round((now - Date.parse(t)) / 6e4)) : undefined;
  return {
    tables: (ctx && ctx.tables) || 0,
    orders: (r.data || []).sort((a, b) => Date.parse(a.opened_at) - Date.parse(b.opened_at)).map((o, n) => {
      const parcel = /^U/.test(o.table_label || '');
      return {
        order: n + 1, table: parcel ? 'Parcel ' + o.table_label.slice(1) : o.table_label, kind: parcel ? 'parcel' : 'table',
        seatedAt: clock(o.opened_at), seatedMinsAgo: ago(o.opened_at), openedMinsAgo: ago(o.opened_at),
        billPrinted: o.stage === 'billed' ? true : undefined,
        items: (o.order_items || []).map(i => {
          const qty = Number(i.qty) || 0, out = Math.min(qty, Number(i.sent) || 0);
          return { name: dn[i.dish_id] || 'Dish', qty, servedQty: out, note: i.note || undefined, out: out >= qty ? 'all served' : out ? out + ' of ' + qty + ' served' : 'not served yet' };
        }),
      };
    }),
  };
}

/* A ticket open longer than the restaurant is open in a day (11 AM to 11 PM)
   is a leftover in this device's store, not a table being served. Two phones
   gave 5 and 11 for the same room because one of them was still carrying
   yesterday's unclosed tickets. They are reported, not counted. */
const STALE_MINS = 14 * 60;

function floorRead(snap) {
  const all = snap.orders || [];
  const stale = all.filter(o => (o.openedMinsAgo ?? o.seatedMinsAgo ?? 0) > STALE_MINS);
  const orders = all.filter(o => stale.indexOf(o) < 0);
  const total = Number(snap.tables) || 0;
  const seated = orders.filter(o => o.kind !== 'parcel');
  const base = l => (String(l).match(/\d+/) || [String(l)])[0];
  const taken = Array.from(new Set(seated.map(o => base(o.table)))).sort((a, b) => a - b);
  const free = total ? Array.from({ length: total }, (_, i) => String(i + 1)).filter(n => taken.indexOf(n) < 0) : [];
  const clearing = seated.map(o => {
    const items = o.items || [];
    const pending = items.reduce((n, i) => n + Math.max(0, (i.qty || 0) - (i.servedQty || 0)), 0);
    const plates = items.reduce((n, i) => n + (i.qty || 0), 0);
    const lastOut = items.map(i => i.lastServedMinsAgo).filter(x => x != null);
    const sinceFood = lastOut.length ? Math.min(...lastOut) : undefined;
    const why = o.paymentClaimed || o.billPrinted ? (o.billPrinted ? 'bill printed' : 'guest has paid on the app') + (pending ? ', ' + pending + ' plates still pending' : '')
      : !plates ? 'seated, nothing ordered yet'
      : pending ? pending + ' of ' + plates + ' plates still to go out'
      : 'all food served' + (sinceFood != null ? ' ' + sinceFood + ' min ago' : '');
    const score = (o.paymentClaimed || o.billPrinted ? 10000 : 0) + (plates && !pending ? 5000 + (sinceFood || 0) * 10 : 0) - pending * 50 + (o.seatedMinsAgo || 0);
    return { table: o.table, seatedMinsAgo: o.seatedMinsAgo, seatedAt: o.seatedAt, platesPending: pending, lastFoodOutMinsAgo: sinceFood, status: why, score };
  }).sort((a, b) => b.score - a.score).map(({ score, ...r }, i) => ({ rank: i + 1, ...r }));
  const pendingOf = o => (o.items || []).reduce((n, i) => n + Math.max(0, (i.qty || 0) - (i.servedQty || 0)), 0);
  const waiting = orders.filter(o => pendingOf(o) > 0);
  return {
    readAt: clock(Date.now()),
    pending: {
      pendingOrders: waiting.length,
      pendingTables: waiting.filter(o => o.kind !== 'parcel').length,
      pendingParcels: waiting.filter(o => o.kind === 'parcel').length,
      platesStillToGoOut: waiting.reduce((n, o) => n + pendingOf(o), 0),
      openOrdersTotal: orders.length,
      which: waiting.map(o => ({ table: o.table, platesPending: pendingOf(o) })),
      note: 'Already counted. "Pending orders" means pendingOrders: open tickets with food still to go out. Quote these numbers as given; do not recount.',
    },
    ...(stale.length ? { leftoverTickets: { count: stale.length, tables: stale.map(o => o.table), note: 'Open more than 14 hours — old tickets never closed on this device. Not counted above. Mention them once so someone closes them.' } } : {}),
    seating: {
      tablesInRoom: total || undefined,
      occupied: taken.length,
      free: total ? free.length : undefined,
      occupiedTables: taken,
      freeTables: total ? free : undefined,
      openTableTickets: seated.length,
      openParcels: orders.length - seated.length,
      note: 'Already counted. A split table (7A, 7B) is one table. Parcels are not tables. Quote these numbers as given.',
    },
    clearingNext: clearing,
    tickets: orders,
    ...(orders.length ? {} : { empty: true, hint: 'Nothing open on the board right now — every table is free and no parcels are waiting.' }),
  };
}

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
/* Opening hours and the staff break. A value handed in by the screen (its
   Tweaks) wins, then config.js, then the restaurant row. */
/* Staff with the job they were given (Chief cook, Tandoor…). role is only the
   app access level; "waiter" there covers cooks and cleaners too. */
const staffWithJobs = async (sb, rid) => {
  const [st, pos] = await Promise.all([
    sb.from('staff').select('id,name,role,active,position_id').eq('restaurant_id', rid).order('name'),
    sb.from('positions').select('id,name').eq('restaurant_id', rid),
  ]);
  if (st.error) return sb.from('staff').select('id,name,role,active').eq('restaurant_id', rid).order('name');
  const pn = Object.fromEntries(((pos && pos.data) || []).map(p => [p.id, p.name]));
  return { data: (st.data || []).map(s => ({ ...s, job: pn[s.position_id] || (s.role === 'waiter' ? 'staff' : s.role) })), error: null };
};
/* Opening and closing time on a day, as instants. Staff with no rostered shift
   are measured against these (11 AM to 11 PM unless set otherwise). */
const hourOf = (t, dflt) => { const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(t || ''); if (!m) return dflt; let h = +m[1] % 12; if (/pm/i.test(m[3] || '')) h += 12; else if (!m[3] && +m[1] === 12) h = 12; return h + (+(m[2] || 0)) / 60; };
const houseWindow = (ctx, h, day) => {
  const txt = String(houseHours(ctx, h)), parts = txt.split(/\s+(?:to|-|–|until)\s+/i);
  const o = hourOf(parts[0], 11), c = hourOf(parts[1], 23);
  const at = x => Date.parse(day + 'T00:00:00+05:30') + x * 36e5;
  return { open: at(o), close: at(c <= o ? c + 24 : c) };
};
const houseHours = (ctx, h) => (ctx && ctx.house && ctx.house.hours) || PLACE.openingHours || (h && h.hours) || '11 AM to 11 PM';
const houseBreak = ctx => {
  const v = ctx && ctx.house ? ctx.house.breakMins : null;
  if (v != null && v !== '' && isFinite(v)) return Math.max(0, Number(v));
  return PLACE.staffBreakMins != null && PLACE.staffBreakMins !== '' ? Number(PLACE.staffBreakMins) : 30;
};
const TREND_NOTES_URL = 'https://raw.githubusercontent.com/zakeer9999/MarvotechEvery/main/trends.md';
/* Provider's expert file, read by every restaurant's site: "## Blogs" lines
   "- Name | https://site | topic" feed the expert library (the kb job reads
   them), "## Instructions" lines are added to every assistant conversation.
   Nothing per-restaurant lives there; an empty or missing file changes nothing. */
export const EXPERT_URL = 'https://raw.githubusercontent.com/zakeer9999/MarvotechEvery/main/expert.md';
export function parseExpert(text) {
  const out = { blogs: [], instructions: [] };
  let sec = '';
  String(text || '').split(/\r?\n/).forEach(l => {
    const h = l.match(/^##\s+(.+)/);
    if (h) { sec = /blog/i.test(h[1]) ? 'b' : /instruct/i.test(h[1]) ? 'i' : ''; return; }
    const m = l.match(/^\s*[-*]\s+(.+)/);
    if (!m) return;
    if (sec === 'b') {
      const [name, site, topic] = m[1].split('|').map(s => s.trim());
      if (name && /^https?:\/\//.test(site || '')) out.blogs.push({ name, site: site.replace(/\/+$/, ''), topic: ['cooking', 'service', 'operations', 'cost', 'sales', 'staff'].includes((topic || '').toLowerCase()) ? topic.toLowerCase() : 'operations' });
    } else if (sec === 'i') out.instructions.push(m[1].trim());
  });
  return out;
}
let _expert = null;
async function expertInstructions() {
  if (_expert && Date.now() - _expert.at < 3600e3) return _expert.text;
  let t = '';
  try { const r = await fetch(EXPERT_URL, { cache: 'no-store' }); if (r.ok) t = await r.text(); } catch (e) {}
  const ins = parseExpert(t).instructions;
  const text = ins.length ? '\n\nStanding instructions from the app provider (apply to every answer, never above this restaurant\'s own data or the rules above):\n' + ins.map(s => '- ' + s).join('\n') : '';
  _expert = { at: Date.now(), text };
  return text;
}
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

/* Plates sold are takings with one multiplication left; off the counter the
   AI Engine keeps its percentages and forecasts and loses the sold counts. */
function dropSold(v) {
  if (Array.isArray(v)) return v.map(dropSold);
  if (v && typeof v === 'object') { const o = {}; for (const k in v) if (!/^sold_/.test(k)) o[k] = dropSold(v[k]); return o; }
  return v;
}

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
export function systemPrompt({ tables, scope, hours, breakMins }) {
  const hc = { house: { hours, breakMins } };
  return `You are the business manager for ${PLACE.restaurantName}, a restaurant in ${PLACE.town}${
    tables ? ` with ${tables} tables` : ''
  }. Open ${houseHours(hc)}; every staff shift includes a ${houseBreak(hc)}-minute break. Currency is INR; write amounts as \u20b9714 or \u20b91,240.

Pending orders come from openOrders.pending (pendingOrders, platesStillToGoOut) —
quote them exactly, the same way every time.

For the most or least expensive dish, call menu and quote mostExpensive or
cheapest exactly as given: name and price together, never re-paired.

Read the numbers with your tools before answering. Never guess a figure, never
round one into a better story, and never present your own estimate as a reading.
If a figure is unavailable, say which one and stop.

Prices, dish numbers and what is on the card come from the menu tool. Reach for
it before saying you do not have something: a price question is almost never a
sales question.

Whether a dish is off comes from the menu tool; WHY it is off comes from
dishesOff, which words the reason. The menu only knows a dish is unavailable,
so do not conclude from it that no reason was recorded — read dishesOff first.

Asked how to make a dish better, cook it faster, save time, cut cost, sell
more, improve service, or for tips and tricks, call expertTips with specific
words (the dish, ingredient or problem), and read this house's own evidence
first where it applies: dishDetails and feedbackComments for a dish, aiEngine
for what moved and what changes worked, stock and expenses for cost,
serviceRatings and kitchenStations for service. Base every tip on a passage
or a reading, name the source blog briefly, and tie it to this restaurant's
dish, complaint or number. Never give filler advice such as greeting with a
smile, keeping the place clean or training staff well unless a passage and a
reading both point at it. Three or four concrete steps beat ten general ones.
Never claim a result the passage does not state ("shown to raise
satisfaction", "proven", percentages). Use Indian kitchen words: coriander,
not cilantro. Name the source only if it came from expertTips or webResearch
in this conversation; never name a blog from memory.

For prep forecasts, festival sales patterns, which dishes are gaining or
dipping and why, and whether a logged change worked, call aiEngine.

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

Seat counts come from openOrders.seating and nowhere else: occupied, free and
the table lists there are already counted. Quote them exactly; never count the
tickets yourself, and never give a different figure for the same board. Asked
which table will clear or free up next, answer from clearingNext in its rank
order and give the reason it lists (bill printed, paid, all food served N
minutes ago, plates still pending), with how long the table has been seated.

Other things staff ask about, and the tool for each:
  bulkCooking        bulk orders, bulk cooking, trays, pots, portions ready or left
  kitchenStations    how each kitchen station is doing, which station is slow
  staffPerformance   how each staff member performed: orders, plates, speed, hours
  attendanceHours    attendance, clock-in and out times, late, overtime (extra
                     hours), shortage hours, absences${counterScope(scope) ? ', and wages' : ''}
  restaurantInfo     opening and closing time, address, phone, number of tables${counterScope(scope) ? `
  unpaidOrders       orders not paid yet and the total still to be collected —
                     quote its totals as given, never add them up yourself` : ''}
Always read the tool; never say this data is not available without calling it.

You speak to staff and the owner, never to guests. Answer only what was asked.
No greetings, no welcome lines, nothing like "please be seated" or "your table
is ready", and never announce anything nobody asked for. If the message is
unclear, empty or not addressed to you, say you did not catch it and stop.
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

Outside webResearch, expertTips and aiEngine you read this restaurant's own
numbers only; never improvise outside facts.

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

  send       put the round on the ticket \u2014 "send it to the kitchen", "punch it",
             "send the order", "put it through"
  authorise  the counter's own check on that ticket \u2014 "authorise it", "approve
             it", "confirm it", "OK it", "push it to the kitchen". This is the
             press that puts food on the kitchen screen; send on its own only
             files it for checking.
  first      mark every dish on it cook first \u2014 "rush it", "priority", "cook
             it first", "urgent", "quickly"
  hold       park it on the board instead \u2014 "hold it", "wait on it"

Staff often speak Tamil or Telugu and the words arrive translated. Anuppu /
anuppunga / kitchen-ku anuppu is send; OK pannu, approve pannu, confirm pannu,
authorise pannu is authorise; first-aa podu, seekiram, urgent is first; wait
pannu, hold pannu is hold. "Send and confirm" or "send it, OK it" is send plus
authorise.

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
      const raw = await res.text();
      try { const j = JSON.parse(raw); const e = Array.isArray(j) ? j[0] && j[0].error : j.error; msg = (e && e.message) || msg; } catch (e) { msg = raw.slice(0, 300) || msg; }
      /* Google names a daily cap only in the details (quotaId ...PerDay...). */
      if (/PerDay/.test(raw) && !/PerDay/.test(msg)) msg += ' [PerDay]';
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
/* Each model has its own free pool. A model that answered 429 is benched for
   as long as Google says (or a minute; half an hour for a daily cap), so the
   next turn skips it without a round trip. Before this, every turn paid for
   the same refused calls plus 7 s of waits before reaching a model that works. */
/* Checked against this key's model list on 28 Sep: the 2.x ids are retired
   ("no longer available to new users"), so the ladder is the 3.x family.
   Each id has its own free pool; spent or overloaded ones are benched below. */
const GEMINI_TEXT = [GEMINI_CHAT, 'gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.7-flash', 'gemini-3-flash-preview', 'gemini-flash-lite-latest', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
/* Hearing and translating are short, plain jobs. Flash-Lite does them as well
   and has ~25x Flash's free daily allowance, so it goes first there and Flash
   is kept for the long writing (Enhance, chat fallback). */
const GEMINI_LITE = ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.1-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.5-flash', 'gemini-3.7-flash', 'gemini-3-flash-preview', GEMINI_CHAT, 'gemini-3.8-flash'];
/* Benches survive a reload (and are shared by tabs on this phone), so a model
   whose daily cap is spent is not asked again on every page open. */
const COOL = (() => { try { return JSON.parse(localStorage.getItem('sulthans.aiCool') || '{}') || {}; } catch (e) { return {}; } })();
/* Only ids this key's model list actually has are called, so a retired or
   misspelt id never costs a 404. The list call is free (not a generate
   request) and is cached for a day. Aliases (-latest) always pass. */
let AVAIL = null;
async function available(key) {
  if (AVAIL || !key) return AVAIL;
  try { const c = JSON.parse(localStorage.getItem('sulthans.aiModels') || 'null'); if (c && Date.now() - c.at < 864e5 && c.ids.length) return AVAIL = new Set(c.ids); } catch (e) {}
  try {
    const ids = []; let page = '';
    do {
      const tm = timed(5000);
      const r = await fetch(GEMINI_NATIVE + '/models?pageSize=1000&key=' + encodeURIComponent(key) + (page ? '&pageToken=' + page : ''), { signal: tm.signal }).finally(() => tm.done());
      if (!r.ok) return null;
      const j = await r.json();
      (j.models || []).forEach(m => ids.push(String(m.name || '').replace(/^models\//, '')));
      page = j.nextPageToken || '';
    } while (page);
    if (ids.length) { AVAIL = new Set(ids); try { localStorage.setItem('sulthans.aiModels', JSON.stringify({ at: Date.now(), ids })); } catch (e) {} }
  } catch (e) {}
  return AVAIL;
}
const listed = m => !AVAIL || /-latest$/.test(m) || AVAIL.has(m);
/* Free daily allowances reset at midnight Pacific; a spent model waits for that. */
function resetAt() {
  const now = new Date(), pt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const next = new Date(pt); next.setHours(24, 0, 0, 0);
  const ms = next - pt;
  return now.getTime() + (ms > 0 && ms <= 864e5 ? ms : 3600e3) + 60e3;
}
const BUSY = [];
const fam = m => /-tts/.test(m) ? '*tts' : '*';
const cooling = m => { const now = Date.now(); return (COOL[m] || 0) > now || (COOL[fam(m)] || 0) > now || !listed(m); };
/* Failed 503s appear to count against the free daily allowance (Google forum,
   Sep 2026), and overloads usually last 30-120 min. So a busy model is benched
   10 min (30 if it was busy within the hour), and when three different models
   are busy within two minutes Google is overloaded as a whole: every Gemini
   call is skipped for 5 min and Whisper/Groq answer instead. A timeout counts
   as busy: the request still reached Google and likely still counted. */
function cool(model, e) {
  const msg = String((e && e.message) || ''), st = e && e.status, now = Date.now();
  if (st === 404 || st === 400 && /not found|not supported/i.test(msg)) COOL[model] = now + 7 * 864e5;
  else if (st === 503 || st === 500 || st === 504 || st === 408) {
    COOL[model] = now + ((COOL['503:' + model] || 0) > now - 3600e3 ? 30 : 10) * 60e3;
    COOL['503:' + model] = now;
    BUSY.push({ model, at: now }); if (BUSY.length > 20) BUSY.shift();
    /* Voice and text models are separate capacity: each family has its own breaker. */
    if (new Set(BUSY.filter(b => b.at > now - 120e3 && fam(b.model) === fam(model)).map(b => b.model)).size >= 3) COOL[fam(model)] = now + 5 * 60e3;
  } else {
    const m = /retry in ([\d.]+)\s*s|"retryDelay":\s*"(\d+)s"/i.exec(msg);
    COOL[model] = /per ?day|PerDay|RPD/i.test(msg) ? resetAt() : now + Math.min(m ? Number(m[1] || m[2]) * 1000 + 500 : 60e3, 60 * 60e3);
  }
  try { localStorage.setItem('sulthans.aiCool', JSON.stringify(COOL)); } catch (e) {}
}
export const geminiState = () => GEMINI_TEXT.every(cooling) ? geminiWhy() : '';
function geminiWhy() {
  const now = Date.now();
  if ((COOL['*'] || 0) > now) return 'Gemini busy, resting ' + Math.ceil((COOL['*'] - now) / 6e4) + ' min';
  if (GEMINI_LITE.some(m => (COOL['503:' + m] || 0) > now - 30 * 60e3)) return 'Gemini busy';
  return 'Gemini limit reached';
}
async function geminiChat(key, body, order) {
  let last;
  /* 15 s across the whole ladder: when Google is overloaded every model
     hangs before its 503, and nine of them would be two minutes. */
  await available(key);
  const t0 = Date.now();
  let tries = 0;
  /* At most three models per question: every attempt spends allowance. */
  for (const model of order || GEMINI_TEXT) {
    if (Date.now() - t0 > 15000 || tries >= 3) break;
    if (cooling(model)) continue;
    tries++;
    try { return await Promise.race([geminiOnce(key, body, model), new Promise((_, no) => setTimeout(() => { const e = new Error('timed out'); e.status = 408; no(e); }, 9000))]); }
    catch (e) { last = e; if ([429, 404, 503, 500, 504, 408].includes(e.status) || (e.status === 400 && /not found|not supported/i.test(e.message || ''))) cool(model, e); else throw e; }
  }
  if (!last) { last = new Error('Gemini free limit reached'); last.status = 429; }
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
/* Groq's free per-minute input cap (7-8k tokens) is smaller than a tool
   round late in a conversation. Long tool results are cut first, then the
   oldest turns, then — only if still too big — the tools themselves. */
/* Old turns go first, whole (a tool result without its call is rejected);
   the current question and this turn's own tool round are never dropped —
   losing the question is what produced "I didn't catch a request". Tools are
   never stripped: without them gpt-oss still emits a call and Groq refuses
   with "Tool choice is none, but model called a tool". */
function fit(body, chars) {
  const size = b => JSON.stringify(b.messages).length + (b.tools ? JSON.stringify(b.tools).length : 0);
  if (size(body) <= chars) return body;
  const cut = (ms, n) => ms.map(m => m.role === 'tool' && m.content && m.content.length > n ? { ...m, content: m.content.slice(0, n) + ' …(cut)' } : m);
  const msgs = body.messages;
  let lastUser = msgs.length - 1;
  while (lastUser > 0 && msgs[lastUser].role !== 'user') lastUser--;
  const head = msgs[0], now = msgs.slice(lastUser);
  let old = msgs.slice(1, lastUser);
  let b = { ...body, messages: [head, ...cut(old, 1500), ...cut(now, 1500)] };
  while (size(b) > chars && old.length) {
    let i = 1;
    while (i < old.length && old[i].role !== 'user') i++;
    old = old.slice(i);
    b = { ...body, messages: [head, ...cut(old, 1500), ...cut(now, 1500)] };
  }
  for (const n of [900, 500]) if (size(b) > chars) b = { ...b, messages: [head, ...cut(now, n)] };
  return b;
}

async function chatWithFallback(key, body, geminiKey) {
  /* A 400 "model called a tool" is one model misfiring, not a bad request:
     the next rung answers it. */
  const busy = e => e.status === 429 || e.status === 413 || e.status === 503 || e.status === 500 || e.status === 408 || (e.status === 400 && /called a tool|tool_use_failed|failed to call a function|Parsing failed|could not be parsed|failed_generation/i.test(e.message || ''));
  /* Groq's free per-minute token cap trips on the second tool round (system
     prompt + tools + results) and says "try again in 6.2s". Waiting that out
     beats handing the answer to Gemini while Gemini is also overloaded. */
  const waitFor = e => { const m = /try again in (?:(\d+)m)?([\d.]+)s/i.exec(e.message || ''); return m ? (Number(m[1] || 0) * 60 + Number(m[2])) * 1000 : 0; };
  const groq = async model => {
    try { return await groqChat(key, { ...fit(body, 16000), model, reasoning_effort: EFFORT }); }
    catch (e) {
      const ms = waitFor(e);
      if (!busy(e) || !ms || ms > 20000 || (ms > 8000 && geminiKey && !geminiState())) throw e;
      await new Promise(r => setTimeout(r, ms + 300));
      return groqChat(key, { ...fit(body, 16000), model, reasoning_effort: EFFORT });
    }
  };
  const qwen = () => groqChat(key, { ...fit(body, 13000), model: NATIVE, reasoning_effort: EFFORT });
  /* All three Groq models first: each has its own per-minute and daily cap.
     Gemini is last, because every tool round is a fresh request there (a
     three-tool question was 6-12 Gemini calls of ~10k tokens each on the free
     tier, 29 Sep), and only on the job models so hearing keeps its allowance. */
  let last;
  for (const step of [() => groq(CHAT), () => groqChat(key, { ...fit(body, 15000), model: CHAT_SMALL, reasoning_effort: EFFORT }), qwen]) {
    try { return await step(); } catch (e) { if (!busy(e)) throw e; last = e; }
  }
  if (geminiKey && !GEMINI_JOBS.every(cooling)) {
    try { return await geminiChat(geminiKey, fit(body, 24000), GEMINI_JOBS.slice(0, 2)); }
    catch (e3) { if (!busy(e3) && e3.status !== 500 && e3.status !== 404) throw e3; last = e3; }
  }
  throw last;
}

/* One tool-free completion for long creative JSON (Content Studio). Gemini goes
   first: its free per-minute budget fits the long brief that trips Groq's 8k
   cap, and it writes the long reply without being cut off. Groq is the fallback. */
/* Background jobs (feedback tags, feedback summary, Enhance) stay off the two
   models hearing uses (3.5-flash-lite, 3.6-flash) and off the flash-latest
   alias, which may point at one of them. */
const GEMINI_JOBS = ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.7-flash', 'gemini-3-flash-preview'];
/* DeepSeek on SambaNova, through the app's own Vercel relay (api/deepseek.js):
   SambaNova refuses browser calls, and the relay keeps its key server-side. */
async function deepChat(messages, max_tokens, temperature) {
  const now = Date.now();
  if ((COOL.deepseek || 0) > now) { const e = new Error('DeepSeek resting'); e.status = 429; throw e; }
  const rest = ms => { COOL.deepseek = now + ms; try { localStorage.setItem('sulthans.aiCool', JSON.stringify(COOL)); } catch (e) {} };
  const tm = timed(60000);
  let r;
  try { r = await fetch('/api/deepseek', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages, max_tokens, temperature }), signal: tm.signal }); }
  catch (e) { rest(10 * 60e3); const err = new Error('DeepSeek unreachable'); err.status = 408; throw err; } finally { tm.done(); }
  if (!r.ok) {
    const err = new Error('DeepSeek ' + r.status + ': ' + (await r.text().catch(() => '')).slice(0, 200)); err.status = r.status;
    /* 404: relay not deployed. 503: key not set. Both wait a day. */
    rest(r.status === 404 || r.status === 503 ? 864e5 : r.status === 429 ? (/per ?day|daily/i.test(err.message) ? resetAt() : 10 * 60e3) : 10 * 60e3);
    throw err;
  }
  const j = await r.json();
  return String(j.text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}
/* DeepSeek first (feedback), or Gemini first (Enhance, the long writing);
   then the other; Groq only last, so these never spend the chat's allowance
   while either still answers. */
export async function jobChat(key, geminiKey, system, prompt, opts) {
  const { deepFirst = true, groqPrompt, temperature = 0.3 } = opts || {};
  const messages = [{ role: 'system', content: system }, { role: 'user', content: prompt }];
  const pick = j => (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  let last;
  const deep = async () => { try { return await deepChat(messages, 6000, temperature); } catch (e) { last = e; return ''; } };
  const gem = async () => {
    if (!geminiKey || GEMINI_JOBS.every(cooling)) return '';
    try { return pick(await geminiChat(geminiKey, { messages, max_tokens: 16000, temperature }, GEMINI_JOBS)); } catch (e) { last = e; return ''; }
  };
  for (const step of deepFirst ? [deep, gem] : [gem, deep]) { const t = await step(); if (t) return t; }
  const gm = groqPrompt ? [{ role: 'system', content: system }, { role: 'user', content: groqPrompt }] : messages;
  for (const model of [CHAT, CHAT_SMALL]) {
    if (!key) break;
    try { const t = pick(await groqChat(key, { model, messages: gm, max_tokens: 3000, temperature, reasoning_effort: 'low' })); if (t) return t; } catch (e) { last = e; }
  }
  throw last || new Error('no reply');
}

export async function creativeChat(key, geminiKey, system, prompt, groqPrompt) {
  const messages = [{ role: 'system', content: system }, { role: 'user', content: prompt }];
  const groqMessages = groqPrompt ? [{ role: 'system', content: system }, { role: 'user', content: groqPrompt }] : messages;
  const pick = j => (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  let last;
  if (geminiKey && !geminiState()) try { const t = pick(await geminiChat(geminiKey, { messages, max_tokens: 16000, temperature: 0.9 })); if (t) return t; } catch (e) { last = e; }
  for (const model of [CHAT, CHAT_SMALL]) {
    if (!key) break;
    try { const t = pick(await groqChat(key, { model, messages: groqMessages, max_tokens: 3000, temperature: 0.9, reasoning_effort: 'low' })); if (t) return t; } catch (e) { last = e; }
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
/* All 28 tool definitions are ~15k characters: with the system prompt that is
   ~7k tokens before the question, and Groq's free tier allows ~8k a minute,
   so a second tool round always hit the limit. Each turn now carries only the
   tools its question needs (plus any already used in this conversation). */
const TOOL_GROUPS = [
  [/sale|revenue|takings|earn|profit|bill|turnover|business|how (did|was|is) (we|it|today)|week|month|yesterday|today|compare|busy|hour|peak|slow|quiet|rush|expense|spent|cost|unpaid|pending|due/i, ['salesSummary', 'topDishes', 'slowMovers', 'daypartMix', 'expenses', 'unpaidOrders']],
  [/dish|biri?yani|mandi|food|taste|recipe|improv|enhance|better|worst|best|rating|rated|complain|feedback|comment|review|quality|menu|price|item|cook|make/i, ['dishRatings', 'feedbackComments', 'dishDetails', 'expertTips', 'aiEngine', 'menu', 'onlineReviews']],
  [/service|waiter|call|table|order|pending|open|seat|occupied|parcel|kitchen|late|delay|wait|slow|station|ticket|serve/i, ['openOrders', 'unpaidOrders', 'serviceRatings', 'serviceLog', 'kitchenBottlenecks', 'kitchenStations']],
  [/staff|employee|worker|team|roster|attend|late|absent|leave|shift|clock|punch|hours|salary|pay|perform|who (is|was|came)/i, ['staffRoster', 'staffPerformance', 'attendanceHours']],
  [/stock|ingredient|inventory|reorder|ran out|sold out|sell ?out|finished|off the menu|unavailable|tray|pot|bulk|prep/i, ['stock', 'sellouts', 'dishesOff', 'bulkCooking']],
  [/post|instagram|reel|social|trend|campaign|market|promot|advert|festival|event|customer|guest list|whatsapp|google|research|idea/i, ['webResearch', 'aiEngine', 'customers', 'onlineReviews', 'topDishes']],
  [/open(ing)?|clos(e|ing)|address|phone|location|timing|when do we/i, ['restaurantInfo']],
];
const TOOL_DEFAULT = ['salesSummary', 'topDishes', 'openOrders', 'dishRatings', 'feedbackComments', 'staffRoster', 'restaurantInfo', 'menu'];
function toolsFor(all, messages) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const q = String((lastUser && lastUser.content) || '');
  const want = new Set();
  TOOL_GROUPS.forEach(([re, names]) => { if (re.test(q)) names.forEach(n => want.add(n)); });
  if (!want.size) TOOL_DEFAULT.forEach(n => want.add(n));
  messages.forEach(m => (m.tool_calls || []).forEach(c => want.add(c.function && c.function.name)));
  const names = new Set(all.map(t => t.function.name));
  /* Tools not in the list above (cart/order dictation etc.) always stay. */
  const known = new Set([].concat(...TOOL_GROUPS.map(g => g[1]), TOOL_DEFAULT));
  const picked = all.filter(t => want.has(t.function.name) || !known.has(t.function.name));
  return picked.length && [...want].some(n => names.has(n)) ? picked : all;
}

export async function runDirect({ key, geminiKey, sb, rid, system, messages, onPhase, scope, ctx, house, tables, maxSteps = 6 }) {
  ctx = { ...(ctx || {}), house: house || {}, tables };
  const msgs = [{ role: 'system', content: system + await expertInstructions().catch(() => '') }, ...messages];

  for (let step = 0; step < maxSteps; step++) {
    onPhase && onPhase(step === 0 ? 'thinking' : 'reading');

    const json = await chatWithFallback(key, {
      messages: msgs,
      tools: toolsFor(wireFor(scope), msgs),
      tool_choice: 'auto',
      temperature: 0.4,
      max_tokens: 900,
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
          ? { data: await spec.run(sb, rid, args, { ...ctx, groqKey: key, scope }), error: null }
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

"english" is always a proper English translation in English words, never the
Tamil or Telugu sounds written in Latin letters. "Indha vaaram evlo sales
aachu" becomes "How much did we sell this week", not the romanised words.

"lang" is the language the person spoke in. Tamil mixed with English words
(Tanglish) is "ta"; Telugu mixed with English is "te". Only a sentence spoken
wholly in English is "en".

Dish names stay as spoken — biryani, faluda, porotta, parotta are names, not
words to translate. Numbers are quantities; a table number is "table 7".

Counter commands are translated to these exact English words, because the
system acts on them: அனுப்பு / அனுப்புங்க / கிச்சனுக்கு அனுப்பு / pampu (Telugu)
→ "send it to the kitchen"; ஓகே பண்ணு / அப்ரூவ் பண்ணு / கன்ஃபார்ம் பண்ணு /
authorise பண்ணு → "authorise it"; ஃபர்ஸ்ட்டா போடு / சீக்கிரம் / அர்ஜென்ட் →
"cook it first"; ஹோல்ட் பண்ணு / வெயிட் பண்ணு → "hold it". Keep every such
command in the English, in the order spoken.

Only transcribe a person speaking to the system. If the clip is silence,
breathing, background chatter, a TV, music, or a speaker playing back an
announcement, return english as an empty string. Never invent words that were
not clearly spoken. If the speech is clear but partly unsure, return your best
reading; a human confirms it on screen.`;

/* What speech models write when they hear silence or noise. Whisper is famous
   for "thank you for watching"; these are never an order or a question. */
const GHOST = /^\W*(?:(?:thank you|thanks)(?: (?:so much|very much))?(?: for watching| for listening)?|you|bye|hmm+|um+|uh+|please subscribe|subtitles? by .*|music|\[.*\]|\(.*\))\W*$/i;

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

/* Gemini does not accept WebM (Android Chrome) or MP4 (iPhone Safari)
   recordings reliably; it answered 400 and every turn fell to Whisper. The
   clip is decoded in the browser and sent as 16 kHz mono WAV, which it reads
   on every model. */
async function toWav(blob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return blob;
  const ac = new AC();
  try {
    const buf = await new Promise((ok, no) => { blob.arrayBuffer().then(ab => { const p = ac.decodeAudioData(ab, ok, no); if (p && p.then) p.then(ok, no); }, no); });
    const rate = 16000, len = Math.max(1, Math.round(buf.duration * rate));
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    let data;
    if (OAC) {
      const off = new OAC(1, len, rate), src = off.createBufferSource();
      src.buffer = buf; src.connect(off.destination); src.start(0);
      data = (await off.startRendering()).getChannelData(0);
    } else data = buf.getChannelData(0);
    const pcm = new Int16Array(data.length);
    for (let i = 0; i < data.length; i++) { const v = Math.max(-1, Math.min(1, data[i])); pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff; }
    return wavFromPcm(new Uint8Array(pcm.buffer), OAC ? rate : buf.sampleRate);
  } finally { try { ac.close(); } catch (e) {} }
}

async function hearGemini(key, blob) {
  let wav = blob;
  try { wav = await toWav(blob); } catch (e) { console.info('[assistant] could not convert recording: ' + String((e && e.message) || e).slice(0, 80)); }
  const data = await b64(wav), mime = (wav.type || 'audio/wav').split(';')[0];
  /* Two hearing models, then the transcribe model (its own pool), then
     Whisper. No second pass on a busy model: retries during an overload
     spend the daily allowance and turn tonight's 503s into tomorrow's 429s. */
  let last, empty = 0;
  const one = async model => {
    try { return await hearGeminiOnce(key, model, mime, data); }
    catch (e) {
      last = e;
      console.info('[assistant] Gemini hearing ' + model + ': ' + ((e && e.status) || '') + ' ' + String((e && e.message) || e).slice(0, 140));
      /* An overloaded model sometimes answers 200 with an empty transcript.
         That read as "you said nothing" and ended the turn; the next model
         (and Whisper after it) gets the same clip instead. */
      if (e.message === 'nothing heard') { empty++; return null; }
      if (e.status && ![429, 503, 500, 504, 404, 408].includes(e.status)) throw e;
      cool(model, e);
      return null;
    }
  };
  await available(key);
  const t0 = Date.now(), left = () => Date.now() - t0 < 16000;
  let tries = 0;
  for (const model of GEMINI_LITE) { if (!left() || tries >= 2) break; if (cooling(model)) continue; tries++; const r = await one(model); if (r) return r; }
  /* Gemini's dedicated speech-to-text model: separate pool, plain text only. */
  if (left() && !cooling(TRANSCRIBE)) {
    try { return await hearTranscribe(key, mime, data); }
    catch (e) { last = e; if (e.message === 'nothing heard') empty++; else cool(TRANSCRIBE, e); }
  }
  if (empty >= 2) throw new Error('nothing heard');
  if (!last || last.message === 'nothing heard') { last = new Error(empty ? 'Gemini heard nothing' : 'Gemini free limit reached'); last.status = empty ? 204 : 429; }
  throw last;
}

/* An overloaded model can hang 10 s+ before its 503; 7 s is plenty for a
   short clip, and the next model is tried instead. */
function timed(ms) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, done: () => clearTimeout(t) };
}
async function hearGeminiOnce(key, model, mime, data) {
  const tm = timed(7000);
  let res;
  try { res = await fetch(
    GEMINI_NATIVE + '/models/' + model + ':generateContent?key=' + encodeURIComponent(key),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { inline_data: { mime_type: mime, data } },
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
      signal: tm.signal,
    },
  ); } catch (e) { const err = new Error('timed out'); err.status = 408; throw err; } finally { tm.done(); }
  if (!res.ok) {
    const err = new Error(await res.text().catch(() => 'HTTP ' + res.status));
    err.status = res.status;
    throw err;
  }
  const j = await res.json();
  const txt = (((j.candidates || [])[0] || {}).content || {}).parts;
  const out = JSON.parse((txt && txt[0] && txt[0].text) || '{}');
  const english = String(out.english || '').trim();
  if (!english || GHOST.test(english)) throw new Error('nothing heard');
  return { text: english, lang: out.lang || 'und', via: 'gemini' };
}

const TRANSCRIBE = 'gemini-3.5-transcribe';
async function hearTranscribe(key, mime, data) {
  const tm = timed(8000);
  let res;
  try {
    res = await fetch(GEMINI_NATIVE + '/models/' + TRANSCRIBE + ':generateContent?key=' + encodeURIComponent(key), {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: tm.signal,
      body: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: mime, data } }, { text: 'Transcribe exactly what is said (Tamil, Telugu or English). Output only the words, in the script of the language spoken.' }] }], generationConfig: { temperature: 0 } }),
    });
  } catch (e) { const err = new Error('timed out'); err.status = 408; throw err; } finally { tm.done(); }
  if (!res.ok) { const err = new Error(await res.text().catch(() => 'HTTP ' + res.status)); err.status = res.status; throw err; }
  const j = await res.json();
  const said = ((((j.candidates || [])[0] || {}).content || {}).parts || []).map(p => p.text || '').join(' ').trim();
  if (!said || GHOST.test(said)) throw new Error('nothing heard');
  const lang = /[\u0B80-\u0BFF]/.test(said) ? 'ta' : /[\u0C00-\u0C7F]/.test(said) ? 'te' : 'en';
  return { text: said, lang, via: 'gemini', native: lang !== 'en' };
}

async function whisper(key, blob, path, extra) {
  const form = new FormData();
  form.append('file', blob, 'audio.webm');
  form.append('model', 'whisper-large-v3');
  Object.entries(extra || {}).forEach(([k, v]) => form.append(k, v));
  const res = await fetch(GROQ + '/audio/' + path, { method: 'POST', headers: { authorization: 'Bearer ' + key }, body: form });
  if (!res.ok) {
    const err = new Error(await res.text().catch(() => 'HTTP ' + res.status));
    err.status = res.status;
    throw err;
  }
  return res.json();
}
/* /translations gives English for the tool loop but not the language, which
   left every Whisper turn answering in English. /transcriptions in
   verbose_json reports it; both run at once, so it adds no wait. A language
   other than the three is Whisper guessing, and the mic setting wins. */
const WHISPER_LANG = { tamil: 'ta', telugu: 'te', english: 'en', ta: 'ta', te: 'te', en: 'en' };
async function hearWhisper(key, blob) {
  const [tr, tx] = await Promise.all([
    whisper(key, blob, 'translations'),
    whisper(key, blob, 'transcriptions', { response_format: 'verbose_json' }).catch(() => null),
  ]);
  const said = String((tr && tr.text) || '').trim();
  if (!said || GHOST.test(said)) throw new Error('nothing heard');
  /* Whisper's language guess calls Indian-accented English "tamil", which made
     English questions get Tamil answers. The script it wrote decides instead. */
  const raw = String((tx && tx.text) || '');
  const lang = /[\u0B80-\u0BFF]/.test(raw) ? 'ta' : /[\u0C00-\u0C7F]/.test(raw) ? 'te' : /[a-z]/i.test(raw) ? 'en' : WHISPER_LANG[String((tx && tx.language) || '').toLowerCase()] || 'und';
  return { text: said, lang, via: 'whisper' };
}

/** Returns { text, lang, via }. Gemini first, Whisper when it cannot answer. */
export async function hear(key, blob, geminiKey) {
  let why = geminiKey ? '' : 'no Gemini key';
  if (geminiKey) {
    try {
      const h = await hearGemini(geminiKey, blob);
      if (h.native && key) {
        try {
          const j = await groqChat(key, { model: CHAT_SMALL, reasoning_effort: 'low', max_tokens: 300, temperature: 0.1, messages: [{ role: 'user', content: 'Translate this restaurant staff request into plain English. Output only the translation.\n\n' + h.text }] });
          const en = String((((j.choices || [])[0] || {}).message || {}).content || '').trim();
          if (en) return { text: en, lang: h.lang, via: 'gemini' };
        } catch (e) {}
      }
      return h;
    } catch (e) {
      if (!key || e.message === 'nothing heard') throw e;
      why = e.status === 429 ? geminiWhy() : e.status === 204 ? 'Gemini heard nothing' : e.status === 408 ? 'Gemini slow' : 'Gemini error ' + (e.status || '');
    }
  }
  return { ...(await hearWhisper(key, blob)), why };
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
  /* Qwen first (Groq, its own allowance); Gemini job models only as backup. */
  if (key) {
    try {
      out = pick(await groqChat(key, { ...body, model: NATIVE }));
    } catch (e) {
      if (!geminiKey) throw e;
    }
  }
  if (!out && geminiKey) {
    try {
      out = pick(await geminiChat(geminiKey, body, GEMINI_JOBS.slice(0, 2)));
    } catch (e) {
      if (!key) throw e;
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
/* Newest first. The 2.5 preview voices were retired in 2026 and every reply
   silently fell to the phone voice. 3.8 takes voiceConfig.voice; the older
   ones take prebuiltVoiceConfig. Each is tried until one answers. */
/* Tested 28 Sep: 3.1-flash-tts does not exist (404) and 3.1-flash-tts-preview
   hangs, which used up the reply's time before the working 2.5 voice was
   reached — so the phone voice played. */
/* 3.1-flash-tts-preview removed: it only ever hung. */
const GEMINI_TTS_MODELS = ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts', 'gemini-2.5-flash-preview-tts'];
let TTS_OK = null;
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
const within = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => { const e = new Error('timed out'); e.status = 408; no(e); }, ms))]);

export async function nativeAudio(geminiKey, text, lang, translate, groqKey) {
  if (!geminiKey || !text) return null;
  const name = LANG_NAME[lang];
  /* The current voice models read their whole input aloud, instructions
     included, so they get only the words to say. Tamil and Telugu are
     written first by the chat model, then voiced as they are. */
  if (name && translate) {
    const body = { temperature: 0.3, max_tokens: 700, messages: [{ role: 'user', content: speakPrompt(name, text) }] };
    const pick = j => String((((j || {}).choices || [])[0] || {}).message?.content || '').trim();
    let t = '';
    /* Groq first: it answers in about a second, while an overloaded Gemini
       hung here with no deadline and the reply was never voiced. */
    if (groqKey) try { t = pick(await within(groqChat(groqKey, { ...body, model: NATIVE }), 6000)); } catch (e) {}
    if (!t) try { t = pick(await within(geminiChat(geminiKey, body, GEMINI_JOBS.slice(0, 2)), 6000)); } catch (e) {}
    if (t) text = t;
  }
  const plain = String(text).replace(/[*_#`>]+/g, ' ').replace(/\s+/g, ' ').trim();
  const exact = 'Say exactly these words and nothing else: no greeting, no introduction, no extra sentence before or after.';
  /* translate: one call instead of two. The reply goes out in English and the
     voice model says it in the staff member's language itself — the separate
     translation round was most of the 15-second wait before anything played. */
  const say = name && translate
    ? `Say the text below aloud in natural spoken ${name}, the everyday counter register: dish names and words like parcel, bill, table, half, full stay in English, numbers stay numbers. Speak only the ${name} version, calmly and briskly. No greeting, nothing added before or after.\n\nTEXT:\n${text}`
    : name
      ? `Read the text below aloud in ${name}, calmly and briskly. ${exact}\n\nTEXT:\n${text}`
      : `Read the text below aloud calmly and briskly. ${exact}\n\nTEXT:\n${text}`;

  let res, lastErr;
  /* The free tier gives the TTS model a small daily allowance. When it is
     spent Google answers 429 and the voice silently dropped to the phone's own
     — which on an iPhone has no Tamil at all. Try the second model's pool. */
  /* Each voice model has its own daily pool. One that answers 429 (limit) or
     404 (retired) is benched like the text models, so the next reply goes
     straight to a voice that still has allowance instead of re-asking. */
  await available(geminiKey);
  /* Two voices at most, then the Translate voice / phone voice. */
  const order = (TTS_OK && !cooling(TTS_OK) ? [TTS_OK].concat(GEMINI_TTS_MODELS.filter(m => m !== TTS_OK)) : GEMINI_TTS_MODELS).filter(m => !cooling(m)).slice(0, 2);
  if (!order.length) { const e = new Error('Gemini voice limit reached'); e.status = 429; throw e; }
  for (const model of order) {
    const tm = timed(9000);
    const voiceConfig = /^gemini-3\.8/.test(model) ? { voice: TTS_VOICE } : { prebuiltVoiceConfig: { voiceName: TTS_VOICE } };
    res = await fetch(
      GEMINI_NATIVE + '/models/' + model + ':generateContent?key=' + encodeURIComponent(geminiKey),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: /^gemini-2\.5/.test(model) ? say : plain }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig },
          },
        }),
        signal: tm.signal,
      },
    ).catch(() => ({ ok: false, status: 408, text: async () => 'timed out' })).finally(() => tm.done());
    if (res.ok) { TTS_OK = model; break; }
    const raw = await res.text().catch(() => 'HTTP ' + res.status);
    lastErr = new Error(model + ': ' + raw.slice(0, 200) + (/PerDay/.test(raw) ? ' [PerDay]' : ''));
    lastErr.status = res.status;
    console.info('[assistant] Gemini voice ' + model + ' → ' + res.status);
    if (res.status === 401 || res.status === 403) throw lastErr;
    cool(model, lastErr);
    if (TTS_OK === model) TTS_OK = null;
  }
  if (!res.ok) throw lastErr;
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
  const out = wavFromPcm(unb64(inline.data), rate);
  if (name && translate) out.spoken = plain;
  return out;
}

/* Second rung for Tamil and Telugu when Gemini's voice is out of quota: Google
   Translate's public speech endpoint. No key, plays as an ordinary audio URL,
   and speaks both languages properly — unlike the iPhone's built-in voice,
   which has neither. Unofficial and capped at ~200 characters a request, so
   the text is cut at sentence breaks. */
export function speechUrls(text, lang) {
  const tl = { ta: 'ta', te: 'te', en: 'en-IN' }[lang] || 'en-IN';
  const parts = [];
  String(text || '').replace(/\s+/g, ' ').split(/(?<=[.!?\u0964])\s+/).forEach(s => {
    while (s.length > 190) { const cut = s.lastIndexOf(' ', 190) > 60 ? s.lastIndexOf(' ', 190) : 190; parts.push(s.slice(0, cut)); s = s.slice(cut).trim(); }
    const last = parts[parts.length - 1];
    if (last && last.length + s.length < 180) parts[parts.length - 1] = last + ' ' + s; else if (s) parts.push(s);
  });
  return parts.map((q, i) => 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=' + tl
    + '&total=' + parts.length + '&idx=' + i + '&textlen=' + q.length + '&q=' + encodeURIComponent(q));
}
