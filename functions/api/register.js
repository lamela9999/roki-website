// POST /api/register  body: {name}
// Returns: {id, name, fullHandle, existing}
//
// Assigns a sequential ID by incrementing a counter in KV. KV is
// eventually consistent, so two concurrent registers could collide on the
// same id — for the traffic profile of a small meme game that's an edge
// case worth tolerating. Migrate to D1 if it ever matters.

import { json, preflight, validName } from './_utils.js';

export const onRequestOptions = () => preflight();

export async function onRequestPost({ request, env }) {
  if (!env.ZEN_KV) return json({ error: 'KV binding ZEN_KV not configured' }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const name = validName(body && body.name);
  if (!name) return json({ error: 'invalid name (2-20 chars, letters/digits/_./)' }, 400);

  const lower = name.toLowerCase();
  const existingId = await env.ZEN_KV.get('name:' + lower);
  if (existingId) {
    return json({ id: Number(existingId), name, fullHandle: '@' + name + '#' + existingId, existing: true });
  }

  // Increment global counter
  const cur = parseInt((await env.ZEN_KV.get('next_id')) || '0', 10);
  const id = cur + 1;
  await env.ZEN_KV.put('next_id', String(id));
  await env.ZEN_KV.put('name:' + lower, String(id));
  await env.ZEN_KV.put('user:' + id, JSON.stringify({ id, name, joinedAt: Date.now() }));
  return json({ id, name, fullHandle: '@' + name + '#' + id, existing: false });
}
