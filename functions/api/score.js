// POST /api/score  body: {id, name, score, prec, react, streak, tier}
// Records the match in the user's history and updates the global top-100 leaderboard if it qualifies.

import { json, preflight, tierFor } from './_utils.js';

export const onRequestOptions = () => preflight();

const LB_KEY = 'leaderboard:v1';   // top 100 by best score
const LB_LIMIT = 100;

export async function onRequestPost({ request, env }) {
  if (!env.ZEN_KV) return json({ error: 'KV binding ZEN_KV not configured' }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const id = parseInt(body.id, 10);
  const name = String(body.name || '').trim().replace(/^@+/, '');
  const score = parseInt(body.score, 10);
  if (!id || !name || !Number.isFinite(score) || score < 0 || score > 300) {
    return json({ error: 'invalid payload' }, 400);
  }

  const prec   = clamp01(parseFloat(body.prec) || 0);
  const react  = Math.max(0, parseInt(body.react, 10) || 0);
  const streak = Math.max(0, Math.min(3, parseInt(body.streak, 10) || 0));
  const tier   = String(body.tier || tierFor(score));

  // Verify the user exists (loose check — if missing, just continue with given name)
  const userKey = 'user:' + id;
  const existing = await env.ZEN_KV.get(userKey, 'json');
  if (!existing) {
    await env.ZEN_KV.put(userKey, JSON.stringify({ id, name, joinedAt: Date.now() }));
  }

  // Append to user's match history (cap at last 50)
  const histKey = 'matches:' + id;
  const hist = (await env.ZEN_KV.get(histKey, 'json')) || [];
  hist.unshift({ score, prec, react, streak, tier, ts: Date.now() });
  if (hist.length > 50) hist.length = 50;
  await env.ZEN_KV.put(histKey, JSON.stringify(hist));

  // Update global leaderboard (top 100 by best score per user)
  const lb = (await env.ZEN_KV.get(LB_KEY, 'json')) || [];
  // Strip any existing entry for this user
  const filtered = lb.filter(r => r.id !== id);
  // Compute the user's best from history
  const best = hist.reduce((m, r) => Math.max(m, r.score || 0), 0);
  const userBestEntry = hist.find(r => r.score === best) || { score: best, prec, react, streak, tier };
  filtered.push({ id, name, score: best, prec: userBestEntry.prec, react: userBestEntry.react, streak: userBestEntry.streak, tier: userBestEntry.tier, ts: Date.now() });
  filtered.sort((a, b) => b.score - a.score || a.ts - b.ts);
  if (filtered.length > LB_LIMIT) filtered.length = LB_LIMIT;
  await env.ZEN_KV.put(LB_KEY, JSON.stringify(filtered));

  // Compute this user's rank
  const rank = filtered.findIndex(r => r.id === id) + 1;
  return json({ ok: true, rank, total: filtered.length, best });
}

function clamp01(n) { if (!Number.isFinite(n)) return 0; if (n < 0) return 0; if (n > 100) return 100; return n; }
