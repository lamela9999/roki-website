// GET /api/leaderboard
// Returns: {entries: [{rank, id, name, fullHandle, score, prec, react, streak, tier}, ...], total}

import { json, preflight } from './_utils.js';

export const onRequestOptions = () => preflight();

export async function onRequestGet({ env }) {
  if (!env.ZEN_KV) return json({ entries: [], total: 0, error: 'no-kv' });

  const lb = (await env.ZEN_KV.get('leaderboard:v1', 'json')) || [];
  const total = parseInt((await env.ZEN_KV.get('next_id')) || '0', 10);

  const entries = lb.map((r, i) => ({
    rank: i + 1,
    id: r.id,
    name: r.name,
    fullHandle: '@' + r.name + '#' + r.id,
    score: r.score,
    prec: r.prec || 0,
    react: r.react || 0,
    streak: r.streak || 0,
    tier: r.tier || 'Beginner',
  }));

  return json({ entries, total });
}
