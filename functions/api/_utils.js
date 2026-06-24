// Shared helpers for /api Pages Functions

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      ...extra,
    },
  });
}

export function preflight() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    },
  });
}

export function validName(s) {
  if (typeof s !== 'string') return null;
  const n = s.trim().replace(/^@+/, '');
  if (n.length < 2 || n.length > 20) return null;
  if (!/^[A-Za-z0-9_.]+$/.test(n)) return null;
  return n;
}

export function tierFor(score) {
  if (score >= 270) return 'Legendary';
  if (score >= 200) return 'Elite';
  if (score >= 100) return 'Adept';
  return 'Beginner';
}

// Hybrid Solana RPC. Forensic-critical calls (top-holders + multi-account owner classification)
// go to the paid Helius first for reliability/accuracy, then free fallback. High-volume cheap
// calls (balance, account info, signatures) go free-first to save Helius credits. publicnode
// blocks getTokenLargestAccounts + getTokenAccountsByOwner (anti-abuse); mainnet-beta serves
// them but rate-limits. Each endpoint is retried once on a transient (network) error.
export async function solRpc(method, params, env) {
  const PN = 'https://solana-rpc.publicnode.com';
  const MB = 'https://api.mainnet-beta.solana.com';
  const helius = (env && env.HELIUS_API_KEY) ? `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}` : null;
  // Accuracy-critical reads (supply, top-holders, owner classification, mint authority) go to
  // paid Helius first — a flaky free node returning empty here corrupts the forensic math
  // (e.g. supply=0 zeros every holder %). Cheap/high-volume reads stay free-first to save credits.
  const ACCURACY = (method === 'getTokenLargestAccounts' || method === 'getMultipleAccounts'
    || method === 'getTokenSupply' || method === 'getAccountInfo');
  let order;
  if (ACCURACY) order = [helius, MB, PN];
  else if (method === 'getTokenAccountsByOwner') order = [MB, helius];    // PN blocks
  else order = [PN, MB, helius];                                          // cheap/high-volume → free first
  order = order.filter(Boolean);
  // getTokenLargestAccounts intermittently returns an EMPTY list even on a healthy paid node —
  // treat empty as retryable so holder concentration doesn't silently collapse to 0.
  const isLargest = method === 'getTokenLargestAccounts';
  const maxAttempts = isLargest ? 5 : 2;
  let lastErr = 'no rpc available';
  for (const url of order) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        if (r.status === 429 || r.status === 403) { lastErr = `${url.split('/')[2]} ${r.status}`; break; } // blocked/limited → next node
        const j = await r.json();
        if (j.error) { lastErr = j.error.message || 'rpc error'; break; }
        if (isLargest && !(j.result && j.result.value && j.result.value.length)) {
          lastErr = 'empty largestAccounts'; await new Promise((res) => setTimeout(res, 250)); continue; // retry same node
        }
        return j.result;
      } catch (e) { lastErr = String((e && e.message) || e); await new Promise((res) => setTimeout(res, 200)); }
    }
  }
  throw new Error(`${method} failed (${lastErr})`);
}

// Free token pricing via Jupiter Price v3 (no key), batched. Returns { mint: {price, liq, decimals} }.
export async function jupPrices(mints) {
  const out = {};
  const uniq = [...new Set(mints)].filter(Boolean);
  for (let i = 0; i < uniq.length; i += 50) {
    const batch = uniq.slice(i, i + 50);
    try {
      const r = await fetch('https://api.jup.ag/price/v3?ids=' + batch.join(','));
      if (!r.ok) continue;
      const j = await r.json();
      for (const m in j) {
        if (j[m] && j[m].usdPrice != null) out[m] = { price: j[m].usdPrice, liq: j[m].liquidity || 0, decimals: j[m].decimals, change24: j[m].priceChange24h };
      }
    } catch (e) { /* best-effort */ }
  }
  return out;
}

// Pick the best DexScreener pair for a mint. The /tokens/{mint} endpoint returns every pair
// the mint touches (incl. ones where it's the QUOTE), and occasionally a deep pool is
// MISQUOTED (wrong price → phantom mcap / absurd % change). So: keep only pairs where the
// mint is the BASE token, drop pools whose price disagrees with the median (outliers), then
// take the deepest-liquidity survivor. Returns null if none.
export function pickPair(rawPairs, mint) {
  const pairs = (rawPairs || []).filter(
    (p) => p && p.chainId === 'solana' && p.baseToken && p.baseToken.address === mint && parseFloat(p.priceUsd) > 0
  );
  if (!pairs.length) return null;
  const prices = pairs.map((p) => parseFloat(p.priceUsd)).sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];
  let kept = pairs.filter((p) => {
    const pr = parseFloat(p.priceUsd);
    return pr >= median / 3 && pr <= median * 3;
  });
  if (!kept.length) kept = pairs;
  kept.sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
  return kept[0];
}

