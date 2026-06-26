// GET /api/newlaunches — the fresh-launch firehose: tokens that just graduated to a DEX, with
// market cap, liquidity, age, holders, and a RUG-RISK SCORE (data DexScreener can't give us).
// Powered by Solana Tracker (key from SOLANATRACKER_KEY env or KV). Read-only, research only.

import { json, preflight, getStKey } from './_utils.js';

export const onRequestOptions = () => preflight();

const num = (x) => { if (x == null) return 0; if (typeof x === 'object') return +(x.usd ?? x.value ?? 0) || 0; return +x || 0; };

export async function onRequestGet({ env }) {
  const key = await getStKey(env);
  if (!key) return json({ error: 'Solana Tracker key not set — add SOLANATRACKER_KEY (or save via /api/sourcetest?savekey=).', tokens: [] }, 200, { 'cache-control': 'no-store' });

  let d = null;
  try { const r = await fetch('https://data.solanatracker.io/tokens/multi/graduated', { headers: { 'x-api-key': key } }); if (r.ok) d = await r.json(); } catch (e) { /**/ }
  const arr = Array.isArray(d) ? d : (d && (d.data || d.tokens)) || [];
  if (!arr.length) return json({ count: 0, tokens: [], note: 'No data right now — retry shortly (free-tier rate limit).' }, 200, { 'cache-control': 'no-store' });

  const now = Date.now();
  const tokens = arr.map((it) => {
    const t = it.token || {}; const p = (it.pools && it.pools[0]) || {};
    const cr = p.createdAt || 0;
    return {
      mint: t.mint, sym: t.symbol || '?', name: (t.name || '').slice(0, 32),
      mcap: num(p.marketCap), liq: num(p.liquidity), price: num(p.price),
      ageH: cr ? +((now - cr) / 3600000).toFixed(1) : null,
      risk: it.risk && it.risk.score != null ? it.risk.score : null,
      holders: it.holders || null,
      twitter: t.twitter || null,
    };
  }).filter((t) => t.mint && t.liq >= 2000)          // tradeable only
    .sort((a, b) => (a.ageH == null ? 1e9 : a.ageH) - (b.ageH == null ? 1e9 : b.ageH))  // newest first
    .slice(0, 40);

  return json({ count: tokens.length, tokens, source: 'solanatracker:graduated', ts: now }, 200, { 'cache-control': 'public, max-age=30' });
}
