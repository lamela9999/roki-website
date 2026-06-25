// GET /api/lab            → read the live lab state (advances one tick if past-due)
// GET /api/lab?peek=1     → read only, never advance (cheap; for UI auto-refresh)
// GET /api/lab?tick=1     → force-advance one tick if past-due (used by the cron pinger)
//
// THE LAB: 10 archetype bots, each a $2,000 demo wallet, trade the live trending Solana
// universe 24/7 — server-side, in Cloudflare KV, so they keep trading even when nobody is
// watching. Every sim-day each bot reviews its own trades, learns a lesson, and adjusts its
// own parameters (and we keep the full day-by-day adjustment journal). A bot that 10×'s
// graduates (champion, frozen); one that loses 90% busts (frozen, dead). If the field thins
// out, a new season respawns the dead with their lessons intact. Fund-safe, read-only, paper.

import { json, preflight, pickPair, solRpc, jupPrices, buildUniverse } from './_utils.js';

export const onRequestOptions = () => preflight();

const V = 5;                       // schema version. Bumping does NOT wipe — migrate() preserves
                                   // all trades/history/balances. Add field defaults there instead.
// STRATEGY version. Bumping THIS archives the finished run (checkable via ?version=N) and starts
// a fresh run with the new strategy — that's the deliberate "v1 did this, now we try v2" cycle,
// separate from the schema version above. Each bump records the lessons that drove the change.
const STRATEGY_VERSION = 2;
const STRATEGY_LESSONS = {
  2: [
    'Chasing volume-spikes lost ~41% on average (33 trades) — v2 removes spikes as a buy trigger entirely.',
    'Accumulation was the only signal near breakeven — v2 makes quiet accumulation the primary buy across most archetypes.',
    'Stops were too wide (34 stop-losses cost ~$4.9k; tokens fell ~25% before exit) — v2 tightens stops to 6–22%.',
    '$100k–1M caps bled worst (-37%); $1–10M held best (-6%) — v2 shifts every cap band upward.',
    'Thin pools cost ~5%/side in slippage — v2 raises liquidity floors hard (12k–60k) for deeper, cheaper fills.',
    'Sniping the first candle was -91% — v2 sniper waits for age, real liquidity and buy-pressure before entering.',
  ],
};
const START = 2000;                // each wallet starts here
const GRAD = START * 10;           // 10× → graduate (champion)
const BUST = START * 0.10;         // lose 90% → bust (dead)
const TICK_MS = 10 * 60 * 1000;    // minimum spacing between ticks
const DAY_MS = 24 * 60 * 60 * 1000;
const FEE = 0.99;                  // 1% taker fee each side
const POOL = 48;                   // candidate tokens fetched per tick (batched, multi-source)
// Full lifetime ledger — keep thousands of trades so the history is "from day one", never a
// rolling window. (10 bots × 4000 trades × ~0.25KB ≈ 10MB, well under the 25MB KV value cap.)
const TRADES_KEEP = 4000, EQUITY_KEEP = 1500, HISTORY_KEEP = 400;
const LOG_PREVIEW = 40; // recent trades sent in the leaderboard payload; full ledger via ?bot=
const KVKEY = 'radar:lab';

const BOTS = [
  { id: 'degen', name: 'Degen Aper', dial: 88 },
  { id: 'conservative', name: 'Conservative Hunter', dial: 22 },
  { id: 'smart', name: 'Smart-Money Follower', dial: 55 },
  { id: 'narrative', name: 'Narrative Rider', dial: 70 },
  { id: 'safety', name: 'Safety Maximalist', dial: 10 },
  { id: 'sniper', name: 'Early Sniper', dial: 78 },
  { id: 'momentum', name: 'Momentum Trader', dial: 66 },
  { id: 'insider', name: 'Insider Watcher', dial: 44 },
  { id: 'balanced', name: 'Balanced', dial: 50 },
  { id: 'whale', name: 'Liquidity Whale', dial: 34 },
];
// scoring weights per archetype (same as /api/discoverall)
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
// how much each discovery signal nudges each archetype's score (spikes suit momentum/degen,
// quiet accumulation suits whales/conservatives) — so the broadened universe changes behaviour
// v2: volume-spike bonus REMOVED (it averaged -41%). Accumulation boosted + widened (only
// signal that held up). Trending kept small; fresh small for sniper.
const SRC_BONUS = {
  accumulation: { smart: 9, insider: 9, whale: 8, conservative: 8, safety: 6, balanced: 6, momentum: 4, narrative: 4, degen: 4 },
  trending: { narrative: 4, balanced: 2, momentum: 2 },
  fresh: { sniper: 3 },
};
const SRC_RANK = ['volume-spike', 'accumulation', 'trending', 'fresh', 'boosted', 'volume', 'new-boost', 'profile'];
const primarySrc = (sources) => { for (const s of SRC_RANK) if (sources && sources.indexOf(s) >= 0) return s; return (sources && sources[0]) || 'trending'; };
// Derive activity signals straight from the DexScreener pair (works from CF even when the
// GeckoTerminal trending/volume feeds don't): a volume-spike = last hour running well above
// the 24h average pace; accumulation = steady positive drift with buy-side pressure.
function deriveTags(p) {
  const v = p.volume || {}, pc = p.priceChange || {}, tx = p.txns || {};
  const h1 = +v.h1 || 0, h24v = +v.h24 || 0, tags = [];
  if (h24v > 0 && h1 >= 2500 && (h1 * 24) / h24v >= 2.2) tags.push('volume-spike');
  const h6c = +pc.h6 || 0, pd = +pc.h24 || 0, t6 = tx.h6 || {}, buys = +t6.buys || 0, sells = +t6.sells || 0;
  if (tags.indexOf('volume-spike') < 0 && pd >= 2 && pd <= 60 && h6c >= 0 && (buys + sells) > 0 && buys / (buys + sells) >= 0.55) tags.push('accumulation');
  return tags;
}

