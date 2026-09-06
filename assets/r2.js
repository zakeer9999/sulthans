/* Sulthan's — signed PUT to Cloudflare R2 (S3 signature v4).

   Files routed through the iOS Files app arrive at the R2 dashboard with the
   right name and zero bytes: iOS hands Safari an iCloud placeholder rather than
   the data. Signing the request in the page uploads from memory instead, which
   is the only reliable path from a phone — and avoids picking 100 files by hand.

   Credentials belong to an R2 API token scoped to the one bucket, held in the
   staff phone's own storage. Revoke it in Cloudflare when the uploads are done. */

const ENC = new TextEncoder();
const hex = buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');

async function sha256(data) {
  return hex(await crypto.subtle.digest('SHA-256', data));
}

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, ENC.encode(msg));
}

async function signingKey(secret, date) {
  let k = ENC.encode('AWS4' + secret);
  for (const part of [date, 'auto', 's3', 'aws4_request']) k = new Uint8Array(await hmac(k, part));
  return k;
}

export async function putObject(creds, key, body, type) {
  const buf = body instanceof Uint8Array ? body : new Uint8Array(await body.arrayBuffer());
  const host = creds.account + '.r2.cloudflarestorage.com';
  const now = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  const date = now.slice(0, 8);
  const path = '/' + creds.bucket + '/' + key.split('/').map(encodeURIComponent).join('/');
  if (!buf.length) throw new Error('refused to upload an empty file');
  const payload = await sha256(buf);

  const canonical = ['PUT', path, '',
    'host:' + host, 'x-amz-content-sha256:' + payload, 'x-amz-date:' + now, '',
    'host;x-amz-content-sha256;x-amz-date', payload].join('\n');
  const scope = [date, 'auto', 's3', 'aws4_request'].join('/');
  const toSign = ['AWS4-HMAC-SHA256', now, scope, await sha256(ENC.encode(canonical))].join('\n');
  const sig = hex(await hmac(await signingKey(creds.secret, date), toSign));

  const r = await fetch('https://' + host + path, {
    method: 'PUT', body: buf,
    headers: {
      'Authorization': 'AWS4-HMAC-SHA256 Credential=' + creds.keyId + '/' + scope
        + ', SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=' + sig,
      'x-amz-content-sha256': payload,
      'x-amz-date': now,
      'Content-Type': type || 'application/octet-stream',
    },
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 140));
  return buf.length;
}

/* One retry — phone radios drop a request now and then, and a failed frame
   halfway through a hundred is not worth restarting the batch for. */
export async function putRetry(creds, key, body, type) {
  try { return await putObject(creds, key, body, type); }
  catch (e) { return putObject(creds, key, body, type); }
}

export function loadCreds() {
  try { return JSON.parse(localStorage.getItem('sulthans.r2') || 'null'); } catch (e) { return null; }
}

export function saveCreds(c) {
  try { localStorage.setItem('sulthans.r2', JSON.stringify(c)); } catch (e) {}
}

export function clearCreds() {
  try { localStorage.removeItem('sulthans.r2'); } catch (e) {}
}
