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

import { json, preflight, pickPair, solRpc, jupPrices } from './_utils.js';

export const onRequestOptions = () => preflight();

const V = 3;                       // bump to wipe + reinitialise state
const START = 2000;                // each wallet starts here
const GRAD = START * 10;           // 10× → graduate (champion)
const BUST = START * 0.10;         // lose 90% → bust (dead)
const TICK_MS = 10 * 60 * 1000;    // minimum spacing between ticks
const DAY_MS = 24 * 60 * 60 * 1000;
const FEE = 0.99;                  // 1% taker fee each side
const UNIVERSE = 16;               // trending tokens scanned per tick
const TRADES_KEEP = 50, EQUITY_KEEP = 300, HISTORY_KEEP = 200;
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
    sl: clSL(8 + d / 100 * 42),                 // -8%..-50%
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
  return { v: V, startedTs: nowTs, lastTickTs: 0, tick: 0, day: 0, lastLearnDay: 0, season: 1, ticking: 0, bots };
}

function totalEquity(w) {
  let v = w.cash;
  for (const m in w.positions) { const p = w.positions[m]; v += p.qty * (p.last || p.entry); }
  return v;
}

// ---- one scan of the trending universe, scored for every archetype ----
async function scanUniverse(env, nowTs) {
  const dexGet = async (u) => { for (let i = 0; i < 3; i++) { try { const r = await fetch(u); if (r.ok) return await r.json(); } catch (e) { /**/ } await new Promise((res) => setTimeout(res, 250)); } return null; };
  const [top, latest] = await Promise.all([
    dexGet('https://api.dexscreener.com/token-boosts/top/v1'),
    dexGet('https://api.dexscreener.com/token-boosts/latest/v1'),
  ]);
  const seen = new Set(); let mints = [];
  for (const list of [top || [], latest || []]) for (const b of list) {
    if (b && b.chainId === 'solana' && b.tokenAddress && !seen.has(b.tokenAddress)) { seen.add(b.tokenAddress); mints.push(b.tokenAddress); }
  }
  mints = mints.slice(0, UNIVERSE);
  if (!mints.length) return null;

  const [pairsArr, accInfos] = await Promise.all([
    Promise.all(mints.map((m) => dexGet(`https://api.dexscreener.com/latest/dex/tokens/${m}`))),
    solRpc('getMultipleAccounts', [mints, { encoding: 'jsonParsed' }], env).catch(() => null),
  ]);

  const out = [];
  mints.forEach((mint, i) => {
    const p = pickPair(pairsArr[i] && pairsArr[i].pairs, mint);
    if (!p) return;
    const info = accInfos && accInfos.value && accInfos.value[i] && accInfos.value[i].data && accInfos.value[i].data.parsed && accInfos.value[i].data.parsed.info;
    const gateLive = info ? (info.mintAuthority !== null || info.freezeAuthority !== null) : false;
    const liq = (p.liquidity && p.liquidity.usd) || 0, vol24 = (p.volume && p.volume.h24) || 0;
    const tx = (p.txns && p.txns.h24) || {}; const buys = tx.buys || 0, sells = tx.sells || 0;
    const ageMs = p.pairCreatedAt || 0; const ageDays = ageMs ? (nowTs - ageMs) / DAY_MS : null;
    const mcap = p.marketCap || p.fdv || 0; const chg = (p.priceChange && p.priceChange.h24);
    const price = parseFloat(p.priceUsd) || 0;
    if (!(price > 0)) return;
    const Vv = {
      liq: logScore(liq, 3000, 1000000), vol: logScore(vol24, 5000, 5000000),
      pressure: (buys + sells) > 0 ? Math.round((buys / (buys + sells)) * 100) : null,
      age: ageDays != null ? clamp(Math.round(20 + 80 * (1 - Math.exp(-ageDays / 21))), 0, 100) : null,
      priceTrend: chg != null ? clamp(Math.round(50 + chg), 0, 100) : null,
      lifecycle: mcap > 0 ? (mcap < 50000 ? 30 : mcap < 1e6 ? 70 : mcap < 1e7 ? 85 : 60) : null,
    };
    const scores = {};
    for (const a in ARCH) {
      let wsum = 0, vsum = 0;
      FACTORS.forEach((f) => { if (Vv[f.k] != null) { const w = ARCH[a][f.g] || 50; wsum += w; vsum += w * Vv[f.k]; } });
      let c = wsum ? Math.round(vsum / wsum) : null;
      const rejected = gateLive && a !== 'degen';
      if (rejected && c != null) c = Math.min(c, 12);
      scores[a] = { c, r: rejected };
    }
    out.push({ mint, symbol: ((p.baseToken && p.baseToken.symbol) || '?').replace(/^\$/, ''), name: (p.baseToken && p.baseToken.name) || 'Unknown', price, mcap, scores });
  });
  return out;
}

