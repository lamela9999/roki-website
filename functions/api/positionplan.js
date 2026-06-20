// GET /api/positionplan?mint=<mint>&risk=<0-100>
// Mode B — position management for ONE chosen token. Produces a REAL paper plan from live
// price action + order flow + lifecycle + liquidity, sized by the risk dial. Fund-safe:
// this is a recommendation only — NO execution, NO funds, NO signing.
//
// SOL/majors and memecoins get different heads (blueprint rule). Smart-money flow (Layer 1)
// is the intended primary signal and is flagged as a pending enhancer here.

import { json, preflight, pickPair, solRpc } from './_utils.js';

export const onRequestOptions = () => preflight();

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAJORS = new Set([
  'So11111111111111111111111111111111111111112', // wSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

// Risk dial → concrete limits (mirrors rokibot.html riskMap()).
function riskMap(d) {
  return {
    positionPct: +(1 + d / 100 * 24).toFixed(1),       // 1%–25% of bankroll
    slippagePct: +(0.5 + d / 100 * 4.5).toFixed(1),    // 0.5%–5% (tight; real fills use MEV-protected routing, not a fat tolerance)
    minLiqUsd: Math.round(250000 * Math.pow(0.02, d / 100) / 100) * 100, // $250k→$5k
    stopLossPct: Math.round(8 + d / 100 * 42),          // 8%–50%
  };
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const mint = (url.searchParams.get('mint') || '').trim();
  const risk = Math.max(0, Math.min(100, parseInt(url.searchParams.get('risk') || '50', 10) || 50));
  if (!MINT_RE.test(mint)) return json({ error: "That doesn't look like a Solana mint address." }, 400);

  // Free-first RPC, Helius fallback. Works keyless for cheap calls.
  const rpc = (method, params) => solRpc(method, params, env);

  try {
    const [dex, acct] = await Promise.all([
      fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`).then((r) => r.json()).catch(() => null),
      rpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }]).catch(() => null),
    ]);
    const p = pickPair(dex && dex.pairs, mint);
    if (!p) return json({ error: 'No Solana trading pair found for this mint.' }, 200);
    const info = acct && acct.value && acct.value.data && acct.value.data.parsed && acct.value.data.parsed.info;
    const mintAuth = info ? info.mintAuthority !== null : null;
    const freezeAuth = info ? info.freezeAuthority !== null : null;

    const price = parseFloat(p.priceUsd) || 0;
    const liq = (p.liquidity && p.liquidity.usd) || 0;
    const mcap = p.marketCap || p.fdv || 0;
    const ch = p.priceChange || {};
    const h1 = ch.h1 != null ? ch.h1 : 0, h6 = ch.h6 != null ? ch.h6 : 0, h24 = ch.h24 != null ? ch.h24 : 0;
    const tx = (p.txns && p.txns.h1) || {};
    const buys = tx.buys || 0, sells = tx.sells || 0;
    const buyRatio = (buys + sells) > 0 ? buys / (buys + sells) : 0.5;
    const vol24 = (p.volume && p.volume.h24) || 0;
    const vol1h = (p.volume && p.volume.h1) || 0;
    const volAccel = vol24 > 0 ? (vol1h * 24) / vol24 : 1; // >1 = volume rising
    const ageMs = p.pairCreatedAt || 0;
    const ageDays = ageMs ? (Date.now() - ageMs) / 86400000 : null;
    const isMajor = MAJORS.has(mint) || mcap > 1e9;
    const rm = riskMap(risk);

    const signals = [];
    const reasons = [];
    let action, confidence;

    // Hard-stop conditions first.
    if (mintAuth === true || freezeAuth === true) {
      action = 'AVOID';
      confidence = 0.9;
      reasons.push(`${[mintAuth ? 'mint' : '', freezeAuth ? 'freeze' : ''].filter(Boolean).join(' & ')} authority still live — the deployer can rug. Hard gate.`);
    } else if (liq < rm.minLiqUsd) {
      action = 'AVOID';
      confidence = 0.75;
      reasons.push(`Liquidity ($${Math.round(liq / 1000)}k) is below your risk-dial floor ($${Math.round(rm.minLiqUsd / 1000)}k) — you couldn't exit cleanly.`);
    } else if (isMajor) {
      // Majors head: mean-reversion / range.
      signals.push('mean-reversion (major)');
      if (h24 < -6) { action = 'ACCUMULATE'; confidence = 0.55; reasons.push(`Major down ${h24.toFixed(1)}% on the day — mean-reversion entry zone. Thin edge vs desks; size modestly.`); }
      else if (h24 > 8) { action = 'TRIM'; confidence = 0.5; reasons.push(`Major up ${h24.toFixed(1)}% — fade strength toward the range.`); }
      else { action = 'HOLD'; confidence = 0.45; reasons.push('Major inside its range — no edge right now; wait for a stretch.'); }
    } else {
      // Memecoin head: on-chain flow + lifecycle (charts are noise).
      const dipping = h1 < -4 && h6 > h1;       // pulling back but not in freefall
      const pumping = h1 > 8;
      const decaying = h6 < -15 && volAccel < 0.7; // bleeding + volume dying
      if (decaying) { action = 'EXIT'; confidence = 0.6; reasons.push(`Down ${h6.toFixed(0)}% over 6h with volume fading (${volAccel.toFixed(2)}× run-rate) — looks like lifecycle decay/distribution.`); signals.push('lifecycle decay'); }
      else if (dipping && buyRatio >= 0.5 && volAccel >= 0.8) { action = 'ACCUMULATE'; confidence = 0.55; reasons.push(`Dip of ${h1.toFixed(0)}% (1h) with buyers still ${Math.round(buyRatio * 100)}% of flow and volume holding — buy-the-dip setup.`); signals.push('dip + holding flow'); }
      else if (pumping && buyRatio < 0.5) { action = 'TRIM'; confidence = 0.5; reasons.push(`Up ${h1.toFixed(0)}% (1h) but sellers now lead flow (${Math.round((1 - buyRatio) * 100)}%) — take some into the pump.`); signals.push('pump + selling flow'); }
      else if (pumping) { action = 'HOLD'; confidence = 0.4; reasons.push(`Up ${h1.toFixed(0)}% with buyers still leading — ride it, trail your stop.`); signals.push('momentum up'); }
      else { action = 'WAIT'; confidence = 0.4; reasons.push('No clean dip or exhaustion signal right now — wait for a setup.'); signals.push('no setup'); }
    }

    const plan = (action === 'AVOID') ? null : {
      positionPct: rm.positionPct,
      slippagePct: rm.slippagePct,
      stopLossPct: rm.stopLossPct,
      entryZone: action === 'ACCUMULATE' ? { from: +(price * 0.95).toPrecision(4), to: +(price * 1.0).toPrecision(4) } : null,
      takeProfit: (action === 'ACCUMULATE' || action === 'HOLD') ? +(price * (1 + (isMajor ? 0.06 : 0.4))).toPrecision(4) : null,
      stopPrice: +(price * (1 - rm.stopLossPct / 100)).toPrecision(4),
    };

    return json({
      mint,
      risk,
      market: { name: (p.baseToken && p.baseToken.name) || 'Unknown', symbol: ((p.baseToken && p.baseToken.symbol) || '?').replace(/^\$/, ''), priceUsd: price, mcap, liq, ageDays: ageDays != null ? Math.round(ageDays) : null, h1, h6, h24, dex: p.dexId },
      assetClass: isMajor ? 'major' : 'memecoin',
      action, confidence, signals, reasons, plan,
      pendingNote: "Smart-money flow (Layer 1 wallet labeling) is the intended primary signal and isn't wired into this v1 — it uses price action, order flow, lifecycle and liquidity. Paper recommendation only; not financial advice; no execution.",
      source: 'helius+dexscreener', ts: Date.now(),
    }, 200, { 'cache-control': 'public, max-age=20' });
  } catch (e) {
    return json({ error: e.message || 'Position plan failed.' }, 502);
  }
}
