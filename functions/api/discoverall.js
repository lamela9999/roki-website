// GET /api/discoverall
// One call → the live trending Solana universe scored for ALL 10 archetypes at once, so the
// paper-bot can run 10 wallets in parallel off a single scan. Same cheap on-chain factors as
// /api/discoverboard. KV-cached (trending feed rate-limits CF). Fund-safe, read-only.

import { json, preflight, pickPair, solRpc } from './_utils.js';

export const onRequestOptions = () => preflight();

const ARCH = {
  degen: { Social: 90, 'On-chain health': 40, 'Wallet cleanliness': 25, Momentum: 95 },
  conservative: { Social: 35, 'On-chain health': 90, 'Wallet cleanliness': 95, Momentum: 45 },
  smart: { Social: 60, 'On-chain health': 65, 'Wallet cleanliness': 80, Momentum: 55 },
  narrative: { Social: 85, 'On-chain health': 55, 'Wallet cleanliness': 45, Momentum: 80 },
  safety: { Social: 30, 'On-chain health': 85, 'Wallet cleanliness': 100, Momentum: 30 },
  sniper: { Social: 55, 'On-chain health': 60, 'Wallet cleanliness': 60, Momentum: 75 },
  momentum: { Social: 45, 'On-chain health': 70, 'Wallet cleanliness': 50, Momentum: 95 },
  insider: { Social: 50, 'On-chain health': 60, 'Wallet cleanliness': 85, Momentum: 50 },
  balanced: { Social: 60, 'On-chain health': 60, 'Wallet cleanliness': 60, Momentum: 60 },
  whale: { Social: 30, 'On-chain health': 90, 'Wallet cleanliness': 70, Momentum: 55 },
};
const FACTORS = [
  { k: 'liq', g: 'On-chain health' }, { k: 'vol', g: 'On-chain health' }, { k: 'pressure', g: 'On-chain health' },
  { k: 'age', g: 'On-chain health' }, { k: 'priceTrend', g: 'Momentum' }, { k: 'lifecycle', g: 'Momentum' },
];
const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const logScore = (v, lo, hi) => (!v || v <= 0) ? 0 : clamp(Math.round(((Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * 100));

export async function onRequestGet({ request, env }) {
  const KEY = env.HELIUS_API_KEY;
  if (!KEY) return json({ error: 'Needs Helius key.' }, 503);
  const KV = env.ZEN_KV;
  const dexGet = async (u) => { for (let i = 0; i < 4; i++) { try { const r = await fetch(u); if (r.ok) return await r.json(); } catch (e) { /**/ } await new Promise((res) => setTimeout(res, 300)); } return null; };
  const rpc = (m, p) => solRpc(m, p, env);
  const cached = async () => (KV ? KV.get('radar:discoverall', 'json').catch(() => null) : null);

  try {
    const top = await dexGet('https://api.dexscreener.com/token-boosts/top/v1');
    const latest = await dexGet('https://api.dexscreener.com/token-boosts/latest/v1');
    const seen = new Set(); let mints = [];
    for (const list of [top || [], latest || []]) for (const b of list) {
      if (b && b.chainId === 'solana' && b.tokenAddress && !seen.has(b.tokenAddress)) { seen.add(b.tokenAddress); mints.push(b.tokenAddress); }
    }
    mints = mints.slice(0, 18);
    if (!mints.length) { const c = await cached(); return c ? json({ ...c, stale: true }, 200) : json({ error: 'Trending feed rate-limited — retry.' }, 200); }

    const [pairsArr, accInfos] = await Promise.all([
      Promise.all(mints.map((m) => dexGet(`https://api.dexscreener.com/latest/dex/tokens/${m}`))),
      rpc('getMultipleAccounts', [mints, { encoding: 'jsonParsed' }]).catch(() => null),
    ]);

    const results = mints.map((mint, i) => {
      const p = pickPair(pairsArr[i] && pairsArr[i].pairs, mint);
      if (!p) return null;
      const info = accInfos && accInfos.value && accInfos.value[i] && accInfos.value[i].data && accInfos.value[i].data.parsed && accInfos.value[i].data.parsed.info;
      const gateLive = info ? (info.mintAuthority !== null || info.freezeAuthority !== null) : false;
      const liq = (p.liquidity && p.liquidity.usd) || 0, vol24 = (p.volume && p.volume.h24) || 0;
      const tx = (p.txns && p.txns.h24) || {}; const buys = tx.buys || 0, sells = tx.sells || 0;
      const ageMs = p.pairCreatedAt || 0; const ageDays = ageMs ? (Date.now() - ageMs) / 86400000 : null;
      const mcap = p.marketCap || p.fdv || 0; const chg = (p.priceChange && p.priceChange.h24);
      const V = {
        liq: logScore(liq, 3000, 1000000), vol: logScore(vol24, 5000, 5000000),
        pressure: (buys + sells) > 0 ? Math.round((buys / (buys + sells)) * 100) : null,
        age: ageDays != null ? clamp(Math.round(20 + 80 * (1 - Math.exp(-ageDays / 21)))) : null,
        priceTrend: chg != null ? clamp(Math.round(50 + chg)) : null,
        lifecycle: mcap > 0 ? (mcap < 50000 ? 30 : mcap < 1e6 ? 70 : mcap < 1e7 ? 85 : 60) : null,
      };
      const scores = {};
      for (const a in ARCH) {
        let wsum = 0, vsum = 0;
        FACTORS.forEach((f) => { if (V[f.k] != null) { const w = ARCH[a][f.g] || 50; wsum += w; vsum += w * V[f.k]; } });
        let c = wsum ? Math.round(vsum / wsum) : null;
        const rejected = gateLive && a !== 'degen';
        if (rejected && c != null) c = Math.min(c, 12);
        scores[a] = { c, r: rejected };
      }
      return {
        mint, symbol: ((p.baseToken && p.baseToken.symbol) || '?').replace(/^\$/, ''), name: (p.baseToken && p.baseToken.name) || 'Unknown',
        market: { priceUsd: parseFloat(p.priceUsd) || 0, mcap, liq, ageDays: ageDays != null ? Math.round(ageDays) : null, dex: p.dexId },
        gateLive, scores,
      };
    }).filter(Boolean);

    const out = { count: results.length, results, ts: Date.now(), source: 'helius+dexscreener' };
    if (KV && results.length) await KV.put('radar:discoverall', JSON.stringify(out), { expirationTtl: 600 }).catch(() => {});
    return json(out, 200, { 'cache-control': 'public, max-age=60' });
  } catch (e) {
    const c = await cached(); return c ? json({ ...c, stale: true }, 200) : json({ error: e.message || 'failed' }, 502);
  }
}