// Quote-side tokens that show up as the "base" of a pool but aren't real candidates.
const QUOTE_MINTS = new Set([
  'So11111111111111111111111111111111111111112', // wSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

// Build a BROAD candidate universe from several FREE sources, so the bots don't only see paid
// "boosted" tokens. Returns [{ mint, sources:[...] }] where sources tag WHY a token surfaced:
//   boosted / new-boost  — DexScreener paid boosts (top + latest)
//   trending             — GeckoTerminal trending pools (Solana)
//   volume               — GeckoTerminal top tokens by 24h volume
//   fresh                — GeckoTerminal brand-new pools
//   volume-spike         — last hour running >=2.2x the 24h average pace (sudden activity)
//   accumulation         — steady positive drift + buy-side pressure, no blow-off spike
// GeckoTerminal is keyless & free (~30 req/min). All calls are best-effort; partial data is OK.
export async function buildUniverse() {
  const get = async (u, h) => { for (let i = 0; i < 3; i++) { try { const r = await fetch(u, h ? { headers: h } : undefined); if (r.ok) return await r.json(); } catch (e) { /**/ } await new Promise((s) => setTimeout(s, 250)); } return null; };
  const gtH = { accept: 'application/json' };
  const num = (x) => { const n = parseFloat(x); return isFinite(n) ? n : 0; };
  const out = new Map(); // mint -> Set(sources)
  const add = (mint, src) => { if (!mint || QUOTE_MINTS.has(mint)) return; const s = out.get(mint) || new Set(); s.add(src); out.set(mint, s); };

  const [bt, bl, prof, tr, vol, np] = await Promise.all([
    get('https://api.dexscreener.com/token-boosts/top/v1'),
    get('https://api.dexscreener.com/token-boosts/latest/v1'),
    get('https://api.dexscreener.com/token-profiles/latest/v1'),
    get('https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1', gtH),
    get('https://api.geckoterminal.com/api/v2/networks/solana/pools?sort=h24_volume_usd_desc&page=1', gtH),
    get('https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1', gtH),
  ]);

  for (const b of bt || []) if (b && b.chainId === 'solana' && b.tokenAddress) add(b.tokenAddress, 'boosted');
  for (const b of bl || []) if (b && b.chainId === 'solana' && b.tokenAddress) add(b.tokenAddress, 'new-boost');
  for (const b of prof || []) if (b && b.chainId === 'solana' && b.tokenAddress) add(b.tokenAddress, 'profile');

  const mintOf = (p) => { const id = p && p.relationships && p.relationships.base_token && p.relationships.base_token.data && p.relationships.base_token.data.id; return id ? String(id).replace(/^solana_/, '') : null; };
  const derived = (p) => {
    const a = p.attributes || {}; const v = a.volume_usd || {}; const pc = a.price_change_percentage || {}; const tx = a.transactions || {};
    const tags = [];
    const h1 = num(v.h1), h24 = num(v.h24);
    if (h24 > 0 && h1 >= 2500 && (h1 * 24) / h24 >= 2.2) tags.push('volume-spike');
    const h6 = num(pc.h6), pd = num(pc.h24); const t6 = tx.h6 || {}; const buys = num(t6.buys), sells = num(t6.sells);
    if (!tags.length && pd >= 2 && pd <= 60 && h6 >= 0 && (buys + sells) > 0 && buys / (buys + sells) >= 0.55) tags.push('accumulation');
    return tags;
  };
  const ingest = (feed, label) => { for (const p of (feed && feed.data) || []) { const m = mintOf(p); if (!m) continue; add(m, label); derived(p).forEach((t) => add(m, t)); } };
  ingest(tr, 'trending'); ingest(vol, 'volume'); ingest(np, 'fresh');

  // diversity-first ordering so spikes/accumulation/trending aren't crowded out by boosts
  const pri = (s) => s.has('volume-spike') ? 0 : s.has('accumulation') ? 1 : s.has('trending') ? 2 : s.has('boosted') ? 3 : s.has('volume') ? 4 : 5;
  return [...out.entries()].map(([mint, s]) => ({ mint, sources: [...s], _p: pri(s) }))
    .sort((a, b) => a._p - b._p).map(({ mint, sources }) => ({ mint, sources }));
}
