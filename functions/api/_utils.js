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
  let order;
  if (method === 'getTokenLargestAccounts' || method === 'getMultipleAccounts') order = [helius, MB, PN]; // accuracy-critical → paid first
  else if (method === 'getTokenAccountsByOwner') order = [MB, helius];    // PN blocks
  else order = [PN, MB, helius];                                          // cheap/high-volume → free first
  order = order.filter(Boolean);
  let lastErr = 'no rpc available';
  for (const url of order) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        if (r.status === 429 || r.status === 403) { lastErr = `${url.split('/')[2]} ${r.status}`; break; } // blocked/limited → next node
        const j = await r.json();
        if (j.error) { lastErr = j.error.message || 'rpc error'; break; }
        return j.result;
      } catch (e) { lastErr = String((e && e.message) || e); } // transient → retry same node once
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
