// GET /api/walletdb            → the wallet leaderboard (read-only, cheap): top traders by net
//                                SOL across every token we've observed, growing over time.
// GET /api/walletdb?scan=1      → analyze a BATCH of tokens (cron-driven, spends Helius credits):
//                                pull every wallet that swapped them, fold into the wallet DB.
// GET /api/walletdb?addr=<pk>   → one wallet's full observed record.
//
// This is the growing "who's who" of Solana traders the lab has seen. We prioritise the tokens
// the bots currently HOLD (so we learn who aped alongside them), then fill with live trending.
// Net SOL across observed tokens is a recent-window performance PROXY (not lifetime PnL) — it
// sharpens as the DB accumulates. Decoupled from the lab tick to respect CF subrequest limits.

import { json, preflight, buildUniverse, rankWinners, rankLosers } from './_utils.js';

export const onRequestOptions = () => preflight();

const BATCH = 16;       // tokens analyzed per scan call (keeps us under the CF subrequest cap)
const TX_PER = 80;      // recent swaps pulled per token
const WMAX = 15000;     // wallet DB cap (prune least-recently-seen beyond this)
const DBKEY = 'radar:db:wallets';

function loadFromState(state) {
  // mints the bots currently hold — highest-value to learn "who else is in this with us"
  const held = new Set();
  try { for (const id in state.bots) { const p = state.bots[id].positions || {}; for (const m in p) held.add(m); } } catch (e) { /**/ }
  return [...held];
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const KV = env.ZEN_KV;
  if (!KV) return json({ error: 'Wallet DB needs KV storage.' }, 503);
  const url = new URL(request.url);
  const nowTs = Date.now();

  // ---- single wallet lookup ----
  const addr = url.searchParams.get('addr');
  if (addr) {
    const db = await KV.get(DBKEY, 'json').catch(() => null);
    const w = db && db.wallets && db.wallets[addr];
    if (!w) return json({ error: 'wallet not in DB yet' }, 404);
    return json({ addr, ...w, tokens: Object.keys(w.toks || {}) }, 200, { 'cache-control': 'no-store' });
  }

  // ---- smart-money alerts: tokens proven-winner wallets are accumulating right now ----
  if (url.searchParams.get('smart')) {
    const smap = await KV.get('radar:db:smartmap', 'json').catch(() => null);
    if (!smap || !smap.tokens) return json({ smartCount: 0, alerts: [] }, 200, { 'cache-control': 'public, max-age=30' });
    const cutoff = nowTs - 6 * 60 * 60 * 1000; // last 6h
    const alerts = Object.keys(smap.tokens).map((m) => ({ mint: m, ...smap.tokens[m] }))
      .filter((t) => (t.present || t.count || 0) > 0 && (t.updated || 0) > cutoff)
      .sort((a, b) => b.score - a.score).slice(0, 30);
    return json({ smartCount: smap.smartCount || 0, updated: smap.updated, alerts }, 200, { 'cache-control': 'public, max-age=30' });
  }

  // ---- who aped a token: the wallets we've observed swapping it, ranked by net SOL on it ----
  const tokenMint = url.searchParams.get('token');
  if (tokenMint) {
    const tw = await KV.get('radar:db:tokenwallets', 'json').catch(() => null);
    const e = tw && tw.tokens && tw.tokens[tokenMint];
    if (!e) return json({ mint: tokenMint, wallets: [], note: 'not analyzed yet' }, 200, { 'cache-control': 'no-store' });
    return json({ mint: tokenMint, ...e }, 200, { 'cache-control': 'public, max-age=60' });
  }

  // ---- leaderboard (default, read-only) ----
  if (!url.searchParams.get('scan')) {
    const db = await KV.get(DBKEY, 'json').catch(() => null);
    if (!db || !db.wallets) return json({ n: 0, scans: 0, top: [] }, 200, { 'cache-control': 'no-store' });
    const arr = Object.keys(db.wallets).map((a) => ({ addr: a, ...db.wallets[a] }));
    const top = arr.filter((w) => (w.n || 0) >= 3)
      .sort((a, b) => (b.netSol || 0) - (a.netSol || 0))
      .slice(0, 500)
      .map((w, i) => ({
        rank: i + 1, addr: w.addr, netSol: +(w.netSol || 0).toFixed(2), trades: w.n || 0,
        tokens: Object.keys(w.toks || {}).slice(0, 8), tokenCount: Object.keys(w.toks || {}).length,
        first: w.first, last: w.last, label: (w.netSol || 0) > 0 ? (Object.keys(w.toks || {}).length > 2 ? 'consistent winner' : 'net-positive') : 'net-negative',
        twitter: w.twitter || null,
      }));
    return json({ n: db.n || arr.length, scans: db.scans || 0, firstTs: db.firstTs, updated: db.updated, top }, 200, { 'cache-control': 'public, max-age=30' });
  }

  // ---- scan a batch (cron-driven; spends Helius credits) ----
  const KEY = env.HELIUS_API_KEY;
  if (!KEY) return json({ error: 'Scan needs the Helius backend (key not set).' }, 503);

  // pick tokens: bots' current holdings first, then live trending, dedup
  const lab = await KV.get('radar:lab', 'json').catch(() => null);
  const held = lab ? loadFromState(lab) : [];
  let trending = [];
  try { const cand = await buildUniverse(env); trending = cand.slice(0, 30).map((c) => c.mint); } catch (e) { /**/ }
  // rotate through the trending set across calls (separate key — never touch the lab state)
  const cursor = ((await KV.get('radar:db:wcursor', 'json').catch(() => null)) || { i: 0 }).i || 0;
  const rotated = trending.slice(cursor).concat(trending.slice(0, cursor));
  const seen = new Set(); const list = [];
  for (const m of [...held, ...rotated]) { if (m && !seen.has(m)) { seen.add(m); list.push(m); } }
  const batch = list.slice(0, BATCH);
  if (!batch.length) return json({ analyzed: 0, note: 'no tokens to analyze yet' }, 200);

  // symbols for the batch (one DexScreener call)
  const symOf = {};
  try { const ds = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + batch.join(',')).then((r) => r.json()); for (const p of (ds && ds.pairs) || []) { const m = p.baseToken && p.baseToken.address; if (m && !symOf[m]) symOf[m] = (p.baseToken.symbol || '').replace(/^\$/, ''); } } catch (e) { /**/ }

  // symbol fallback: the lab's token DB already knows most tickers (DexScreener can rate-limit)
  const tdb = await KV.get('radar:db:tokens', 'json').catch(() => null);
  const symFor = (m) => symOf[m] || (tdb && tdb.tokens && tdb.tokens[m] && tdb.tokens[m].sym) || m.slice(0, 4);

  let db = await KV.get(DBKEY, 'json').catch(() => null);
  if (!db || !db.wallets) db = { wallets: {}, scans: 0, firstTs: nowTs };
  db.scans++; db.updated = nowTs;

  let analyzed = 0, newW = 0, txSeen = 0;
  const tokWalletsBatch = {}; // mint -> top wallets on THIS token (for the "who aped" view)
  const perByMint = {};       // mint -> raw per-wallet flow (for the smart-money map below)
  for (const mint of batch) {
    try {
      const r = await fetch(`https://api.helius.xyz/v0/addresses/${mint}/transactions?api-key=${KEY}&type=SWAP&limit=${TX_PER}`);
      if (!r.ok) continue;
      const txs = await r.json(); if (!Array.isArray(txs)) continue;
      analyzed++;
      const sym = symFor(mint);
      const per = {};
      for (const t of txs) {
        const sw = t.events && t.events.swap; if (!sw) continue;
        const tr = t.feePayer; if (!tr) continue;
        const nIn = (sw.nativeInput && Number(sw.nativeInput.amount)) || 0;   // SOL spent (buy)
        const nOut = (sw.nativeOutput && Number(sw.nativeOutput.amount)) || 0; // SOL received (sell)
        const p = per[tr] = per[tr] || { in: 0, out: 0, n: 0 };
        p.in += nIn; p.out += nOut; p.n++; txSeen++;
      }
      for (const a of Object.keys(per)) {
        const p = per[a];
        let w = db.wallets[a];
        if (!w) { w = db.wallets[a] = { first: nowTs, n: 0, inSol: 0, outSol: 0, netSol: 0, toks: {} }; newW++; }
        w.last = nowTs; w.n += p.n;
        w.inSol = +(w.inSol + p.in / 1e9).toFixed(3);
        w.outSol = +(w.outSol + p.out / 1e9).toFixed(3);
        w.netSol = +(w.outSol - w.inSol).toFixed(3);
        w.toks[sym] = (w.toks[sym] || 0) + 1;
      }
      // top wallets ON this token (ranked by net SOL on it) → the "who aped" snapshot
      const tw = Object.keys(per).map((a) => ({ addr: a, net: +((per[a].out - per[a].in) / 1e9).toFixed(3), n: per[a].n }))
        .sort((x, y) => y.net - x.net).slice(0, 15);
      tokWalletsBatch[mint] = { sym, updated: nowTs, traders: Object.keys(per).length, wallets: tw };
      perByMint[mint] = { per, sym };
    } catch (e) { /**/ }
  }

  // prune least-recently-seen beyond the cap
  const keys = Object.keys(db.wallets);
  if (keys.length > WMAX) { keys.sort((a, b) => (db.wallets[a].last || 0) - (db.wallets[b].last || 0)); for (let i = 0; i < keys.length - WMAX; i++) delete db.wallets[keys[i]]; }
  db.n = Object.keys(db.wallets).length;
  await KV.put(DBKEY, JSON.stringify(db)).catch(() => {});

  // merge the per-token "who aped" snapshots (own KV key, bounded by recency)
  if (Object.keys(tokWalletsBatch).length) {
    try {
      let twdb = await KV.get('radar:db:tokenwallets', 'json').catch(() => null);
      if (!twdb || !twdb.tokens) twdb = { tokens: {} };
      Object.assign(twdb.tokens, tokWalletsBatch);
      const tk = Object.keys(twdb.tokens);
      if (tk.length > 2500) { tk.sort((a, b) => (twdb.tokens[a].updated || 0) - (twdb.tokens[b].updated || 0)); for (let i = 0; i < tk.length - 2500; i++) delete twdb.tokens[tk[i]]; }
      await KV.put('radar:db:tokenwallets', JSON.stringify(twdb));
    } catch (e) { /**/ }
  }

  // ---- THE SMART-MONEY MAP: which proven-winner wallets are ACCUMULATING each token now ----
  // v3 "winner" = ROI ≥1.15× on ≥1 SOL in, ≥5 swaps, ranked by ROI×consistency (rankWinners) —
  // the old raw-net-SOL ranking crowned dumpers and measured anti-predictive (-$19.7/trade).
  if (Object.keys(perByMint).length) {
    try {
      const SMART_TOP = 150;
      const ranked = rankWinners(db.wallets, SMART_TOP);
      const rankOf = {}; ranked.forEach((w, i) => { rankOf[w.addr] = i + 1; }); // 1 = best
      const loserSet = new Set(rankLosers(db.wallets, 300).map((w) => w.addr)); // dumb-money crowd
      let smap = await KV.get('radar:db:smartmap', 'json').catch(() => null);
      if (!smap || !smap.tokens) smap = { tokens: {} };
      for (const mint of Object.keys(perByMint)) {
        const { per, sym } = perByMint[mint];
        const buyers = [], sellers = [];
        let whales = 0, dumb = 0;
        for (const a of Object.keys(per)) {
          if (per[a].in >= 20e9) whales++;                 // 20+ SOL into THIS token = whale entry
          if (loserSet.has(a)) dumb++;                     // consistent loser present = top marker
          if (rankOf[a] == null) continue;                 // only proven winners below
          const net = (per[a].out - per[a].in) / 1e9;      // <0 = accumulating, >0 = distributing
          if (net < 0) buyers.push({ addr: a, rank: rankOf[a], tokenNet: +net.toFixed(2) });
          else if (net > 0) sellers.push({ addr: a, rank: rankOf[a], tokenNet: +net.toFixed(2) });
        }
        buyers.sort((x, y) => x.rank - y.rank); sellers.sort((x, y) => x.rank - y.rank);
        const present = buyers.length + sellers.length;
        if (present > 0 || whales > 0 || dumb > 0) {
          // conviction score: ranked accumulators add, distributors subtract
          const score = +(buyers.reduce((s, b) => s + (SMART_TOP + 1 - b.rank) / SMART_TOP, 0) - sellers.length * 0.3).toFixed(2);
          smap.tokens[mint] = { sym, score, count: buyers.length, sellers: sellers.length, present, whales, dumb, buyers: buyers.slice(0, 10), updated: nowTs };
        }
      }
      const sk = Object.keys(smap.tokens);
      if (sk.length > 2500) { sk.sort((a, b) => (smap.tokens[a].updated || 0) - (smap.tokens[b].updated || 0)); for (let i = 0; i < sk.length - 2500; i++) delete smap.tokens[sk[i]]; }
      smap.updated = nowTs; smap.smartCount = ranked.length;
      await KV.put('radar:db:smartmap', JSON.stringify(smap));
    } catch (e) { /**/ }
  }

  // advance the trending cursor (separate key) so the next scan covers different tokens
  try { await KV.put('radar:db:wcursor', JSON.stringify({ i: (cursor + BATCH) % Math.max(1, trending.length || 1) })); } catch (e) { /**/ }

  // redundancy: also nudge the lab to advance, so if THIS cron runs the lab keeps trading even
  // if its own cron has stopped (non-blocking via waitUntil)
  try { const labUrl = new URL('/api/lab?tick=1', request.url).toString(); if (context.waitUntil) context.waitUntil(fetch(labUrl)); } catch (e) { /**/ }

  return json({ analyzed, batch: batch.length, txSeen, walletsKnown: db.n, newWallets: newW, scans: db.scans, ts: nowTs }, 200, { 'cache-control': 'no-store' });
}
