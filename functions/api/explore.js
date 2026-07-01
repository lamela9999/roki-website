// GET /api/explore                      → aggregate stats + a browsable token list
// GET /api/explore?filter=crashed|smart|traded&sort=seen|drawdown|pnl|cap
// GET /api/explore?token=<mint>          → a single token's full dossier (who bought/sold it,
//                                          cap peak→now, signals, the lab's trade outcomes on it)
// GET /api/explore?wallet=<addr>         → a single wallet's record
//
// Pure read/compose over the research DBs we already store (radar:db:tokens / :tokenwallets /
// :smartmap / :wallets). The "data center" the lab is accumulating, made browsable + verifiable.

import { json, preflight, rankWinners } from './_utils.js';

export const onRequestOptions = () => preflight();
const SIG_SHOW = ['smart-money', 'accumulation', 'volume-spike', 'crashed', 'trending', 'fresh'];

export async function onRequestGet({ request, env }) {
  const KV = env.ZEN_KV;
  if (!KV) return json({ error: 'Data center needs KV storage.' }, 503);
  const url = new URL(request.url);

  const [tdb, twdb, smap, wdb] = await Promise.all([
    KV.get('radar:db:tokens', 'json').catch(() => null),
    KV.get('radar:db:tokenwallets', 'json').catch(() => null),
    KV.get('radar:db:smartmap', 'json').catch(() => null),
    KV.get('radar:db:wallets', 'json').catch(() => null),
  ]);
  const tokens = (tdb && tdb.tokens) || {};

  // rank of each proven-winner wallet (v3: ROI + consistency, not raw net SOL)
  const winners = {};
  if (wdb && wdb.wallets) rankWinners(wdb.wallets, 300).forEach((w, i) => { winners[w.addr] = i + 1; });

  // ---- single wallet ----
  const wa = url.searchParams.get('wallet');
  if (wa) {
    const w = wdb && wdb.wallets && wdb.wallets[wa];
    if (!w) return json({ error: 'wallet not in our database yet' }, 404);
    return json({ addr: wa, ...w, tokens: Object.keys(w.toks || {}), winnerRank: winners[wa] || null }, 200, { 'cache-control': 'public, max-age=30' });
  }

  // ---- single token dossier ----
  const tk = url.searchParams.get('token');
  if (tk) {
    const t = tokens[tk];
    const tw = twdb && twdb.tokens && twdb.tokens[tk];
    const sm = smap && smap.tokens && smap.tokens[tk];
    if (!t && !tw) return json({ error: 'This token is not in our database yet — it has to be scanned at least once.' }, 404);
    const capMax = (t && t.capMax) || 0, capLast = (t && t.capLast) || 0;
    const drawdown = capMax > 0 ? +(1 - capLast / capMax).toFixed(3) : 0;
    const wallets = tw ? (tw.wallets || []).map((w) => ({ ...w, winnerRank: winners[w.addr] || null })) : [];
    return json({
      mint: tk, sym: (t && t.sym) || (tw && tw.sym) || '?', name: (t && t.name) || '',
      capMax, capMin: (t && t.capMin) || 0, capLast, drawdown,
      seen: (t && t.seen) || 0, first: t && t.first, last: t && t.last,
      signals: (t && t.sig) || {},
      outcomes: { buys: (t && t.buys) || 0, sells: (t && t.sells) || 0, wins: (t && t.wins) || 0, losses: (t && t.losses) || 0, pnl: (t && t.pnl) || 0 },
      wallets, traders: (tw && tw.traders) || wallets.length,
      smart: sm ? { buying: sm.count || 0, selling: sm.sellers || 0, present: sm.present || 0, score: sm.score || 0 } : null,
    }, 200, { 'cache-control': 'public, max-age=30' });
  }

  // ---- token list ----
  const sort = url.searchParams.get('sort') || 'seen';
  const filter = url.searchParams.get('filter') || 'all';
  let arr = Object.keys(tokens).map((m) => {
    const t = tokens[m]; const dd = (t.capMax > 0) ? (1 - (t.capLast || 0) / t.capMax) : 0;
    const sm = smap && smap.tokens && smap.tokens[m];
    return {
      mint: m, sym: t.sym, name: t.name, capLast: t.capLast || t.capMax || 0, capMax: t.capMax || 0,
      drawdown: +dd.toFixed(2), seen: t.seen || 0, traded: (t.sells || 0) > 0, wins: t.wins || 0, losses: t.losses || 0,
      pnl: +(t.pnl || 0).toFixed(0), smart: sm ? (sm.count || 0) : 0,
      sigs: Object.keys(t.sig || {}).filter((s) => SIG_SHOW.indexOf(s) >= 0),
    };
  });
  if (filter === 'crashed') arr = arr.filter((t) => t.drawdown >= 0.9);
  else if (filter === 'smart') arr = arr.filter((t) => t.smart > 0);
  else if (filter === 'traded') arr = arr.filter((t) => t.traded);
  const S = { seen: (a, b) => b.seen - a.seen, drawdown: (a, b) => b.drawdown - a.drawdown, pnl: (a, b) => b.pnl - a.pnl, cap: (a, b) => b.capLast - a.capLast };
  arr.sort(S[sort] || S.seen);

  return json({
    stats: { tokens: (tdb && tdb.n) || arr.length, scans: (tdb && tdb.scans) || 0, wallets: (wdb && wdb.n) || 0, winners: Object.keys(winners).length, edge: (tdb && tdb.edge) || {} },
    count: arr.length, sort, filter, tokens: arr.slice(0, 150),
  }, 200, { 'cache-control': 'public, max-age=30' });
}
