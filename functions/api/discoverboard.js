// GET /api/discoverboard?archetype=<id>
// Mode A discovery, end-to-end on a REAL token universe: pulls trending/boosted Solana
// tokens (DexScreener), scores each on the cheap on-chain factors through the chosen
// archetype's weights + hard gates, ranks them. Fund-safe (read-only). Key server-side.
//
// Lightweight per-token (fits Cloudflare Pages Function limits): market data via DexScreener
// single-mint calls (reliable) + ONE batched Helius getMultipleAccounts for authorities.
// Holder concentration / funding-lineage are per-token heavy — use /api/scan & /api/funding
// to drill into a specific result.

import { json, preflight, pickPair, solRpc } from './_utils.js';

export const onRequestOptions = () => preflight();

const ARCH = {
  degen: { g: { Social: 90, 'On-chain health': 40, 'Wallet cleanliness': 25, Momentum: 95 } },
  conservative: { g: { Social: 35, 'On-chain health': 90, 'Wallet cleanliness': 95, Momentum: 45 } },
  smart: { g: { Social: 60, 'On-chain health': 65, 'Wallet cleanliness': 80, Momentum: 55 } },
  narrative: { g: { Social: 85, 'On-chain health': 55, 'Wallet cleanliness': 45, Momentum: 80 } },
  safety: { g: { Social: 30, 'On-chain health': 85, 'Wallet cleanliness': 100, Momentum: 30 } },
  sniper: { g: { Social: 55, 'On-chain health': 60, 'Wallet cleanliness': 60, Momentum: 75 } },
  momentum: { g: { Social: 45, 'On-chain health': 70, 'Wallet cleanliness': 50, Momentum: 95 } },
  insider: { g: { Social: 50, 'On-chain health': 60, 'Wallet cleanliness': 85, Momentum: 50 } },
  balanced: { g: { Social: 60, 'On-chain health': 60, 'Wallet cleanliness': 60, Momentum: 60 } },
  whale: { g: { Social: 30, 'On-chain health': 90, 'Wallet cleanliness': 70, Momentum: 55 } },
};
// Lightweight board factors (group, weighted unless gate).
const BOARD_FACTORS = [
  { k: 'liq', g: 'On-chain health' },
  { k: 'vol', g: 'On-chain health' },
  { k: 'pressure', g: 'On-chain health' },
  { k: 'age', g: 'On-chain health' },
  { k: 'mintAuth', g: 'Wallet cleanliness', gate: true },
  { k: 'freezeAuth', g: 'Wallet cleanliness', gate: true },
  { k: 'priceTrend', g: 'Momentum' },
  { k: 'lifecycle', g: 'Momentum' },
];

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const logScore = (v, lo, hi) => (!v || v <= 0) ? 0 : clamp(Math.round(((Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * 100));

export async function onRequestGet({ request, env }) {
  const archId = (new URL(request.url).searchParams.get('archetype') || 'balanced').trim();
  const arch = ARCH[archId] || ARCH.balanced;

  // Free-first RPC, Helius fallback. Works keyless for cheap calls.
  const rpc = (method, params) => solRpc(method, params, env);
  const dexGet = async (u) => { for (let i = 0; i < 4; i++) { try { const r = await fetch(u); if (r.ok) return await r.json(); } catch (e) { /**/ } await new Promise((res) => setTimeout(res, 300)); } return null; };

  try {
    // 1) universe: boosted/trending Solana tokens
    const [top, latest] = await Promise.all([
      dexGet('https://api.dexscreener.com/token-boosts/top/v1'),
      dexGet('https://api.dexscreener.com/token-boosts/latest/v1'),
    ]);
    const seen = new Set(), mints = [];
    for (const list of [top || [], latest || []]) {
      for (const b of list) {
        if (b && b.chainId === 'solana' && b.tokenAddress && !seen.has(b.tokenAddress)) {
          seen.add(b.tokenAddress); mints.push(b.tokenAddress);
        }
      }
    }
    const universe = mints.slice(0, 16);
    if (!universe.length) return json({ error: 'No trending tokens available right now.' }, 200);

    // 2) market data per token (parallel single-mint — reliable) + 3) authorities (1 batched RPC)
    const [pairsArr, accInfos] = await Promise.all([
      Promise.all(universe.map((m) => dexGet(`https://api.dexscreener.com/latest/dex/tokens/${m}`))),
      rpc('getMultipleAccounts', [universe, { encoding: 'jsonParsed' }]).catch(() => null),
    ]);

    const factorWeight = (f) => arch.g[f.g] || 50;
    const rows = universe.map((mint, i) => {
      const dr = pairsArr[i];
      const p = pickPair(dr && dr.pairs, mint);
      if (!p) return null;
      const info = accInfos && accInfos.value && accInfos.value[i] && accInfos.value[i].data && accInfos.value[i].data.parsed && accInfos.value[i].data.parsed.info;
      const mintAuth = info ? info.mintAuthority !== null : null;
      const freezeAuth = info ? info.freezeAuthority !== null : null;

      const liq = (p.liquidity && p.liquidity.usd) || 0;
      const vol24 = (p.volume && p.volume.h24) || 0;
      const tx = (p.txns && p.txns.h24) || {};
      const buys = tx.buys || 0, sells = tx.sells || 0;
      const ageMs = p.pairCreatedAt || 0;
      const ageDays = ageMs ? (Date.now() - ageMs) / 86400000 : null;
      const mcap = p.marketCap || p.fdv || 0;
      const chg = (p.priceChange && p.priceChange.h24);

      const V = {
        liq: logScore(liq, 3000, 1000000),
        vol: logScore(vol24, 5000, 5000000),
        pressure: (buys + sells) > 0 ? Math.round((buys / (buys + sells)) * 100) : null,
        age: ageDays != null ? clamp(Math.round(20 + 80 * (1 - Math.exp(-ageDays / 21)))) : null,
        mintAuth: mintAuth == null ? null : (mintAuth ? 0 : 100),
        freezeAuth: freezeAuth == null ? null : (freezeAuth ? 0 : 100),
        priceTrend: chg != null ? clamp(Math.round(50 + chg)) : null,
        lifecycle: mcap > 0 ? (mcap < 50000 ? 30 : mcap < 1e6 ? 70 : mcap < 1e7 ? 85 : 60) : null,
      };

      const gateFails = [];
      if (mintAuth === true) gateFails.push('mint authority live');
      if (freezeAuth === true) gateFails.push('freeze authority live');
      const rejected = gateFails.length > 0 && archId !== 'degen';

      let wsum = 0, vsum = 0;
      BOARD_FACTORS.filter((f) => !f.gate && V[f.k] != null).forEach((f) => { const w = factorWeight(f); wsum += w; vsum += w * V[f.k]; });
      let composite = wsum ? Math.round(vsum / wsum) : null;
      if (rejected && composite != null) composite = Math.min(composite, 12);

      return {
        mint,
        symbol: ((p.baseToken && p.baseToken.symbol) || '?').replace(/^\$/, ''),
        name: (p.baseToken && p.baseToken.name) || 'Unknown',
        composite, rejected, gateFails,
        market: { priceUsd: parseFloat(p.priceUsd) || 0, mcap, liq, vol24, ageDays: ageDays != null ? Math.round(ageDays) : null, dex: p.dexId },
      };
    }).filter(Boolean);

    rows.sort((a, b) => (b.composite == null ? -1 : b.composite) - (a.composite == null ? -1 : a.composite));

    return json({
      archetype: archId,
      scanned: rows.length,
      results: rows,
      note: 'Mode A on a live trending universe (DexScreener boosts), scored on the cheap on-chain factors. Drill into any result with /api/scan (concentration) and /api/funding (clusters). Social/Brain factors pending.',
      source: 'helius+dexscreener', ts: Date.now(),
    }, 200, { 'cache-control': 'public, max-age=60' });
  } catch (e) {
    return json({ error: e.message || 'Discovery board failed.' }, 502);
  }
}
