// GET /api/leaderboard
// Returns: {entries: [{rank, id, name, fullHandle, score, prec, react, streak, tier}, ...], total}

import { json, preflight } from './_utils.js';

export const onRequestOptions = () => preflight();

export async function onRequestGet({ request, env }) {
  if (!env.ZEN_KV) return json({ entries: [], total: 0, error: 'no-kv' });

  const u = new URL(request.url);
  const meId = parseInt(u.searchParams.get('me') || '0', 10);

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

  // If a user id was requested, return their full row + their actual global rank,
  // even if they're below the top 100. (We still cap at 100 for the visible top-N
  // but tell the UI exactly where the user sits.)
  let you = null;
  if (meId) {
    const idx = lb.findIndex(r => r.id === meId);
    if (idx !== -1) {
      const r = lb[idx];
      you = {
        rank: idx + 1,
        id: r.id,
        name: r.name,
        fullHandle: '@' + r.name + '#' + r.id,
        score: r.score,
        prec: r.prec || 0,
        react: r.react || 0,
        streak: r.streak || 0,
        tier: r.tier || 'Beginner',
      };
    }
  }

  return json({ entries, total, you });
}
