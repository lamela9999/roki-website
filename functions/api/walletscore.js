// GET /api/walletscore?addr=<wallet>
// Layer-1 moat (lite): score a wallet's recent realized trading from its swap history and
// label it (smart money / mixed / fresh / inactive). Fund-safe, read-only, key server-side.
//
// Method: pull the last N SWAP transactions (Helius enhanced API), sum native-SOL in vs out
// per token → realized SOL flow + per-token win rate. This is a RECENT-WINDOW realized proxy
// (ignores unrealized value of current bags); full lifetime PnL + funding-lineage clustering
// is the heavier backend job. Bounded to fit Cloudflare Pages Function CPU limits.

import { json, preflight } from './_utils.js';

export const onRequestOptions = () => preflight();

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SWAP_LIMIT = 60; // recent swaps to analyse (CPU budget)

export async function onRequestGet({ request, env }) {
  const addr = (new URL(request.url).searchParams.get('addr') || '').trim();
  if (!ADDR_RE.test(addr)) return json({ error: "That doesn't look like a Solana wallet address." }, 400);

  const KEY = env.HELIUS_API_KEY;
  if (!KEY) return json({ error: 'Backend not configured (missing Helius key).' }, 503);

  try {
    const r = await fetch(`https://api.helius.xyz/v0/addresses/${addr}/transactions?api-key=${KEY}&type=SWAP&limit=${SWAP_LIMIT}`);
    if (!r.ok) return json({ error: `Helius enhanced API ${r.status}` }, 502);
    const txs = await r.json();
    if (!Array.isArray(txs) || !txs.length) {
      return json({ addr, swaps: 0, label: 'inactive', note: 'No recent swap activity found for this wallet.', source: 'helius', ts: Date.now() }, 200);
    }

    let solIn = 0, solOut = 0;           // lamports spent on buys / received from sells
    let swaps = 0;
    const perToken = {};                 // mint -> { in, out } (SOL lamports)
    let oldest = Infinity, newest = 0;

    for (const t of txs) {
      const sw = t.events && t.events.swap;
      if (!sw) continue;
      swaps++;
      if (t.timestamp) { oldest = Math.min(oldest, t.timestamp); newest = Math.max(newest, t.timestamp); }
      const nIn = (sw.nativeInput && Number(sw.nativeInput.amount)) || 0;   // SOL spent (buy)
      const nOut = (sw.nativeOutput && Number(sw.nativeOutput.amount)) || 0; // SOL received (sell)
      solIn += nIn; solOut += nOut;
      // attribute to the non-SOL token in the swap
      const outTok = (sw.tokenOutputs && sw.tokenOutputs[0] && sw.tokenOutputs[0].mint);
      const inTok = (sw.tokenInputs && sw.tokenInputs[0] && sw.tokenInputs[0].mint);
      if (nIn && outTok) { perToken[outTok] = perToken[outTok] || { in: 0, out: 0 }; perToken[outTok].in += nIn; }
      if (nOut && inTok) { perToken[inTok] = perToken[inTok] || { in: 0, out: 0 }; perToken[inTok].out += nOut; }
    }

    const netSol = (solOut - solIn) / 1e9;
    const tokens = Object.keys(perToken);
    const closed = tokens.filter((m) => perToken[m].in > 0 && perToken[m].out > 0);
    const winners = closed.filter((m) => perToken[m].out > perToken[m].in).length;
    const winRate = closed.length ? winners / closed.length : null;
    const spanDays = (oldest !== Infinity && newest) ? Math.max(0, (newest - oldest) / 86400) : null;

    // Label — conservative; a recent window can't prove a wallet is "smart", only suggest it.
    let label, confidence;
    if (swaps < 4) { label = 'fresh'; confidence = 0.3; }
    else if (netSol > 0 && winRate != null && winRate >= 0.5 && closed.length >= 4) { label = 'smart money (recent)'; confidence = Math.min(0.8, 0.45 + closed.length * 0.03); }
    else if (netSol > 0) { label = 'net-positive (recent)'; confidence = 0.5; }
    else if (netSol < 0) { label = 'net-negative (recent)'; confidence = 0.5; }
    else { label = 'mixed'; confidence = 0.4; }

    return json({
      addr,
      window: `last ${swaps} swaps`,
      swaps,
      distinctTokens: tokens.length,
      closedPositions: closed.length,
      winRate,                       // 0..1 over closed positions
      realizedSol: +netSol.toFixed(3), // net SOL from trading in the window (proxy PnL)
      spanDays: spanDays != null ? Math.round(spanDays) : null,
      label, confidence,
      note: 'Recent-window realized-SOL proxy (last swaps). Ignores unrealized value of current holdings; full lifetime PnL + funding-lineage clustering is the heavier backend job.',
      source: 'helius', ts: Date.now(),
    }, 200, { 'cache-control': 'public, max-age=60' });
  } catch (e) {
    return json({ error: e.message || 'Wallet score failed.' }, 502);
  }
}