// STRATEGY v2 — rebuilt from v1's real results (v1 lost ~30% in a day). The data said:
//   • buying AFTER a volume-spike averaged -41% → stop chasing spikes (removed as a trigger)
//   • accumulation was the only ~breakeven signal → make it the primary buy trigger, widely
//   • stops were too wide (tokens fell ~25% before exit) → tighter stops elsewhere (baseParams)
//   • $100k–1M caps bled worst (-37%), $1–10M held best (-6%) → shift bands up
//   • thin pools cost ~5%/side slippage → raise liquidity floors hard (deeper pools)
//   • sniping the first candle was -91% → require confirmation (age, liquidity, buy-pressure)
// `trig(M)` is the signal that makes it buy. M = raw per-token metrics from scanUniverse.
const PROFILE = {
  degen:        { capMin: 50e3,  capMax: 3e6,   liqMin: 12e3, hold: 6,  trig: (m) => m.accum || (m.ageDays != null && m.ageDays < 2 && m.pc6 > 3 && m.pc6 < 40 && m.buyRatio6 > 0.55 && !m.spike), label: 'early movers, not blow-off tops' },
  sniper:       { capMin: 40e3,  capMax: 2e6,   liqMin: 15e3, hold: 6,  trig: (m) => m.ageDays != null && m.ageDays >= 0.3 && m.ageDays < 7 && m.clean && m.liq >= 15e3 && m.buyRatio6 > 0.55 && m.pc24 > -8, label: 'confirmed early launches' },
  insider:      { capMin: 50e3,  capMax: 3e6,   liqMin: 12e3, hold: 18, trig: (m) => m.accum && m.clean,                                                                     label: 'early quiet accumulation' },
  smart:        { capMin: 100e3, capMax: 8e6,   liqMin: 20e3, hold: 20, trig: (m) => m.accum && m.clean,                                                                     label: 'clean accumulation' },
  momentum:     { capMin: 200e3, capMax: 25e6,  liqMin: 30e3, hold: 10, trig: (m) => m.pc6 > 3 && m.pc6 < 35 && m.pc1 > -2 && m.buyRatio6 > 0.55 && !m.spike,                 label: 'sustained momentum, not spikes' },
  narrative:    { capMin: 150e3, capMax: 25e6,  liqMin: 20e3, hold: 14, trig: (m) => m.srcTrendy && m.pc24 > 0 && m.pc24 < 60 && !m.spike,                                    label: 'hot narratives, pre-blowoff' },
  balanced:     { capMin: 100e3, capMax: 50e6,  liqMin: 15e3, hold: 24, trig: (m) => m.accum || (m.pc6 > 0 && m.pc6 < 30 && m.buyRatio6 > 0.52),                              label: 'steady, mid-cap tilt' },
  whale:        { capMin: 1e6,   capMax: 300e6, liqMin: 60e3, hold: 36, trig: (m) => m.liq >= 60e3 && m.pc6 <= 2 && m.pc6 >= -12 && m.pc24 > -20,                             label: 'deep-liquidity dips' },
  conservative: { capMin: 500e3, capMax: 300e6, liqMin: 50e3, hold: 40, trig: (m) => m.clean && m.ageDays != null && m.ageDays > 2 && m.pc6 < 1 && m.pc6 > -15,              label: 'established pullbacks' },
  safety:       { capMin: 500e3, capMax: 300e6, liqMin: 60e3, hold: 40, trig: (m) => m.clean && m.liq >= 60e3 && m.pc24 >= -10 && m.pc24 <= 25,                              label: 'safest, deep + clean' },
};
// does this archetype want this token? (cap band + liquidity floor + its trigger + quality bar)
function eligible(prof, M, scoreObj, bar) {
  if (!scoreObj || scoreObj.r || scoreObj.c == null) return false;
  if (M.mcap < prof.capMin || M.mcap > prof.capMax) return false;
  if (M.liq < prof.liqMin) return false;
  if (!prof.trig(M)) return false;
  return scoreObj.c >= bar;
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const logScore = (v, lo, hi) => (!v || v <= 0) ? 0 : clamp(Math.round(((Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * 100), 0, 100);
const clT = (n) => clamp(Math.round(n), 25, 85);   // threshold
const clTP = (n) => clamp(Math.round(n), 12, 140);  // take-profit %
const clSL = (n) => clamp(Math.round(n), 5, 60);    // stop-loss %
const clPos = (n) => clamp(+n.toFixed(4), 0.01, 0.30); // position size % of equity

function baseParams(dial) {
  const d = dial;
  return {
    posPct: clPos((1 + d / 100 * 24) / 100),    // 1%..25% of equity
    threshold: clT(70 - d / 100 * 25),          // 70..45 entry bar
    tp: clTP(20 + d / 100 * 60),                // +20%..+80%
    sl: clSL(6 + d / 100 * 16),                 // v2: -6%..-22% (was -8..-50; stops were too wide)
    slip: +((0.5 + d / 100 * 4.5) / 100).toFixed(4), // 0.5%..5% (fixed, not learned)
    maxHold: Math.round(40 - d / 100 * 28),     // ticks held before time-stop (degen flips fast)
  };
}
const maxPosOf = (p) => Math.max(2, Math.min(8, Math.floor(0.6 / p.posPct)));

function freshWallet(dial) {
  return {
    cash: START, positions: {}, trades: [], realized: 0, wins: 0, losses: 0, peak: START,
    params: baseParams(dial), lives: 1, status: 'active',
    equity: [], history: [], dayWins: 0, dayLosses: 0, dayRealized: 0, dayTrades: 0,
  };
}
function freshState(nowTs) {
  const bots = {};
  BOTS.forEach((b) => { bots[b.id] = freshWallet(b.dial); });
  return { v: V, startedTs: nowTs, lastTickTs: 0, tick: 0, day: 0, lastLearnDay: 0, season: 1, ticking: 0, bots, strategyVersion: STRATEGY_VERSION, versions: [], versionStartedTs: nowTs };
}
// Bring an older saved state up to the current schema WITHOUT ever discarding trades, history,
// positions or balances. Version changes migrate (fill in any missing fields with defaults);
// they never wipe. This is what keeps the ledger permanent across engine updates.
function migrate(state, nowTs) {
  if (!state || typeof state !== 'object' || !state.bots) return freshState(nowTs);
  BOTS.forEach((b) => {
    let w = state.bots[b.id];
    if (!w || typeof w !== 'object') { state.bots[b.id] = freshWallet(b.dial); return; }
    if (!Array.isArray(w.trades)) w.trades = [];
    if (!Array.isArray(w.history)) w.history = [];
    if (!Array.isArray(w.equity)) w.equity = [];
    if (!w.params || typeof w.params !== 'object') w.params = baseParams(b.dial);
    if (w.cash == null) w.cash = START;
    if (!w.positions || typeof w.positions !== 'object') w.positions = {};
    if (w.realized == null) w.realized = 0;
    if (w.wins == null) w.wins = 0;
    if (w.losses == null) w.losses = 0;
    if (w.peak == null) w.peak = Math.max(START, w.cash);
    if (w.status == null) w.status = 'active';
    if (w.lives == null) w.lives = 1;
    if (w.dayWins == null) w.dayWins = 0;
    if (w.dayLosses == null) w.dayLosses = 0;
    if (w.dayRealized == null) w.dayRealized = 0;
    if (w.dayTrades == null) w.dayTrades = 0;
  });
  if (state.startedTs == null) state.startedTs = nowTs;
  if (state.tick == null) state.tick = 0;
  if (state.day == null) state.day = 0;
  if (state.lastLearnDay == null) state.lastLearnDay = 0;
  if (state.season == null) state.season = 1;
  if (state.lastTickTs == null) state.lastTickTs = 0;
  if (state.strategyVersion == null) state.strategyVersion = 1;
  if (!Array.isArray(state.versions)) state.versions = [];
  state.v = V; // mark migrated; data preserved
  return state;
}

// When the STRATEGY_VERSION in code is newer than the saved run, archive the finished run
// (summary kept in state.versions for the UI; full per-bot ledgers returned for KV) and start a
// fresh run with the new strategy. Returns { key, data } to persist, or null if nothing to do.
function applyStrategyVersion(state, nowTs) {
  const from = state.strategyVersion || 1;
  if (from >= STRATEGY_VERSION) return null;
  const perBot = BOTS.map((b) => {
    const w = state.bots[b.id]; const eq = Math.round(totalEquity(w));
    return { id: b.id, name: b.name, equity: eq, pnlPct: +((eq / START - 1) * 100).toFixed(1), wins: w.wins, losses: w.losses, trades: (w.trades || []).length, status: w.status };
  });
  const startEq = BOTS.length * START, endEq = perBot.reduce((s, x) => s + x.equity, 0);
  const archiveLedgers = {};
  BOTS.forEach((b) => { archiveLedgers[b.id] = (state.bots[b.id].trades || []); });
  const summary = {
    version: from, startedTs: state.versionStartedTs || state.startedTs, endedTs: nowTs,
    endedDay: state.day, endedTick: state.tick, startEquity: startEq, endEquity: endEq,
    pnlPct: +((endEq / startEq - 1) * 100).toFixed(1), perBot,
    leader: perBot.slice().sort((a, c) => c.equity - a.equity)[0],
    worst: perBot.slice().sort((a, c) => a.equity - c.equity)[0],
    nextLessons: STRATEGY_LESSONS[from + 1] || [],
  };
  state.versions.unshift(summary);
  if (state.versions.length > 20) state.versions.pop();
  // fresh run for the new strategy version (v1 archived above is fully preserved + checkable)
  BOTS.forEach((b) => { state.bots[b.id] = freshWallet(b.dial); });
  state.strategyVersion = STRATEGY_VERSION;
  state.versionStartedTs = nowTs;
  state.season = 1; state.day = 0; state.lastLearnDay = 0; state.startedTs = nowTs; state.tick = 0;
  state.lastTickTs = 0; // let the fresh run start trading immediately
  return { key: KVKEY + ':archive:v' + from, data: { version: from, summary, ledgers: archiveLedgers, ts: nowTs } };
}

function totalEquity(w) {
  let v = w.cash;
  for (const m in w.positions) { const p = w.positions[m]; v += p.qty * (p.last || p.entry); }
  return v;
}

// ---- one scan of the candidate universe → rich metrics + per-archetype scores ----
async function scanUniverse(env, nowTs) {
  const dexGet = async (u) => { for (let i = 0; i < 3; i++) { try { const r = await fetch(u); if (r.ok) return await r.json(); } catch (e) { /**/ } await new Promise((res) => setTimeout(res, 250)); } return null; };
  const cand = await buildUniverse();
  if (!cand.length) return null;
  const pool = cand.slice(0, POOL);
  const mints = pool.map((c) => c.mint);
  const srcOf = {}; pool.forEach((c) => { srcOf[c.mint] = c.sources; });

  // batch DexScreener market data (up to 30 mints per call) + one authorities RPC
  const chunks = []; for (let i = 0; i < mints.length; i += 30) chunks.push(mints.slice(i, i + 30));
  const [pairResults, accInfos] = await Promise.all([
    Promise.all(chunks.map((ch) => dexGet('https://api.dexscreener.com/latest/dex/tokens/' + ch.join(',')))),
    solRpc('getMultipleAccounts', [mints, { encoding: 'jsonParsed' }], env).catch(() => null),
  ]);
  const pairsByMint = {};
  for (const r of pairResults) for (const p of (r && r.pairs) || []) { const m = p.baseToken && p.baseToken.address; if (m) (pairsByMint[m] = pairsByMint[m] || []).push(p); }
  const authOf = {};
  if (accInfos && accInfos.value) mints.forEach((m, i) => { const v = accInfos.value[i]; const info = v && v.data && v.data.parsed && v.data.parsed.info; authOf[m] = info ? { mint: info.mintAuthority !== null, freeze: info.freezeAuthority !== null, has: true } : { has: false }; });

  const out = [];
  for (const mint of mints) {
    const p = pickPair(pairsByMint[mint], mint);
    if (!p) continue;
    const price = parseFloat(p.priceUsd) || 0; if (!(price > 0)) continue;
    const auth = authOf[mint] || { has: false };
    const clean = !!auth.has && !auth.mint && !auth.freeze;          // both authorities revoked
    const gateLive = auth.has ? (auth.mint || auth.freeze) : false;
    const liq = (p.liquidity && p.liquidity.usd) || 0;
    const vol24 = (p.volume && p.volume.h24) || 0, vol6 = (p.volume && p.volume.h6) || 0, vol1 = (p.volume && p.volume.h1) || 0;
    const pcN = (x) => { const n = p.priceChange && p.priceChange[x]; return n != null ? +n : 0; };
    const pc1 = pcN('h1'), pc6 = pcN('h6'), pc24 = pcN('h24');
    const txN = (x) => { const t = (p.txns && p.txns[x]) || {}; return { b: +t.buys || 0, s: +t.sells || 0 }; };
    const t6 = txN('h6'), t24 = txN('h24');
    const buyRatio6 = (t6.b + t6.s) > 0 ? t6.b / (t6.b + t6.s) : 0.5;
    const buyRatio24 = (t24.b + t24.s) > 0 ? t24.b / (t24.b + t24.s) : 0.5;
    const ageMs = p.pairCreatedAt || 0; const ageDays = ageMs ? (nowTs - ageMs) / DAY_MS : null;
    const mcap = p.marketCap || p.fdv || 0;
    const sources = (srcOf[mint] || []).slice();
    deriveTags(p).forEach((t) => { if (sources.indexOf(t) < 0) sources.push(t); });
    const spike = sources.indexOf('volume-spike') >= 0;
    const accum = sources.indexOf('accumulation') >= 0;
    const reawaken = ageDays != null && ageDays > 7 && spike;            // dormant token suddenly active
    const srcTrendy = sources.indexOf('trending') >= 0 || sources.indexOf('boosted') >= 0 || sources.indexOf('new-boost') >= 0;
    const M = { mcap, liq, ageDays, vol24, vol6, vol1, pc1, pc6, pc24, buyRatio6, buyRatio24, spike, accum, reawaken, clean, srcTrendy };

    const Vv = {
      liq: logScore(liq, 3000, 1000000), vol: logScore(vol24, 5000, 5000000),
      pressure: Math.round(buyRatio24 * 100),
      age: ageDays != null ? clamp(Math.round(20 + 80 * (1 - Math.exp(-ageDays / 21))), 0, 100) : null,
      priceTrend: clamp(Math.round(50 + pc24), 0, 100),
      lifecycle: mcap > 0 ? (mcap < 50000 ? 40 : mcap < 1e6 ? 75 : mcap < 1e7 ? 85 : 60) : null,
    };
    const scores = {};
    for (const a in ARCH) {
      let wsum = 0, vsum = 0;
      FACTORS.forEach((f) => { if (Vv[f.k] != null) { const w = ARCH[a][f.g] || 50; wsum += w; vsum += w * Vv[f.k]; } });
      let c = wsum ? Math.round(vsum / wsum) : null;
      if (c != null) { let bonus = 0; sources.forEach((s) => { if (SRC_BONUS[s] && SRC_BONUS[s][a]) bonus += SRC_BONUS[s][a]; }); if (bonus) c = Math.min(100, c + bonus); }
      const rejected = gateLive && a !== 'degen';
      if (rejected && c != null) c = Math.min(c, 12);
      scores[a] = { c, r: rejected };
    }
    out.push({ mint, symbol: ((p.baseToken && p.baseToken.symbol) || '?').replace(/^\$/, ''), name: (p.baseToken && p.baseToken.name) || 'Unknown', price, mcap, liq, M, scores, sources, src: primarySrc(sources) });
  }
  return out;
}

// price impact from finite pool depth: a trade worth `usd` against `liq` liquidity moves the
// price against you ~ the fraction of the pool you take (capped). On top of the archetype's
// base spread/MEV assumption. This is why you never get the full mid-price round-trip back.
const impactOf = (usd, liq) => (liq > 0 ? Math.min(0.10, usd / liq) : 0.10);

function buy(w, mint, price, symbol, tick, ctx) {
  const p = w.params;
  const total = totalEquity(w);
  const usd = Math.max(20, Math.round(total * p.posPct));
  if (w.cash < usd) return;
  const liq = ctx.liq || 0;
  const impact = impactOf(usd, liq);
  const slip = p.slip + impact;               // total slippage = base spread + price impact
  const eff = price * (1 + slip);             // effective fill price (worse than mid)
  const qty = (usd * FEE) / eff;              // tokens received after 1% fee
  w.cash -= usd;
  w.positions[mint] = {
    symbol, mid: price, entry: eff, usdIn: usd, qty, last: price, tick, ts: ctx.ts,
    mcapIn: ctx.mcap || 0, liqIn: liq, src: ctx.src, sources: ctx.sources || [], scoreIn: ctx.score, barIn: p.threshold,
    baseSlip: p.slip, slipIn: slip,
  };
  w.trades.unshift({
    tick, ts: ctx.ts, side: 'BUY', symbol, mint, usd, src: ctx.src, sources: ctx.sources || [],
    score: ctx.score, bar: p.threshold, price, mcap: ctx.mcap || 0, qty, liq, slipPct: +(slip * 100).toFixed(2),
  });
  if (w.trades.length > TRADES_KEEP) w.trades.pop();
}
function sell(w, mint, price, reason, tick, ts, liqNow) {
  const pos = w.positions[mint]; if (!pos) return;
  const liq = liqNow > 0 ? liqNow : (pos.liqIn || 0);
  const grossUsd = pos.qty * price;                   // mid-value of the bag right now
  const impact = impactOf(grossUsd, liq);
  const slip = (pos.baseSlip || w.params.slip) + impact;
  const eff = price * (1 - slip);                     // effective exit price (worse than mid)
  const proceeds = pos.qty * eff * FEE;               // cash back after slippage + 1% fee
  const pnl = proceeds - pos.usdIn;
  const netPct = (proceeds / pos.usdIn - 1) * 100;    // what you ACTUALLY made
  const movePct = pos.mid > 0 ? (price / pos.mid - 1) * 100 : 0; // raw token price move (mid->mid)
  const mcapOut = pos.mid > 0 ? Math.round(pos.mcapIn * (price / pos.mid)) : pos.mcapIn;
  w.cash += proceeds;
  w.realized += pnl;
  if (pnl >= 0) { w.wins++; w.dayWins++; } else { w.losses++; w.dayLosses++; }
  w.dayRealized += pnl; w.dayTrades++;
  const rec = {
    tick, ts, side: 'SELL', symbol: pos.symbol, mint, reason,
    usdIn: Math.round(pos.usdIn), proceeds: +proceeds.toFixed(2), pnl: +pnl.toFixed(2), pnlPct: +netPct.toFixed(1),
    movePct: +movePct.toFixed(1), entryPrice: pos.mid, exitPrice: price, mcapIn: pos.mcapIn, mcapOut,
    qty: pos.qty, slipPct: +(slip * 100).toFixed(2), feePct: 1, heldTicks: tick - pos.tick,
    tsIn: pos.ts || null, src: pos.src, scoreIn: pos.scoreIn, barIn: pos.barIn,
  };
  w.trades.unshift(rec);
  if (w.trades.length > TRADES_KEEP) w.trades.pop();
  delete w.positions[mint];
  return rec;
}

// ---- the growing research database: every scanned token is logged + accrues a track record ----
// Lives in its own KV key (radar:db:tokens). Each tick we merge the scanned universe (cap range,
// liquidity, which signals fired, how often we've seen it) and fold in any trade outcomes, so the
// longer the lab runs the more it KNOWS about which tokens/signals/caps actually pay.
const DB_MAX = 6000;
async function updateTokenDB(env, universe, closures, nowTs) {
  const KV = env.ZEN_KV; if (!KV) return null;
  let db = await KV.get('radar:db:tokens', 'json').catch(() => null);
  if (!db || !db.tokens) db = { tokens: {}, scans: 0, firstTs: nowTs };
  db.scans++; db.updated = nowTs;
  for (const u of universe) {
    let t = db.tokens[u.mint];
    if (!t) t = db.tokens[u.mint] = { sym: u.symbol, name: u.name, first: nowTs, seen: 0, capMin: u.mcap, capMax: u.mcap, sig: {}, buys: 0, sells: 0, wins: 0, losses: 0, pnl: 0 };
    t.last = nowTs; t.seen++; t.capLast = u.mcap; t.liqLast = u.liq;
    if (u.mcap > 0) { t.capMin = Math.min(t.capMin || u.mcap, u.mcap); t.capMax = Math.max(t.capMax || 0, u.mcap); }
    (u.sources || []).forEach((s) => { t.sig[s] = (t.sig[s] || 0) + 1; });
  }
  for (const c of closures || []) {
    const t = db.tokens[c.mint]; if (!t) continue;
    t.sells++; t.pnl = +((t.pnl || 0) + c.pnl).toFixed(2); if (c.pnl >= 0) t.wins++; else t.losses++;
  }
  // bound the registry: when over cap, drop the least-recently-seen tokens
  const keys = Object.keys(db.tokens);
  if (keys.length > DB_MAX) {
    keys.sort((a, b) => (db.tokens[a].last || 0) - (db.tokens[b].last || 0));
    for (let i = 0; i < keys.length - DB_MAX; i++) delete db.tokens[keys[i]];
  }
  db.n = Object.keys(db.tokens).length;
  try { await KV.put('radar:db:tokens', JSON.stringify(db)); } catch (e) { /**/ }
  return { n: db.n, scans: db.scans };
}

// ---- the daily lesson: review the day's trades, adjust own params, journal it ----
function learn(w, day) {
  const dw = w.dayWins || 0, dl = w.dayLosses || 0, dr = w.dayRealized || 0, dt = w.dayTrades || 0;
  const closed = dw + dl;
  const before = { threshold: w.params.threshold, tp: w.params.tp, sl: w.params.sl, posPct: w.params.posPct };
  const p = w.params, changes = [];
  let headline;
  if (closed >= 3) {
    const wr = dw / closed;
    if (wr < 0.40) {
      p.threshold = clT(p.threshold + 4);
      changes.push('Win rate only ' + Math.round(wr * 100) + '% — raising the entry bar to ' + p.threshold + ' (be pickier).');
      if (dr < 0) { p.sl = clSL(p.sl - 3); changes.push('Lost money on losers — tightening stop-loss to ' + p.sl + '% to cut them faster.'); }
      headline = 'Too many bad entries — getting more selective.';
    } else if (wr > 0.62) {
      p.threshold = clT(p.threshold - 3); p.tp = clTP(p.tp + 5);
      changes.push('Win rate ' + Math.round(wr * 100) + '% — lowering the bar to ' + p.threshold + ' (trade more) and raising take-profit to ' + p.tp + '% (let winners run).');
      headline = 'Strategy is working — pressing the edge.';
    } else {
      changes.push('Win rate ' + Math.round(wr * 100) + '% — solid; only fine-tuning.');
      headline = 'Steady day — minor adjustments.';
    }
    if (dr < 0) { p.posPct = clPos(p.posPct * 0.9); changes.push('Red day — sizing positions smaller (now ' + Math.round(p.posPct * 100) + '% of equity).'); }
    else if (dr > 0) { p.posPct = clPos(p.posPct * 1.06); changes.push('Green day — sizing up a touch (now ' + Math.round(p.posPct * 100) + '% of equity).'); }
  } else {
    changes.push('Only ' + closed + ' closed trade' + (closed === 1 ? '' : 's') + ' today — not enough signal, keeping strategy steady.');
    headline = 'Quiet day — no strategy change.';
  }
  const after = { threshold: p.threshold, tp: p.tp, sl: p.sl, posPct: p.posPct };
  w.history.unshift({ day, headline, wr: closed ? Math.round(dw / closed * 100) : null, realizedDay: +dr.toFixed(2), trades: dt, equity: Math.round(totalEquity(w)), changes, before, after });
  if (w.history.length > HISTORY_KEEP) w.history.pop();
  w.dayWins = 0; w.dayLosses = 0; w.dayRealized = 0; w.dayTrades = 0;
}

// ---- advance the whole lab one tick ----
async function advance(state, env, nowTs) {
  const universe = await scanUniverse(env, nowTs);
  if (!universe || !universe.length) return false;

  const uPrice = {}, uScore = {};
  universe.forEach((u) => { uPrice[u.mint] = u.price; uScore[u.mint] = u; });

  // record what kinds of tokens this scan surfaced (for the UI)
  const uniTags = {};
  universe.forEach((u) => (u.sources || []).forEach((s) => { uniTags[s] = (uniTags[s] || 0) + 1; }));
  state.universe = { n: universe.length, tags: uniTags };

  // the "calls" board: every scanned project, its rating, the signals it fired, and which
  // archetypes are interested in it (cap band + liquidity + trigger pass, before each bot's bar)
  state.calls = universe.map((u) => {
    const interested = BOTS.filter((b) => {
      const pr = PROFILE[b.id], s = u.scores[b.id];
      return s && !s.r && s.c != null && u.M.mcap >= pr.capMin && u.M.mcap <= pr.capMax && u.M.liq >= pr.liqMin && pr.trig(u.M);
    }).map((b) => b.id);
    const rating = Math.max(0, ...BOTS.map((b) => (u.scores[b.id] && u.scores[b.id].c) || 0));
    const tags = []; if (u.M.spike) tags.push('volume-spike'); if (u.M.accum) tags.push('accumulation'); if (u.M.reawaken) tags.push('reawaken'); if (u.M.clean) tags.push('clean');
    return { mint: u.mint, symbol: u.symbol, name: u.name, mcap: u.mcap, liq: u.liq, ageDays: u.M.ageDays != null ? +u.M.ageDays.toFixed(1) : null, pc24: +u.M.pc24.toFixed(1), src: u.src, rating, interested, tags };
  }).sort((a, b) => b.rating - a.rating).slice(0, 24);

  // price any held tokens that fell out of the trending set
  const need = new Set();
  BOTS.forEach((b) => { const w = state.bots[b.id]; for (const m in w.positions) if (uPrice[m] == null) need.add(m); });
  let extra = {};
  if (need.size) { try { extra = await jupPrices([...need]); } catch (e) { /**/ } }
  const priceOf = (m) => (uPrice[m] != null ? uPrice[m] : (extra[m] && extra[m].price));

  state.tick++;
  const tick = state.tick;
  const closures = []; // trade outcomes this tick → folded into the research DB

  for (const b of BOTS) {
    const w = state.bots[b.id];
    if (w.status !== 'active') continue;
    const p = w.params;
    const prof = PROFILE[b.id];

    // manage open positions (hold horizon is per-archetype)
    for (const m of Object.keys(w.positions)) {
      const pos = w.positions[m];
      const price = priceOf(m);
      if (price == null || !(price > 0)) continue;
      pos.last = price;
      const liqNow = (uScore[m] && uScore[m].liq) || 0;
      const up = (price / pos.entry - 1) * 100;
      let rec = null;
      if (up >= p.tp) rec = sell(w, m, price, 'take-profit', tick, nowTs, liqNow);
      else if (up <= -p.sl) rec = sell(w, m, price, 'stop-loss', tick, nowTs, liqNow);
      else if (tick - pos.tick >= prof.hold) rec = sell(w, m, price, 'time-stop', tick, nowTs, liqNow);
      if (rec) closures.push({ mint: m, pnl: rec.pnl });
    }

    // open new positions: must fit THIS archetype's cap band + liquidity floor + trigger + bar
    let held = Object.keys(w.positions).length;
    const max = maxPosOf(p);
    const cands = universe
      .filter((u) => !w.positions[u.mint] && eligible(prof, u.M, u.scores[b.id], p.threshold))
      .sort((x, y) => y.scores[b.id].c - x.scores[b.id].c);
    for (let j = 0; j < cands.length && held < max && w.cash >= Math.max(20, totalEquity(w) * p.posPct); j++) {
      const c = cands[j];
      buy(w, c.mint, c.price, c.symbol, tick, { src: c.src, sources: c.sources, mcap: c.mcap, liq: c.liq, score: c.scores[b.id].c, ts: nowTs });
      held++;
    }

    // mark + terminal checks
    const total = totalEquity(w);
    if (total > w.peak) w.peak = total;
    w.equity.push({ tick, day: state.day, v: Math.round(total) });
    if (w.equity.length > EQUITY_KEEP) w.equity.shift();

    if (total >= GRAD) {
      w.status = 'graduated'; w.gradTick = tick; w.gradDay = state.day; w.gradEquity = Math.round(total);
      w.history.unshift({ day: state.day, headline: '🏆 GRADUATED — turned $' + START.toLocaleString() + ' into 10× ($' + Math.round(total).toLocaleString() + ').', wr: null, realizedDay: 0, trades: 0, equity: Math.round(total), changes: ['Hit the 10× goal. Strategy frozen as a proven config.'], before: null, after: null });
    } else if (total <= BUST) {
      w.status = 'busted'; w.bustTick = tick; w.bustDay = state.day; w.bustEquity = Math.round(total);
      w.history.unshift({ day: state.day, headline: '💀 BUSTED — lost 90%, down to $' + Math.round(total).toLocaleString() + '.', wr: null, realizedDay: 0, trades: 0, equity: Math.round(total), changes: ['Wiped out. Lesson kept: this risk profile blew up — on respawn it starts tighter (smaller size, higher bar).'], before: null, after: null });
      // pre-bake a more cautious profile for the eventual respawn
      w.params.posPct = clPos(w.params.posPct * 0.8); w.params.threshold = clT(w.params.threshold + 3);
    }
  }

  // grow the research database (every scanned token + this tick's trade outcomes)
  try { const dbStat = await updateTokenDB(env, universe, closures, nowTs); if (dbStat) state.db = dbStat; } catch (e) { /**/ }

  // sim-day rollover → everyone learns
  const day = Math.floor((nowTs - state.startedTs) / DAY_MS);
  if (day > state.day) {
    state.day = day;
    for (const b of BOTS) { const w = state.bots[b.id]; if (w.status === 'active') learn(w, day); }
    state.lastLearnDay = day;
  }

  // keep the lab alive: if fewer than 3 bots still trading, start a new season (respawn the
  // dead with fresh money but their learned params + full history intact)
  const active = BOTS.filter((b) => state.bots[b.id].status === 'active').length;
  if (active < 3) {
    state.season = (state.season || 1) + 1;
    for (const b of BOTS) {
      const w = state.bots[b.id];
      if (w.status === 'busted') {
        w.status = 'active'; w.cash = START; w.positions = {}; w.realized = 0; w.wins = 0; w.losses = 0; w.peak = START; w.lives = (w.lives || 1) + 1;
        w.dayWins = 0; w.dayLosses = 0; w.dayRealized = 0; w.dayTrades = 0;
        w.history.unshift({ day: state.day, headline: '🔄 SEASON ' + state.season + ' — respawned with $' + START.toLocaleString() + ', lessons kept.', wr: null, realizedDay: 0, trades: 0, equity: START, changes: ['Field thinned out, so a new season begins. Money reset, but every parameter it learned across its last life carries over.'], before: null, after: null });
      }
    }
  }

  state.lastTickTs = nowTs;
  return true;
}

function publicState(state, nowTs) {
  const bots = BOTS.map((b) => {
    const w = state.bots[b.id];
    const total = totalEquity(w);
    const closed = w.wins + w.losses;
    const positions = Object.keys(w.positions).map((m) => {
      const p = w.positions[m]; const now = p.last || p.entry; const up = (now / p.entry - 1) * 100;
      const mcapNow = p.mid > 0 && p.mcapIn ? Math.round(p.mcapIn * (now / p.mid)) : (p.mcapIn || 0);
      return {
        mint: m, symbol: p.symbol, value: Math.round(p.qty * now), upPct: +up.toFixed(1), usdIn: Math.round(p.usdIn),
        src: p.src || null, sources: p.sources || [], qty: p.qty, entryPrice: p.mid, nowPrice: now,
        mcapIn: p.mcapIn || 0, mcapNow, tsIn: p.ts || null, scoreIn: p.scoreIn, barIn: p.barIn, slipInPct: p.slipIn != null ? +(p.slipIn * 100).toFixed(2) : null,
      };
    }).sort((a, c) => c.value - a.value);
    return {
      id: b.id, name: b.name, dial: b.dial, status: w.status, lives: w.lives, season: state.season,
      equity: Math.round(total), pnl: Math.round(total - START), pnlPct: +((total / START - 1) * 100).toFixed(1),
      cash: Math.round(w.cash), peak: Math.round(w.peak), wins: w.wins, losses: w.losses,
      winRate: closed ? Math.round(w.wins / closed * 100) : null, trades: w.wins + w.losses,
      openCount: positions.length, positions,
      params: { threshold: w.params.threshold, tp: w.params.tp, sl: w.params.sl, posPct: Math.round(w.params.posPct * 100), slip: +(w.params.slip * 100).toFixed(1) },
      baseParams: baseParams(b.dial),
      profile: { capMin: PROFILE[b.id].capMin, capMax: PROFILE[b.id].capMax, liqMin: PROFILE[b.id].liqMin, hold: PROFILE[b.id].hold, label: PROFILE[b.id].label },
      log: w.trades.slice(0, LOG_PREVIEW), logTotal: w.trades.length, totalClosed: w.wins + w.losses,
      history: w.history.slice(0, 60), historyTotal: w.history.length, equityCurve: w.equity.slice(-120),
    };
  }).sort((a, c) => c.equity - a.equity);

  const ageDays = (nowTs - state.startedTs) / DAY_MS;
  return {
    startedTs: state.startedTs, ageDays: +ageDays.toFixed(2), day: state.day, season: state.season,
    tick: state.tick, lastTickTs: state.lastTickTs, start: START, grad: GRAD, bust: BUST,
    strategyVersion: state.strategyVersion || 1, versions: state.versions || [],
    lessons: STRATEGY_LESSONS[state.strategyVersion || 1] || [],
    db: state.db ? { tokens: state.db.n || 0, scans: state.db.scans || 0 } : null,
    activeCount: BOTS.filter((b) => state.bots[b.id].status === 'active').length,
    universe: state.universe || null, calls: state.calls || [],
    leader: bots[0] ? bots[0].id : null, bots, ts: nowTs,
  };
}

export async function onRequestGet({ request, env }) {
  const KV = env.ZEN_KV;
  if (!KV) return json({ error: 'Lab needs KV storage (ZEN_KV) — not bound.' }, 503);
  const url = new URL(request.url);
  const peek = url.searchParams.get('peek');
  const botId = url.searchParams.get('bot'); // request ONE bot's full lifetime trade ledger
  const versionId = url.searchParams.get('version'); // request an ARCHIVED strategy version's run
  const nowTs = Date.now();

  // archived strategy-version run (read-only; full ledgers from when that version was retired)
  if (versionId) {
    const arch = await KV.get(KVKEY + ':archive:v' + versionId, 'json').catch(() => null);
    if (!arch) return json({ error: 'no archived run for v' + versionId }, 404);
    return json(arch, 200, { 'cache-control': 'no-store' });
  }

  // the growing research database — summary + most-traded / best / worst tokens it has learned
  if (url.searchParams.get('db')) {
    const db = await KV.get('radar:db:tokens', 'json').catch(() => null);
    if (!db || !db.tokens) return json({ n: 0, scans: 0, tokens: [] }, 200, { 'cache-control': 'no-store' });
    const arr = Object.keys(db.tokens).map((m) => ({ mint: m, ...db.tokens[m], traded: (db.tokens[m].sells || 0) }));
    const traded = arr.filter((t) => t.traded > 0);
    return json({
      n: db.n || arr.length, scans: db.scans || 0, firstTs: db.firstTs, updated: db.updated,
      mostSeen: arr.slice().sort((a, b) => b.seen - a.seen).slice(0, 25),
      bestTraded: traded.slice().sort((a, b) => b.pnl - a.pnl).slice(0, 15),
      worstTraded: traded.slice().sort((a, b) => a.pnl - b.pnl).slice(0, 15),
    }, 200, { 'cache-control': 'no-store' });
  }

  let state = await KV.get(KVKEY, 'json').catch(() => null);
  state = state ? migrate(state, nowTs) : freshState(nowTs); // migrate, never wipe

  // full-ledger fetch for a single bot (no advancing) — used when a bot is expanded in the UI
  if (botId) {
    const w = state.bots[botId];
    if (!w) return json({ error: 'unknown bot' }, 404);
    const b = BOTS.find((x) => x.id === botId) || { name: botId };
    return json({ id: botId, name: b.name, trades: w.trades || [], history: w.history || [], wins: w.wins, losses: w.losses, realized: Math.round(w.realized || 0), totalClosed: (w.wins || 0) + (w.losses || 0), ts: nowTs }, 200, { 'cache-control': 'no-store' });
  }

  // strategy-version transition: archive the finished run + start fresh on the new strategy
  if (!peek && (state.strategyVersion || 1) < STRATEGY_VERSION) {
    const arch = applyStrategyVersion(state, nowTs);
    if (arch) { try { await KV.put(arch.key, JSON.stringify(arch.data)); } catch (e) { /**/ } try { await KV.put(KVKEY, JSON.stringify(state)); } catch (e) { /**/ } }
  }

  let advanced = false;
  const pastDue = (nowTs - (state.lastTickTs || 0)) >= TICK_MS;
  const unlocked = (nowTs - (state.ticking || 0)) > 120000; // 2-min soft lock against concurrent ticks
  if (!peek && pastDue && unlocked) {
    state.ticking = nowTs;
    try {
      advanced = await advance(state, env, nowTs);
    } catch (e) { /* keep last-good state */ }
    state.ticking = 0;
    try { await KV.put(KVKEY, JSON.stringify(state)); } catch (e) { /**/ }
  } else if (!state.lastTickTs && !peek) {
    // first-ever read with no successful tick yet: persist the fresh shell so it exists
    try { await KV.put(KVKEY, JSON.stringify(state)); } catch (e) { /**/ }
  }

  return json({ ...publicState(state, nowTs), advanced, nextTickInSec: Math.max(0, Math.round((TICK_MS - (nowTs - (state.lastTickTs || 0))) / 1000)) }, 200, { 'cache-control': 'no-store' });
}
