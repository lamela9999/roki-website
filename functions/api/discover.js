// GET /api/discover?mint=<mint>&archetype=<id>
// Mode A discovery scoring — REAL on-chain factors run through an archetype's weight
// vector + hard gates → composite 0–100. Fund-safe (read-only). Key stays server-side.
//
// Computable now from Helius + DexScreener (real): liquidity, volume+trend, buy/sell
// pressure, holder concentration (hub-aware), token age, mint/freeze authority (gates),
// price trend, market-cap lifecycle. PENDING (need paid X-data, deeper traces, or the
// Brain): the 5 social factors, holder-growth, dev-wallet behavior, LP burn/lock, sniper/
// bundle, insider-cluster (see /api/funding), narrative heat. Pending factors are returned
// as available:false and excluded from the composite — never faked.

import { json, preflight, pickPair } from './_utils.js';

export const onRequestOptions = () => preflight();

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const KNOWN_OWNERS = {
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j': 'raydium',
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM': 'exchange/custody',
  '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9': 'exchange/custody',
  '2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S': 'exchange/custody',
};

// 20 factors (mirrors rokibot.html). gate:true → hard gate, not weighted.
const FACTORS = [
  { k: 'f1', n: 'Mention velocity', g: 'Social' },
  { k: 'f2', n: 'Poster quality', g: 'Social' },
  { k: 'f3', n: 'KOL / smart-account involvement', g: 'Social' },
  { k: 'f4', n: 'Engagement authenticity', g: 'Social' },
  { k: 'f5', n: 'Dev account credibility', g: 'Social' },
  { k: 'f6', n: 'Liquidity depth', g: 'On-chain health' },
  { k: 'f7', n: 'Real volume + trend', g: 'On-chain health' },
  { k: 'f8', n: 'Buy/sell pressure', g: 'On-chain health' },
  { k: 'f9', n: 'Holder count growth', g: 'On-chain health' },
  { k: 'f10', n: 'Holder concentration (top-10%)', g: 'On-chain health' },
  { k: 'f11', n: 'Token age', g: 'On-chain health' },
  { k: 'f12', n: 'Dev wallet behavior', g: 'Wallet cleanliness' },
  { k: 'f13', n: 'Mint authority revoked?', g: 'Wallet cleanliness', gate: true },
  { k: 'f14', n: 'Freeze authority revoked?', g: 'Wallet cleanliness', gate: true },
  { k: 'f15', n: 'LP burned / locked?', g: 'Wallet cleanliness', gate: true },
  { k: 'f16', n: 'Sniper / bundle at launch', g: 'Wallet cleanliness' },
  { k: 'f17', n: 'Insider-cluster linkage', g: 'Wallet cleanliness' },
  { k: 'f18', n: 'Price trend', g: 'Momentum' },
  { k: 'f19', n: 'Market-cap lifecycle stage', g: 'Momentum' },
  { k: 'f20', n: 'Narrative heat', g: 'Momentum' },
];

