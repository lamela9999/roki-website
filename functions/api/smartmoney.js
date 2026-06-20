// GET /api/smartmoney?mint=<mint>
// Live trader board for ONE token: aggregate its recent swaps by trader (feePayer) into
// realized SOL flow on this token → rank who's actually net-positive trading it right now.
// Fund-safe, read-only, one Helius call. This is a RECENT-WINDOW, single-token realized read
// (not a wallet's lifetime PnL — that's /api/walletscore and, fuller, the backend).

import { json, preflight } from './_utils.js';

export const onRequestOptions = () => preflight();

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TX_LIMIT = 100; // recent swaps to aggregate (single call; CPU-bounded)

export async function onRequestGet({ request, env }) {
  const mint = (new URL(request.url).searchParams.get('mint') || '').trim();
  if (!MINT_RE.test(mint)) return json({ error: "That doesn't look like a Solana mint address." }, 400);

  const KEY = env.HELIUS_API_KEY;
  if (!KEY) return json({ error: 'Backend not configured (missing Helius key).' }, 503);

  try {
    const r = await fetch(`https://api.helius.xyz/v0/addresses/${mint}/transactions?api-key=${KEY}&type=SWAP&limit=${TX_LIMIT}`);
    if (!r.ok) return json({ error: `Helius enhanced API ${r.status}` }, 502);
    const txs = await r.json();
    if (!Array.isArray(txs) || !txs.length) {
      return json({ mint, traders: [], swaps: 0, note: 'No recent swap activity for this token.', source: 'helius', ts: Date.now() }, 200);
    }

    const by = {}; // trader -> { solBuy, solSell, trades }
    let swaps = 0, oldest = Infinity, newest = 0;
    for (const t of txs) {
      const sw = t.events && t.events.swap;
      const who = t.feePayer;
      if (!sw || !who) continue;
      swaps++;
      if (t.timestamp) { oldest = Math.min(oldest, t.timestamp); newest = Math.max(newest, t.timestamp); }
      const nIn = (sw.nativeInput && Number(sw.nativeInput.amount)) || 0;   // SOL spent (buy)
      const nOut = (sw.nativeOutput && Number(sw.nativeOutput.amount)) || 0; // SOL received (sell)
      const e = by[who] || (by[who] = { solBuy: 0, solSell: 0, trades: 0 });
      e.solBuy += nIn; e.solSell += nOut; e.trades++;
    }

    let traders = Object.keys(by).map((addr) => {
      const e = by[addr];
      return {
        addr,
        trades: e.trades,
        netSol: +((e.solSell - e.solBuy) / 1e9).toFixed(3),
        boughtSol: +(e.solBuy / 1e9).toFixed(3),
        soldSol: +(e.solSell / 1e9).toFixed(3),
        closed: e.solBuy > 0 && e.solSell > 0,
      };
    });
    // Rank by realized net SOL on this token; keep meaningful participants.
    traders = traders.filter((t) => t.trades >= 1).sort((a, b) => b.netSol - a.netSol);
    const winSpanH = (oldest !== Infinity && newest) ? Math.round((newest - oldest) / 3600) : null;

    return json({
      mint,
      swaps,
      distinctTraders: traders.length,
      windowHours: winSpanH,
      window: `last ${swaps} swaps`,
      traders: traders.slice(0, 12),
      note: 'Realized SOL flow per trader over this token\'s recent swaps. Recent-window, single-token read — not a wallet\'s lifetime PnL. Open positions (buy-only) show negative until they sell.',
      source: 'helius', ts: Date.now(),
    }, 200, { 'cache-control': 'public, max-age=45' });
  } catch (e) {
    return json({ error: e.message || 'Smart-money board failed.' }, 502);
  }
}
