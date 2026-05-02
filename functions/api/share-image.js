// POST /api/share-image
//   Body: { data: "<base64 PNG without data: prefix>" }
//   Returns: { id }
// Stores the PNG in KV under "share:{id}" with a 7-day TTL.
// Companion: GET /api/share-image/:id  (see ./share-image/[id].js)

import { json, preflight } from './_utils.js';

export const onRequestOptions = () => preflight();

const TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

function randomId(len = 10) {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  for (let i = 0; i < len; i++) s += a[buf[i] % a.length];
  return s;
}

function base64ToBytes(b64) {
  // atob → binary string → Uint8Array
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function onRequestPost({ request, env }) {
  if (!env.ZEN_KV) return json({ error: 'KV binding ZEN_KV not configured' }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
  let data = String(body && body.data || '').trim();
  if (!data) return json({ error: 'no data' }, 400);
  // Strip any "data:image/png;base64," prefix
  if (data.indexOf(',') !== -1) data = data.split(',')[1];
  // Decode and length-check (cap at 1.5 MB raw to stay under KV's 25MB value limit but keep things sane)
  let bytes;
  try { bytes = base64ToBytes(data); }
  catch { return json({ error: 'bad base64' }, 400); }
  if (bytes.length > 1_500_000) return json({ error: 'image too large' }, 413);

  const id = randomId(10);
  await env.ZEN_KV.put('share:' + id, bytes, { expirationTtl: TTL_SECONDS });
  return json({ id, expires_in: TTL_SECONDS });
}