// Archetype weight model (mirrors rokibot.html): group emphasis + boosted factors.
const ARCH = {
  degen: { g: { Social: 90, 'On-chain health': 40, 'Wallet cleanliness': 25, Momentum: 95 }, boost: ['f1', 'f3', 'f18', 'f20'] },
  conservative: { g: { Social: 35, 'On-chain health': 90, 'Wallet cleanliness': 95, Momentum: 45 }, boost: ['f6', 'f10', 'f12', 'f15'] },
  smart: { g: { Social: 60, 'On-chain health': 65, 'Wallet cleanliness': 80, Momentum: 55 }, boost: ['f3', 'f12', 'f17'] },
  narrative: { g: { Social: 85, 'On-chain health': 55, 'Wallet cleanliness': 45, Momentum: 80 }, boost: ['f1', 'f20', 'f18'] },
  safety: { g: { Social: 30, 'On-chain health': 85, 'Wallet cleanliness': 100, Momentum: 30 }, boost: ['f12', 'f15'] },
  sniper: { g: { Social: 55, 'On-chain health': 60, 'Wallet cleanliness': 60, Momentum: 75 }, boost: ['f11', 'f16', 'f6'] },
  momentum: { g: { Social: 45, 'On-chain health': 70, 'Wallet cleanliness': 50, Momentum: 95 }, boost: ['f7', 'f8', 'f18'] },
  insider: { g: { Social: 50, 'On-chain health': 60, 'Wallet cleanliness': 85, Momentum: 50 }, boost: ['f12', 'f17', 'f5'] },
  balanced: { g: { Social: 60, 'On-chain health': 60, 'Wallet cleanliness': 60, Momentum: 60 }, boost: [] },
  whale: { g: { Social: 30, 'On-chain health': 90, 'Wallet cleanliness': 70, Momentum: 55 }, boost: ['f6', 'f7', 'f10'] },
};
const factorWeight = (a, f) => Math.min(100, (a.g[f.g] || 50) + (a.boost.indexOf(f.k) >= 0 ? 12 : 0));

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const logScore = (v, lo, hi) => {
  if (!v || v <= 0) return 0;
  return clamp(Math.round(((Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * 100));
};

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const mint = (url.searchParams.get('mint') || '').trim();
  const archId = (url.searchParams.get('archetype') || 'balanced').trim();
  if (!MINT_RE.test(mint)) return json({ error: "That doesn't look like a Solana mint address." }, 400);
  const arch = ARCH[archId] || ARCH.balanced;

  const KEY = env.HELIUS_API_KEY;
  if (!KEY) return json({ error: 'Scoring backend not configured (missing Helius key).' }, 503);
  const EP = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
  const rpc = async (method, params) => {
    const r = await fetch(EP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await r.json(); if (j.error) throw new Error(`${method}: ${j.error.message || 'rpc error'}`); return j.result;
  };

  try {
    const [dex, acct, largest, supply] = await Promise.all([
      fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`).then((r) => r.json()).catch(() => null),
      rpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }]).catch(() => null),
      rpc('getTokenLargestAccounts', [mint]).catch(() => null),
      rpc('getTokenSupply', [mint]).catch(() => null),
    ]);

    const p = pickPair(dex && dex.pairs, mint);
    if (!p) return json({ error: 'No Solana trading pair found for this mint.' }, 200);

    const info = acct && acct.value && acct.value.data && acct.value.data.parsed && acct.value.data.parsed.info;
    const mintAuth = info ? info.mintAuthority !== null : null;
    const freezeAuth = info ? info.freezeAuthority !== null : null;

    // Hub-aware retail concentration (top-10 % excluding pools/CEX).
    const total = supply && supply.value ? Number(supply.value.amount) : 0;
    let retailTop10 = null;
    const accts = (largest && largest.value) || [];
    if (accts.length && total) {
      const taInfos = await rpc('getMultipleAccounts', [accts.map((a) => a.address), { encoding: 'jsonParsed' }]).catch(() => null);
      const owners = accts.map((a, i) => (taInfos && taInfos.value[i] && taInfos.value[i].data && taInfos.value[i].data.parsed && taInfos.value[i].data.parsed.info && taInfos.value[i].data.parsed.info.owner) || null);
      const distinct = [...new Set(owners.filter(Boolean))];
      let progOf = {};
      if (distinct.length) {
        const oi = await rpc('getMultipleAccounts', [distinct, { encoding: 'jsonParsed' }]).catch(() => null);
        if (oi && oi.value) distinct.forEach((o, i) => { progOf[o] = oi.value[i] && oi.value[i].owner; });
      }
      let retailSum = 0;
      accts.forEach((a, i) => {
        const o = owners[i];
        const isPool = (o && KNOWN_OWNERS[o]) || (o && progOf[o] && progOf[o] !== SYSTEM_PROGRAM);
        if (!isPool) retailSum += Number(a.amount);
      });
      retailTop10 = retailSum / total;
    }

    const liq = (p.liquidity && p.liquidity.usd) || 0;
    const vol24 = (p.volume && p.volume.h24) || 0;
    const vol1h = (p.volume && p.volume.h1) || 0;
    const tx = p.txns || {};
    const buys = (tx.h24 && tx.h24.buys) || 0, sells = (tx.h24 && tx.h24.sells) || 0;
    const chg = p.priceChange || {};
    const ageMs = p.pairCreatedAt || 0;
    const ageDays = ageMs ? (Date.now() - ageMs) / 86400000 : null;
    const mcap = p.marketCap || p.fdv || 0;

    // ---- factor values (0..100) or null if pending ----
    const V = {};
    V.f6 = logScore(liq, 3000, 1000000);
    V.f7 = vol24 > 0 ? clamp(Math.round(0.6 * logScore(vol24, 5000, 5000000) + 0.4 * clamp(50 + (vol1h * 24 - vol24) / Math.max(vol24, 1) * 50))) : 0;
    V.f8 = (buys + sells) > 0 ? Math.round((buys / (buys + sells)) * 100) : null;
    V.f10 = retailTop10 != null ? clamp(Math.round(100 - retailTop10 * 100)) : null;
    V.f11 = ageDays != null ? clamp(Math.round(20 + 80 * (1 - Math.exp(-ageDays / 21)))) : null;
    V.f13 = mintAuth == null ? null : (mintAuth ? 0 : 100);
    V.f14 = freezeAuth == null ? null : (freezeAuth ? 0 : 100);
    V.f18 = chg.h24 != null ? clamp(Math.round(50 + chg.h24)) : null;
    V.f19 = mcap > 0 ? (mcap < 50000 ? 30 : mcap < 1e6 ? 70 : mcap < 1e7 ? 85 : 60) : null;

    const factors = FACTORS.map((f) => {
      const val = V[f.k];
      const available = val !== undefined && val !== null;
      return { k: f.k, name: f.n, group: f.g, gate: !!f.gate, available, value: available ? val : null, weight: factorWeight(arch, f) };
    });

    // ---- hard gates ----
    const gateFails = [];
    if (mintAuth === true) gateFails.push('mint authority not revoked');
    if (freezeAuth === true) gateFails.push('freeze authority not revoked');
    const gatedReject = gateFails.length > 0 && archId !== 'degen';

    // ---- composite over available weighted (non-gate) factors ----
    let wsum = 0, vsum = 0;
    factors.filter((f) => !f.gate && f.available).forEach((f) => { wsum += f.weight; vsum += f.weight * f.value; });
    let composite = wsum ? Math.round(vsum / wsum) : null;
    if (gatedReject && composite != null) composite = Math.min(composite, 12);

    const availableCount = factors.filter((f) => f.available).length;
    const verdict = gatedReject
      ? `Auto-rejected: ${gateFails.join(' + ')} — fails a hard gate for the ${archId} profile.`
      : composite == null ? 'Not enough on-chain data to score.'
      : composite >= 70 ? 'Strong on the on-chain factors we can read live.'
      : composite >= 45 ? 'Mixed — passable on-chain; weigh against the pending factors.'
      : 'Weak on the readable on-chain factors.';

    return json({
      mint, archetype: archId,
      market: { name: (p.baseToken && p.baseToken.name) || 'Unknown', symbol: ((p.baseToken && p.baseToken.symbol) || '?').replace(/^\$/, ''), priceUsd: parseFloat(p.priceUsd) || 0, mcap, liq, vol24, dex: p.dexId, ageDays: ageDays != null ? Math.round(ageDays) : null },
      gates: { passed: gateFails.length === 0, fails: gateFails, rejected: gatedReject },
      composite, verdict,
      availableCount, totalFactors: FACTORS.length,
      pendingNote: 'Social (5), holder-growth, dev-wallet behavior, LP lock/burn, sniper/bundle, insider-cluster and narrative heat need paid X-data, deeper traces, or the Brain — excluded from this composite, not faked. Insider-cluster: see /api/funding.',
      factors,
      source: 'helius+dexscreener', ts: Date.now(),
    }, 200, { 'cache-control': 'public, max-age=30' });
  } catch (e) {
    return json({ error: e.message || 'Scoring failed.' }, 502);
  }
}
