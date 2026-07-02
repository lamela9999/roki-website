#!/usr/bin/env node
/*
 * ROKI Wallet Engine — Phase 2 backend (the OWNED database).
 *
 * Runs 24/7 on the droplet with its OWN store (a JSON file, UNLIMITED writes — no Cloudflare KV
 * 1,000/day cap). Continuously scans Solana tokens via Helius, folds every trader into the wallet
 * DB, and computes the winner leaderboard, the smart-money map (winners buying/selling + whale
 * entries + loser crowds) and the per-token "who aped" view. Serves it all as read-only HTTP GETs
 * (CORS-open) that the Cloudflare site proxies to. No secrets in the repo — HELIUS_API_KEY is a
 * droplet env var.
 *
 * Node 18+ (built-in fetch). Zero npm deps. Run under pm2.
 */

const http = require('http');
const fs = require('fs');

const PORT = +(process.env.PORT || 8787);
const HELIUS = process.env.HELIUS_API_KEY || '';
const DB_FILE = process.env.DB_FILE || '/home/deploy/roki-engine/walletdb.json';
const SITE = process.env.ROKI_BASE || 'https://roki.buzz';
const SCAN_EVERY = (+(process.env.SCAN_EVERY_S || 20)) * 1000;
const BATCH = +(process.env.BATCH || 16);
const TX_PER = 80;
const WMAX = 60000;              // droplet has room — keep way more than KV's 15k
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- persistence (unlimited writes: in-memory + periodic disk flush) ----------
let db = { wallets: {}, smart: { tokens: {} }, tw: { tokens: {} }, symOf: {}, scans: 0, firstTs: Date.now(), updated: 0 };
try { const j = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); db = Object.assign(db, j); log('loaded', Object.keys(db.wallets).length, 'wallets from disk'); } catch (e) { log('fresh DB'); }
let dirty = false;
setInterval(() => { if (!dirty) return; try { fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DB_FILE + '.tmp', DB_FILE); dirty = false; } catch (e) { log('flush err', e.message); } }, 30000);
process.on('SIGTERM', () => { try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (e) { /**/ } process.exit(0); });

// ---------- winner / loser scoring (must match _utils.js) ----------
function rankWinners(wallets, topN) {
  return Object.keys(wallets).map((a) => { const w = wallets[a]; const inS = +w.inSol || 0, outS = +w.outSol || 0, n = +w.n || 0; const roi = inS >= 1 ? outS / inS : 0; return { addr: a, roi: +roi.toFixed(3), n, netSol: +(w.netSol || 0), score: roi * Math.sqrt(Math.min(n, 50)) }; })
    .filter((w) => w.n >= 5 && w.roi >= 1.15).sort((x, y) => y.score - x.score).slice(0, topN || 200);
}
function rankLosers(wallets, topN) {
  return Object.keys(wallets).map((a) => { const w = wallets[a]; const inS = +w.inSol || 0, outS = +w.outSol || 0, n = +w.n || 0; const roi = inS >= 1 ? outS / inS : 1; return { addr: a, roi: +roi.toFixed(3), n }; })
    .filter((w) => w.n >= 5 && w.roi <= 0.75).sort((x, y) => x.roi - y.roi).slice(0, topN || 300);
}

// ---------- token universe to scan (held-by-bots first, then trending; keyless) ----------
const getJSON = async (u, h) => { try { const r = await fetch(u, h ? { headers: h } : undefined); if (r.ok) return await r.json(); } catch (e) { /**/ } return null; };
let cursor = 0;
async function pickBatch() {
  const held = new Set();
  const lab = await getJSON(SITE + '/api/lab?peek=1');
  try { for (const b of (lab && lab.bots) || []) for (const p of b.positions || []) if (p.mint) held.add(p.mint); } catch (e) { /**/ }
  const trend = [];
  const push = (arr, key) => { for (const x of arr || []) { const m = key(x); if (m) trend.push(m); } };
  const [bt, bl] = await Promise.all([getJSON('https://api.dexscreener.com/token-boosts/top/v1'), getJSON('https://api.dexscreener.com/token-boosts/latest/v1')]);
  push(bt, (x) => x && x.chainId === 'solana' && x.tokenAddress); push(bl, (x) => x && x.chainId === 'solana' && x.tokenAddress);
  const rotated = trend.slice(cursor % Math.max(1, trend.length)).concat(trend.slice(0, cursor % Math.max(1, trend.length)));
  cursor += BATCH;
  const seen = new Set(), list = [];
  for (const m of [...held, ...rotated]) if (m && !seen.has(m)) { seen.add(m); list.push(m); }
  return list.slice(0, BATCH);
}

