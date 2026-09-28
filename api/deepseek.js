/* Relay to DeepSeek on SambaNova. SambaNova refuses calls straight from a
   browser, and this keeps SAMBANOVA_API_KEY out of the page source.
   Set SAMBANOVA_API_KEY in Vercel > Project > Settings > Environment Variables. */
export const config = { maxDuration: 60 };
/* V3.1 answers without a long think, which suits tagging; R1 is the backup. */
const MODELS = ['DeepSeek-V3.1', 'DeepSeek-V3-0324', 'DeepSeek-R1-0528', 'DeepSeek-R1'];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const origin = req.headers.origin || '';
  if (origin && !/^https:\/\/sulthans[\w.-]*\.vercel\.app$|^http:\/\/localhost(:\d+)?$/.test(origin)) return res.status(403).json({ error: 'origin not allowed' });
  const key = process.env.SAMBANOVA_API_KEY;
  if (!key) return res.status(503).json({ error: 'SAMBANOVA_API_KEY is not set in Vercel' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const messages = body && Array.isArray(body.messages)
    ? body.messages.slice(0, 4).map(m => ({ role: m.role === 'system' ? 'system' : 'user', content: String(m.content || '').slice(0, 30000) }))
    : [];
  if (!messages.length) return res.status(400).json({ error: 'no messages' });
  const max_tokens = Math.min(Number(body.max_tokens) || 3000, 8000);
  const temperature = Math.min(Math.max(Number(body.temperature) || 0.3, 0), 1);
  let last = { status: 502, error: 'no DeepSeek model answered' };
  for (const model of MODELS) {
    try {
      const r = await fetch('https://api.sambanova.ai/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages, max_tokens, temperature }),
      });
      if (r.ok) {
        const j = await r.json();
        return res.status(200).json({ model, text: (((j.choices || [])[0] || {}).message || {}).content || '' });
      }
      last = { status: r.status, error: (await r.text()).slice(0, 300) };
      if (r.status === 401 || r.status === 403) break;
    } catch (e) { last = { status: 502, error: String(e && e.message || e).slice(0, 200) }; }
  }
  return res.status(last.status).json({ error: last.error });
}
