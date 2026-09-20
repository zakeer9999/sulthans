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

const byName = Object.fromEntries(TOOLS.map(t => [t.name, t]));

const wire = TOOLS.map(t => ({
  type: 'function',
  function: { name: t.name, description: t.schema.description, parameters: t.schema.parameters },
}));

/* Dictation is offered in both scopes. The admin panel lands a dictated round
   in the same cart behind the same send button the counter uses, so gating the
   instruction on scope only made admin dictation silently impossible. */
export function systemPrompt({ tables }) {
  return `You are the business manager for Sulthan's, a restaurant in Aruppukottai, Tamil Nadu${
    tables ? ` with ${tables} tables` : ''
  }. Currency is INR; write amounts as \u20b9714 or \u20b91,240.

Read the numbers with your tools before answering. Never guess a figure, never
round one into a better story, and never present your own estimate as a reading.
If a figure is unavailable, say which one and stop.

Prices, dish numbers and what is on the card come from the menu tool. Reach for
it before saying you do not have something: a price question is almost never a
sales question.

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
{"table":"7","items":[{"name":"Chicken Biryani","qty":2,"note":"less spicy"}]}
\`\`\`

Dish names exactly as the menu prints them, in English, whatever language they
spoke. Omit table if they did not say one. Nothing fires from this block \u2014 the
counter shows it for a human to confirm, because voice mishears a dish name
eventually. Never emit the block for anything that is not an order.`;
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
      msg = (j.error && j.error.message) || msg;
    } catch (e) {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const groqChat = (key, body) => chatCall(GROQ, key, body);

/* Gemini speaks the same request shape through Google's OpenAI-compatible
   endpoint, so the tool wire and the message history cross over unchanged.
   reasoning_effort is Groq's own field and is dropped on the way. */
function geminiChat(key, body) {
  const { reasoning_effort, max_tokens, ...rest } = body;
  /* Gemini 3 thinks before it answers and bills the thought against
     max_tokens, so a ceiling sized for Groq returns an empty message with
     finish_reason 'length'. Low effort plus more room; the tool loop needs a
     short answer, not a long deliberation. */
  return chatCall(GEMINI, key, {
    ...rest,
    model: GEMINI_CHAT,
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
  try {
    return await groqChat(key, { ...body, model: CHAT, reasoning_effort: EFFORT });
  } catch (e) {
    if (!busy(e)) throw e;
    try {
      return await groqChat(key, { ...body, model: CHAT_SMALL, reasoning_effort: EFFORT });
    } catch (e2) {
      if (!geminiKey || !busy(e2)) throw e2;
      return geminiChat(geminiKey, body);
    }
  }
}

/**
 * Run the tool loop in the browser.
 *
 * sb   — the app's authenticated Supabase client (db.remote.sb)
 * rid  — restaurant uuid (db.remote.rid)
 * onPhase — called with 'thinking' | a tool name, for the status line
 */
export async function runDirect({ key, geminiKey, sb, rid, system, messages, onPhase, maxSteps = 6 }) {
  const msgs = [{ role: 'system', content: system }, ...messages];

  for (let step = 0; step < maxSteps; step++) {
    onPhase && onPhase(step === 0 ? 'thinking' : 'reading');

    const json = await chatWithFallback(key, {
      messages: msgs,
      tools: wire,
      tool_choice: 'auto',
      temperature: 0.4,
      max_tokens: 1400,
    }, geminiKey);

    const m = (json.choices && json.choices[0] && json.choices[0].message) || {};
    const calls = m.tool_calls || [];

    if (!calls.length) return String(m.content || '').trim();

    msgs.push({ role: 'assistant', content: m.content || null, tool_calls: calls });

    for (const call of calls) {
      const spec = byName[call.function.name];
      onPhase && onPhase(call.function.name);

      if (!spec) {
        msgs.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: 'no such tool' }) });
        continue;
      }

      let args = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch (e) {}

      let payload;
      try {
        const { data, error } = spec.run
          ? { data: await spec.run(sb, rid, args), error: null }
          : await sb.rpc(spec.rpc, { p_rid: rid, ...spec.args(args) });
        /* Handed back rather than thrown: the model can say "that is not
           available" and carry on, where a throw ends the whole answer. */
        payload = error
          ? { error: error.message, hint: 'This figure is unavailable. Do not guess it.' }
          : data ?? { empty: true, hint: 'No data in this window yet.' };
      } catch (e) {
        payload = { error: String(e.message || e), hint: 'This figure is unavailable. Do not guess it.' };
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
  return String(
    (((last.choices || [])[0] || {}).message || {}).content || 'I could not finish that one.',
  ).trim();
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

export async function intoLanguage(key, text, lang, geminiKey) {
  const name = LANG_NAME[lang];
  if (!name || !text) return text;
  const body = { temperature: 0.3, max_tokens: 700, messages: [{ role: 'user', content: speakPrompt(name, text) }] };
  let out = '';
  try {
    const json = await groqChat(key, { ...body, model: NATIVE });
    out = String((((json.choices || [])[0] || {}).message || {}).content || '').trim();
  } catch (e) {
    if (!geminiKey) throw e;
  }
  if (!out && geminiKey) {
    const json = await geminiChat(geminiKey, body);
    out = String((((json.choices || [])[0] || {}).message || {}).content || '').trim();
  }
  return out || text;
}