// ---------- one scan cycle ----------
let scanning = false;
async function scanCycle() {
  if (!HELIUS || scanning) return; scanning = true;
  try {
    const batch = await pickBatch();
    if (!batch.length) { scanning = false; return; }
    // resolve symbols (one DexScreener call)
    try { const ds = await getJSON('https://api.dexscreener.com/latest/dex/tokens/' + batch.join(',')); for (const p of (ds && ds.pairs) || []) { const m = p.baseToken && p.baseToken.address; if (m && !db.symOf[m]) db.symOf[m] = (p.baseToken.symbol || '').replace(/^\$/, ''); } } catch (e) { /**/ }
    const nowTs = Date.now();
    const perByMint = {};
    let analyzed = 0, newW = 0;
    for (const mint of batch) {
      const txs = await getJSON(`https://api.helius.xyz/v0/addresses/${mint}/transactions?api-key=${HELIUS}&type=SWAP&limit=${TX_PER}`);
      if (!Array.isArray(txs)) continue;
      analyzed++;
      const sym = db.symOf[mint] || mint.slice(0, 4);
      const per = {};
      for (const t of txs) { const sw = t.events && t.events.swap; if (!sw) continue; const tr = t.feePayer; if (!tr) continue; const nIn = (sw.nativeInput && Number(sw.nativeInput.amount)) || 0, nOut = (sw.nativeOutput && Number(sw.nativeOutput.amount)) || 0; const p = per[tr] = per[tr] || { in: 0, out: 0, n: 0 }; p.in += nIn; p.out += nOut; p.n++; }
      for (const a of Object.keys(per)) { const p = per[a]; let w = db.wallets[a]; if (!w) { w = db.wallets[a] = { first: nowTs, n: 0, inSol: 0, outSol: 0, netSol: 0, toks: {} }; newW++; } w.last = nowTs; w.n += p.n; w.inSol = +(w.inSol + p.in / 1e9).toFixed(3); w.outSol = +(w.outSol + p.out / 1e9).toFixed(3); w.netSol = +(w.outSol - w.inSol).toFixed(3); w.toks[sym] = (w.toks[sym] || 0) + 1; }
      perByMint[mint] = { per, sym };
    }
    // prune
    const wk = Object.keys(db.wallets);
    if (wk.length > WMAX) { wk.sort((a, b) => (db.wallets[a].last || 0) - (db.wallets[b].last || 0)); for (let i = 0; i < wk.length - WMAX; i++) delete db.wallets[wk[i]]; }
    // rebuild smart-money map for scanned tokens
    const SMART_TOP = 150;
    const ranked = rankWinners(db.wallets, SMART_TOP); const rankOf = {}; ranked.forEach((w, i) => { rankOf[w.addr] = i + 1; });
    const loserSet = new Set(rankLosers(db.wallets, 300).map((w) => w.addr));
    for (const mint of Object.keys(perByMint)) {
      const { per, sym } = perByMint[mint];
      const buyers = [], sellers = []; let whales = 0, dumb = 0;
      for (const a of Object.keys(per)) {
        if (per[a].in >= 20e9) whales++;
        if (loserSet.has(a)) dumb++;
        if (rankOf[a] == null) continue;
        const net = (per[a].out - per[a].in) / 1e9;
        if (net < 0) buyers.push({ addr: a, rank: rankOf[a], tokenNet: +net.toFixed(2) }); else if (net > 0) sellers.push({ addr: a, rank: rankOf[a], tokenNet: +net.toFixed(2) });
      }
      buyers.sort((x, y) => x.rank - y.rank); sellers.sort((x, y) => x.rank - y.rank);
      const present = buyers.length + sellers.length;
      if (present > 0 || whales > 0 || dumb > 0) { const score = +(buyers.reduce((s, b) => s + (SMART_TOP + 1 - b.rank) / SMART_TOP, 0) - sellers.length * 0.3).toFixed(2); db.smart.tokens[mint] = { sym, score, count: buyers.length, sellers: sellers.length, present, whales, dumb, buyers: buyers.slice(0, 10), updated: nowTs }; }
      // who aped
      const tw = Object.keys(per).map((a) => ({ addr: a, net: +((per[a].out - per[a].in) / 1e9).toFixed(3), n: per[a].n })).sort((x, y) => y.net - x.net).slice(0, 15);
      db.tw.tokens[mint] = { sym, updated: nowTs, traders: Object.keys(per).length, wallets: tw };
    }
    for (const key of ['smart', 'tw']) { const t = db[key].tokens; const ks = Object.keys(t); if (ks.length > 2500) { ks.sort((a, b) => (t[a].updated || 0) - (t[b].updated || 0)); for (let i = 0; i < ks.length - 2500; i++) delete t[ks[i]]; } }
    db.smart.smartCount = ranked.length;
    db.scans++; db.updated = nowTs; dirty = true;
    log(`scan #${db.scans}: analyzed=${analyzed} wallets=${Object.keys(db.wallets).length} new=${newW}`);
  } catch (e) { log('scan err', e.message); }
  scanning = false;
}

