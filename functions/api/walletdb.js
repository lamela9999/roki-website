// GET /api/walletdb            → wallet leaderboard (top traders by net SOL across observed tokens)
// GET /api/walletdb?smart=1    → smart-money alerts (proven-winner wallets accumulating now)
// GET /api/walletdb?token=<m>  → who aped a token (wallets observed swapping it, by net SOL)
// GET /api/walletdb?addr=<pk>  → one wallet's full observed record
//
// PHASE 2: this is now a THIN PROXY. All wallet intelligence lives in the OWNED engine on the
// droplet (engine/server.js), which scans Helius into its own JSON store with UNLIMITED writes —
// no Cloudflare KV 1,000/day cap, so the data grows continuously instead of freezing. This
// function just forwards reads to the engine and returns its response verbatim (identical shapes).
// ?scan=1 is a no-op kept for backward compat (the engine scans itself, 24/7).

import { json, preflight } from './_utils.js';

export const onRequestOptions = () => preflight();

const ENGINE = 'http://146.190.22.95:8787';

async function proxy(env, path, cache) {
  const base = env.ENGINE_URL || ENGINE;
  const r = await fetch(base + path, { signal: AbortSignal.timeout(9000) });
  const body = await r.text();
  return new Response(body, { status: r.status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': cache } });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  try {
    const addr = url.searchParams.get('addr');
    if (addr) return await proxy(env, '/addr?a=' + encodeURIComponent(addr), 'no-store');
    if (url.searchParams.get('smart')) return await proxy(env, '/smart', 'public, max-age=30');
    const token = url.searchParams.get('token');
    if (token) return await proxy(env, '/token?mint=' + encodeURIComponent(token), 'public, max-age=60');
    if (url.searchParams.get('scan')) return json({ ok: true, note: 'scanning runs continuously on the droplet engine — no CF scan needed', ts: Date.now() }, 200, { 'cache-control': 'no-store' });
    return await proxy(env, '/wallets', 'public, max-age=30');
  } catch (e) {
    // engine unreachable → fall back to the last KV snapshot so the UI still shows something
    const KV = env.ZEN_KV;
    if (KV && !url.searchParams.get('smart') && !url.searchParams.get('token') && !url.searchParams.get('addr')) {
      const db = await KV.get('radar:db:wallets', 'json').catch(() => null);
      if (db && db.wallets) {
        const arr = Object.keys(db.wallets).map((a) => ({ addr: a, ...db.wallets[a] }));
        const top = arr.filter((w) => (w.n || 0) >= 3).sort((a, b) => (b.netSol || 0) - (a.netSol || 0)).slice(0, 500)
          .map((w, i) => ({ rank: i + 1, addr: w.addr, netSol: +(w.netSol || 0).toFixed(2), trades: w.n || 0, tokens: Object.keys(w.toks || {}).slice(0, 8), tokenCount: Object.keys(w.toks || {}).length, first: w.first, last: w.last, label: (w.netSol || 0) > 0 ? (Object.keys(w.toks || {}).length > 2 ? 'consistent winner' : 'net-positive') : 'net-negative' }));
        return json({ n: arr.length, scans: db.scans || 0, updated: db.updated, top, stale: true }, 200, { 'cache-control': 'no-store' });
      }
    }
    return json({ error: 'engine unreachable', detail: String(e && e.message || e) }, 502, { 'cache-control': 'no-store' });
  }
}