function buy(w, mint, price, symbol, tick) {
  const p = w.params;
  const total = totalEquity(w);
  const usd = Math.max(20, Math.round(total * p.posPct));
  if (w.cash < usd) return;
  const eff = price * (1 + p.slip);
  const qty = (usd * FEE) / eff;
  w.cash -= usd;
  w.positions[mint] = { symbol, entry: eff, usdIn: usd, qty, last: price, tick };
  w.trades.unshift({ tick, side: 'BUY', symbol, mint, usd });
  if (w.trades.length > TRADES_KEEP) w.trades.pop();
}
function sell(w, mint, price, reason, tick) {
  const pos = w.positions[mint]; if (!pos) return;
  const eff = price * (1 - w.params.slip);
  const proceeds = pos.qty * eff * FEE;
  w.cash += proceeds;
  const pnl = proceeds - pos.usdIn;
  const pnlPct = (proceeds / pos.usdIn - 1) * 100;
  w.realized += pnl;
  if (pnl >= 0) { w.wins++; w.dayWins++; } else { w.losses++; w.dayLosses++; }
  w.dayRealized += pnl; w.dayTrades++;
  w.trades.unshift({ tick, side: 'SELL', symbol: pos.symbol, mint, usd: proceeds, pnl: +pnl.toFixed(2), pnlPct: +pnlPct.toFixed(1), reason });
  if (w.trades.length > TRADES_KEEP) w.trades.pop();
  delete w.positions[mint];
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

  // price any held tokens that fell out of the trending set
  const need = new Set();
  BOTS.forEach((b) => { const w = state.bots[b.id]; for (const m in w.positions) if (uPrice[m] == null) need.add(m); });
  let extra = {};
  if (need.size) { try { extra = await jupPrices([...need]); } catch (e) { /**/ } }
  const priceOf = (m) => (uPrice[m] != null ? uPrice[m] : (extra[m] && extra[m].price));

  state.tick++;
  const tick = state.tick;

  for (const b of BOTS) {
    const w = state.bots[b.id];
    if (w.status !== 'active') continue;
    const p = w.params;

    // manage open positions
    for (const m of Object.keys(w.positions)) {
      const pos = w.positions[m];
      const price = priceOf(m);
      if (price == null || !(price > 0)) continue;
      pos.last = price;
      const up = (price / pos.entry - 1) * 100;
      if (up >= p.tp) sell(w, m, price, 'take-profit +' + p.tp + '%', tick);
      else if (up <= -p.sl) sell(w, m, price, 'stop-loss -' + p.sl + '%', tick);
      else if (tick - pos.tick >= p.maxHold) sell(w, m, price, 'time-stop ' + p.maxHold + ' ticks', tick);
    }

    // open new positions that clear this bot's bar
    let held = Object.keys(w.positions).length;
    const max = maxPosOf(p);
    const cands = universe
      .filter((u) => { const s = u.scores[b.id]; return s && !s.r && s.c != null && s.c >= p.threshold && !w.positions[u.mint]; })
      .sort((x, y) => y.scores[b.id].c - x.scores[b.id].c);
    for (let j = 0; j < cands.length && held < max && w.cash >= Math.max(20, totalEquity(w) * p.posPct); j++) {
      buy(w, cands[j].mint, cands[j].price, cands[j].symbol, tick);
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
      return { mint: m, symbol: p.symbol, value: Math.round(p.qty * now), upPct: +up.toFixed(1), usdIn: Math.round(p.usdIn) };
    }).sort((a, c) => c.value - a.value);
    return {
      id: b.id, name: b.name, dial: b.dial, status: w.status, lives: w.lives, season: state.season,
      equity: Math.round(total), pnl: Math.round(total - START), pnlPct: +((total / START - 1) * 100).toFixed(1),
      cash: Math.round(w.cash), peak: Math.round(w.peak), wins: w.wins, losses: w.losses,
      winRate: closed ? Math.round(w.wins / closed * 100) : null, trades: w.wins + w.losses,
      openCount: positions.length, positions,
      params: { threshold: w.params.threshold, tp: w.params.tp, sl: w.params.sl, posPct: Math.round(w.params.posPct * 100), slip: +(w.params.slip * 100).toFixed(1) },
      baseParams: baseParams(b.dial),
      log: w.trades.slice(0, 30), history: w.history.slice(0, 60), equityCurve: w.equity.slice(-120),
    };
  }).sort((a, c) => c.equity - a.equity);

  const ageDays = (nowTs - state.startedTs) / DAY_MS;
  return {
    startedTs: state.startedTs, ageDays: +ageDays.toFixed(2), day: state.day, season: state.season,
    tick: state.tick, lastTickTs: state.lastTickTs, start: START, grad: GRAD, bust: BUST,
    activeCount: BOTS.filter((b) => state.bots[b.id].status === 'active').length,
    leader: bots[0] ? bots[0].id : null, bots, ts: nowTs,
  };
}

export async function onRequestGet({ request, env }) {
  const KV = env.ZEN_KV;
  if (!KV) return json({ error: 'Lab needs KV storage (ZEN_KV) — not bound.' }, 503);
  const url = new URL(request.url);
  const peek = url.searchParams.get('peek');
  const nowTs = Date.now();

  let state = await KV.get(KVKEY, 'json').catch(() => null);
  if (!state || state.v !== V) state = freshState(nowTs);

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
