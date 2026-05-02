// GET /api/leaderboard
// Returns: {entries: [{rank, id, name, fullHandle, score, prec, react, streak, tier}, ...], total}

import { json, preflight } from './_utils.js';

export const onRequestOptions = () => preflight();

const DAY_MS  = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function asEntry(r, i) {
  return {
    rank: i + 1,
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

// Reduce a stream of matches to a per-user best-score list, then sort high-to-low.
function bestPerUser(matches) {
  const byUser = new Map();
  for (const m of matches) {
    const prev = byUser.get(m.id);
    if (!prev || (m.score || 0) > (prev.score || 0)) byUser.set(m.id, m);
  }
  return Array.from(byUser.values()).sort((a, b) => (b.score || 0) - (a.score || 0) || (a.ts || 0) - (b.ts || 0));
}

export async function onRequestGet({ request, env }) {
  if (!env.ZEN_KV) return json({ entries: [], total: 0, error: 'no-kv' });

  const u = new URL(request.url);
  const meId = parseInt(u.searchParams.get('me') || '0', 10);
  const period = String(u.searchParams.get('period') || 'alltime').toLowerCase();

  const total = parseInt((await env.ZEN_KV.get('next_id')) || '0', 10);

  let ranked;
  if (period === 'daily' || period === 'weekly') {
    // Period leaderboard: read the global match log and filter by time window
    const cutoff = Date.now() - (period === 'daily' ? DAY_MS : WEEK_MS);
    const globalLog = (await env.ZEN_KV.get('matches:global', 'json')) || [];
    const within = globalLog.filter(m => (m.ts || 0) >= cutoff);
    ranked = bestPerUser(within);
  } else {
    // All-time leaderboard: stored as a top-100 list per user (kept by score.js)
    ranked = (await env.ZEN_KV.get('leaderboard:v1', 'json')) || [];
  }

  const top = ranked.slice(0, 100);
  const entries = top.map(asEntry);

  // If a user id was requested, find them in the FULL ranked list (not just top 100)
  let you = null;
  if (meId) {
    const idx = ranked.findIndex(r => r.id === meId);
    if (idx !== -1) {
      you = asEntry(ranked[idx], idx);
    }
  }

  return json({ entries, total, you, period });
}
