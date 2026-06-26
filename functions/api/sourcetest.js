// GET /api/sourcetest         → probe candidate discovery sources FROM CLOUDFLARE, so we know
//                               which actually work from our server before paying for any.
// GET /api/sourcetest?st=KEY   → also test Solana Tracker WITH your key (returns a real sample).
//
// reachable:true + status 401/403 = works from CF, just needs an API key.
// reachable:false / status 0      = blocked from Cloudflare's egress (like pump.fun & GeckoTerminal).

import { json, preflight } from './_utils.js';

export const onRequestOptions = () => preflight();

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const st = url.searchParams.get('st'); // optional Solana Tracker API key

  // one-time: stash the Solana Tracker key in KV (private — never committed to the public repo)
  const save = url.searchParams.get('savekey');
  if (save) {
    if (!env || !env.ZEN_KV) return json({ error: 'no KV' }, 503);
    await env.ZEN_KV.put('radar:cfg:stkey', save);
    return json({ saved: true, note: 'Solana Tracker key stored in KV. Discovery + /api/newlaunches now active. (Move it to the SOLANATRACKER_KEY env var later for best practice.)' }, 200, { 'cache-control': 'no-store' });
  }

  const probe = async (name, u, headers) => {
    const t0 = Date.now();
    try {
      const r = await fetch(u, headers ? { headers } : undefined);
      const body = await r.text();
      return { name, reachable: true, status: r.status, ms: Date.now() - t0, sample: body.slice(0, 160) };
    } catch (e) { return { name, reachable: false, status: 0, error: String(e && e.message || e).slice(0, 120) }; }
  };

  const results = await Promise.all([
    probe('solanatracker-trending', 'https://data.solanatracker.io/tokens/trending', st ? { 'x-api-key': st } : null),
    probe('solanatracker-latest', 'https://data.solanatracker.io/tokens/latest', st ? { 'x-api-key': st } : null),
    probe('birdeye-trending', 'https://public-api.birdeye.so/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=20', { 'x-chain': 'solana' }),
    probe('dexscreener-search (control, should be 200)', 'https://api.dexscreener.com/latest/dex/search?q=pump', null),
    probe('geckoterminal (expect blocked)', 'https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1', { accept: 'application/json' }),
    probe('pumpfun (expect blocked)', 'https://frontend-api.pump.fun/coins?limit=5', { accept: 'application/json' }),
  ]);

  return json({
    note: 'reachable:true + status 401/403 = works from Cloudflare, just needs an API key. reachable:false or status 0 = blocked from CF egress.',
    results, ts: Date.now(),
  }, 200, { 'cache-control': 'no-store' });
}