// ---------- HTTP API (read-only, CORS-open) ----------
const json = (res, obj) => { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const path = u.pathname;
  if (path === '/health') return json(res, { ok: true, wallets: Object.keys(db.wallets).length, scans: db.scans, updated: db.updated, smartTokens: Object.keys(db.smart.tokens).length });
  if (path === '/smartmap') return json(res, { tokens: db.smart.tokens, smartCount: db.smart.smartCount || 0, updated: db.updated });
  if (path === '/smart') { const cutoff = Date.now() - 6 * 3600e3; const alerts = Object.keys(db.smart.tokens).map((m) => ({ mint: m, ...db.smart.tokens[m] })).filter((t) => (t.present || t.count || 0) > 0 && (t.updated || 0) > cutoff).sort((a, b) => b.score - a.score).slice(0, 30); return json(res, { smartCount: db.smart.smartCount || 0, updated: db.updated, alerts }); }
  if (path === '/token') { const m = u.searchParams.get('mint'); const e = m && db.tw.tokens[m]; return json(res, e ? { mint: m, ...e } : { mint: m, wallets: [], note: 'not analyzed yet' }); }
  if (path === '/addr') { const a = u.searchParams.get('a'); const w = a && db.wallets[a]; return json(res, w ? { addr: a, ...w, tokens: Object.keys(w.toks || {}) } : { error: 'wallet not in DB yet' }); }
  if (path === '/wallets') {
    const arr = Object.keys(db.wallets).map((a) => ({ addr: a, ...db.wallets[a] }));
    const top = arr.filter((w) => (w.n || 0) >= 3).sort((a, b) => (b.netSol || 0) - (a.netSol || 0)).slice(0, 500)
      .map((w, i) => ({ rank: i + 1, addr: w.addr, netSol: +(w.netSol || 0).toFixed(2), trades: w.n || 0, tokens: Object.keys(w.toks || {}).slice(0, 8), tokenCount: Object.keys(w.toks || {}).length, first: w.first, last: w.last, label: (w.netSol || 0) > 0 ? (Object.keys(w.toks || {}).length > 2 ? 'consistent winner' : 'net-positive') : 'net-negative' }));
    return json(res, { n: arr.length, scans: db.scans, updated: db.updated, top });
  }
  res.writeHead(404, { 'access-control-allow-origin': '*' }); res.end('{"error":"not found"}');
}).listen(PORT, () => log(`ROKI wallet engine on :${PORT} · db=${DB_FILE} · scan every ${SCAN_EVERY / 1000}s · helius=${HELIUS ? 'set' : 'MISSING'}`));

scanCycle();
setInterval(scanCycle, SCAN_EVERY);
