// GET /api/regime
// The Brain (Layer 4), lite: read the current market regime from rolling stats over the live
// trending universe — median age, liquidity, 24h move, buy/sell pressure, rug-gate prevalence.
// Outputs a regime label + a DEFENSE-first aggression suggestion (per the blueprint, regime
// detection pays off most by dialing aggression DOWN when conditions turn hostile).
// Fund-safe, read-only. (A production Brain persists these as a moving window + signal-perf
// table; this computes an on-demand snapshot from the current universe.)

import { json, preflight, solRpc } from './_utils.js';

export const onRequestOptions = () => preflight();

const median = (arr) => { const a = arr.filter((x) => x != null).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };

export async function onRequestGet({ request, env }) {
  // Free-first RPC, Helius fallback. Works keyless for cheap calls.
  const rpc = (method, params) => solRpc(method, params, env);
  const dexGet = async (u) => { for (let i = 0; i < 4; i++) { try { const r = await fetch(u); if (r.ok) return await r.json(); } catch (e) { /**/ } await new Promise((res) => setTimeout(res, 300)); } return null; };

  try {
    const [top, latest] = await Promise.all([
      dexGet('https://api.dexscreener.com/token-boosts/top/v1'),
      dexGet('https://api.dexscreener.com/token-boosts/latest/v1'),
    ]);
    const seen = new Set(), mints = [];
    for (const list of [top || [], latest || []]) for (const b of list) {
      if (b && b.chainId === 'solana' && b.tokenAddress && !seen.has(b.tokenAddress)) { seen.add(b.tokenAddress); mints.push(b.tokenAddress); }
    }
    const universe = mints.slice(0, 16);
    const KV = env.ZEN_KV; // reuse the project KV namespace to cache the last-good regime
    if (!universe.length) {
      if (KV) { const cached = await KV.get('radar:regime', 'json').catch(() => null); if (cached) return json({ ...cached, stale: true }, 200, { 'cache-control': 'public, max-age=60' }); }
      return json({ error: 'No trending tokens available right now — retry shortly.' }, 200);
    }

    const [pairsArr, accInfos] = await Promise.all([
      Promise.all(universe.map((m) => dexGet(`https://api.dexscreener.com/latest/dex/tokens/${m}`))),
      rpc('getMultipleAccounts', [universe, { encoding: 'jsonParsed' }]).catch(() => null),
    ]);

    const ages = [], liqs = [], chg24s = [], buyRatios = [], mcaps = [];
    let gated = 0, counted = 0;
    universe.forEach((mint, i) => {
      const dr = pairsArr[i];
      const pairs = ((dr && dr.pairs) || []).filter((p) => p.chainId === 'solana' && p.baseToken && p.baseToken.address === mint);
      if (!pairs.length) return;
      pairs.sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
      const p = pairs[0];
      counted++;
      const ageMs = p.pairCreatedAt || 0;
      if (ageMs) ages.push((Date.now() - ageMs) / 86400000);
      liqs.push((p.liquidity && p.liquidity.usd) || 0);
      if (p.priceChange && p.priceChange.h24 != null) chg24s.push(p.priceChange.h24);
      mcaps.push(p.marketCap || p.fdv || 0);
      const tx = (p.txns && p.txns.h24) || {}; const b = tx.buys || 0, s = tx.sells || 0;
      if (b + s > 0) buyRatios.push(b / (b + s));
      const info = accInfos && accInfos.value && accInfos.value[i] && accInfos.value[i].data && accInfos.value[i].data.parsed && accInfos.value[i].data.parsed.info;
      if (info && (info.mintAuthority !== null || info.freezeAuthority !== null)) gated++;
    });

    const medAge = median(ages), medLiq = median(liqs), medChg = median(chg24s), medBuy = median(buyRatios), medMcap = median(mcaps);
    const pctGated = counted ? gated / counted : null;

    // ---- regime classification ----
    const greedy = (medChg != null && medChg > 5) && (medBuy != null && medBuy > 0.52);
    const hostile = (medChg != null && medChg < -8) || (pctGated != null && pctGated > 0.5);
    const fresh = medAge != null && medAge < 2;
    let mood = greedy ? 'risk-on / greedy' : hostile ? 'risk-off / hostile' : 'neutral / mixed';
    let tempo = fresh ? 'fresh-launch frenzy' : (medAge != null && medAge > 14 ? 'established rotation' : 'mid-cycle');

    // Defense-first aggression suggestion: dial DOWN when hostile.
    let aggressionDelta = 0;
    if (hostile) aggressionDelta = -25;
    else if (medChg != null && medChg < -3) aggressionDelta = -12;
    else if (greedy) aggressionDelta = +8;

    const narrative =
      (hostile ? `Conditions are hostile — trending tokens are down (median ${medChg != null ? medChg.toFixed(1) : '?'}% 24h)${pctGated != null && pctGated > 0.5 ? ` and ${Math.round(pctGated * 100)}% still carry live mint/freeze authority` : ''}. Dial aggression DOWN.`
        : greedy ? `Market is greedy — median trending token up ${medChg.toFixed(1)}% with buyers leading (${Math.round(medBuy * 100)}% of flow). Edge favors offense, but trail stops.`
        : `Mixed regime — no strong directional edge. Trade selectively at flat size.`)
      + (fresh ? ' Universe skews very fresh (median age <2d): launch-sniper signals matter, rug-gates matter more.' : '');

    const result = {
      sampled: counted,
      stats: {
        medianAgeDays: medAge != null ? Math.round(medAge) : null,
        medianLiqUsd: medLiq != null ? Math.round(medLiq) : null,
        medianChange24: medChg != null ? +medChg.toFixed(1) : null,
        medianBuyRatio: medBuy != null ? +medBuy.toFixed(2) : null,
        medianMcapUsd: medMcap != null ? Math.round(medMcap) : null,
        pctGated: pctGated != null ? +pctGated.toFixed(2) : null,
      },
      regime: { mood, tempo, aggressionDelta },
      narrative,
      note: 'On-demand snapshot from the live trending universe. A production Brain tracks these as a moving window + per-signal performance table to make weights regime-aware over time.',
      source: 'helius+dexscreener', ts: Date.now(),
    };
    if (KV) await KV.put('radar:regime', JSON.stringify(result), { expirationTtl: 600 }).catch(() => {});
    return json(result, 200, { 'cache-control': 'public, max-age=120' });
  } catch (e) {
    return json({ error: e.message || 'Regime read failed.' }, 502);
  }
}
