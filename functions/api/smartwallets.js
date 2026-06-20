// GET /api/smartwallets
// Find REAL candidate smart-money wallets: scan the current trending Solana tokens, pull each
// one's recent swaps (Helius), and rank the wallets that came out net-positive in SOL across
// them. Recent-window proxy (not lifetime PnL); the maintained chain-wide list is the Brain
// (backend). Cached in KV so it stays populated when the trending feed rate-limits CF.

import { json, preflight } from './_utils.js';

export const onRequestOptions = () => preflight();

const TOKENS_TO_SCAN = 6;
const TX_PER_TOKEN = 60;

export async function onRequestGet({ request, env }) {
  const KEY = env.HELIUS_API_KEY;
  if (!KEY) return json({ error: 'Needs the Helius backend (key not set).' }, 503);
  const KV = env.ZEN_KV;
  const dexGet = async (u) => { for (let i = 0; i < 3; i++) { try { const r = await fetch(u); if (r.ok) return await r.json(); } catch (e) { /**/ } await new Promise((res) => setTimeout(res, 300)); } return null; };
  const cached = async () => (KV ? KV.get('radar:smartwallets', 'json').catch(() => null) : null);

  try {
    const top = await dexGet('https://api.dexscreener.com/token-boosts/top/v1');
    const seen = new Set(); let mints = [];
    for (const b of top || []) { if (b && b.chainId === 'solana' && b.tokenAddress && !seen.has(b.tokenAddress)) { seen.add(b.tokenAddress); mints.push(b.tokenAddress); } }
    mints = mints.slice(0, TOKENS_TO_SCAN);
    if (!mints.length) { const c = await cached(); return c ? json({ ...c, stale: true }, 200) : json({ error: 'Trending feed rate-limited — retry shortly.' }, 200); }

    // symbols for the scanned tokens (one batch)
    const symOf = {};
    try { const ds = await dexGet('https://api.dexscreener.com/latest/dex/tokens/' + mints.join(',')); for (const p of (ds && ds.pairs) || []) { const m = p.baseToken && p.baseToken.address; if (m && !symOf[m]) symOf[m] = (p.baseToken.symbol || '').replace(/^\$/, ''); } } catch (e) { /**/ }

    const wallets = {};
    for (const mint of mints) {
      try {
        const r = await fetch(`https://api.helius.xyz/v0/addresses/${mint}/transactions?api-key=${KEY}&type=SWAP&limit=${TX_PER_TOKEN}`);
        if (!r.ok) continue;
        const txs = await r.json(); if (!Array.isArray(txs)) continue;
        const per = {};
        for (const t of txs) {
          const sw = t.events && t.events.swap; if (!sw) continue;
          const trader = t.feePayer; if (!trader) continue;
          const nIn = (sw.nativeInput && Number(sw.nativeInput.amount)) || 0;   // SOL spent (buy)
          const nOut = (sw.nativeOutput && Number(sw.nativeOutput.amount)) || 0; // SOL received (sell)
          per[trader] = per[trader] || { in: 0, out: 0, n: 0 };
          per[trader].in += nIn; per[trader].out += nOut; per[trader].n++;
        }
        const sym = symOf[mint] || mint.slice(0, 4);
        for (const addr of Object.keys(per)) {
          const p = per[addr]; const net = (p.out - p.in) / 1e9;
          const w = wallets[addr] = wallets[addr] || { addr, netSol: 0, trades: 0, tokens: [] };
          w.netSol += net; w.trades += p.n;
          if (w.tokens.indexOf(sym) < 0) w.tokens.push(sym);
        }
      } catch (e) { /**/ }
    }

    const list = Object.keys(wallets).map((k) => wallets[k])
      .filter((w) => w.tokens.length >= 2 || Math.abs(w.netSol) >= 0.05) // multi-token traders or non-trivial SOL flow
      .sort((a, b) => b.netSol - a.netSol)
      .slice(0, 20)
      .map((w) => ({ addr: w.addr, netSol: +w.netSol.toFixed(2), tokens: w.tokens, tokensTraded: w.tokens.length, label: w.netSol > 0 ? (w.tokens.length > 1 ? 'smart money' : 'net-positive') : 'net-negative' }));

    const out = {
      scannedTokens: mints.map((m) => symOf[m] || m.slice(0, 4)),
      walletsFound: list.length,
      wallets: list,
      note: 'Wallets that traded the current trending tokens, ranked by net SOL across them. Recent-window proxy via Helius (not lifetime PnL). A maintained chain-wide PnL list is the Brain backend.',
      source: 'helius+dexscreener', ts: Date.now(),
    };
    if (KV && list.length) await KV.put('radar:smartwallets', JSON.stringify(out), { expirationTtl: 600 }).catch(() => {});
    return json(out, 200, { 'cache-control': 'public, max-age=300' });
  } catch (e) {
    const c = await cached(); return c ? json({ ...c, stale: true }, 200) : json({ error: e.message || 'Smart-wallet scan failed.' }, 502);
  }
}
