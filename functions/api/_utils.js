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
