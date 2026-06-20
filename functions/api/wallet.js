// GET /api/wallet?addr=<wallet>
// Real wallet portfolio — FREE stack, no Helius required:
//   balances: free public Solana RPC (publicnode / official mainnet-beta) via solRpc
//   pricing:  Jupiter Price v3 (free, no key) via jupPrices — only prices real/liquid tokens,
//             so scam/junk holdings get no value and can't inflate the total.
// Read-only. Entity resolution / plus-minus is the forensic layer (later).

import { json, preflight, solRpc, jupPrices } from './_utils.js';

export const onRequestOptions = () => preflight();

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const WSOL = 'So11111111111111111111111111111111111111112';

export async function onRequestGet({ request, env }) {
  const addr = (new URL(request.url).searchParams.get('addr') || '').trim();
  if (!ADDR_RE.test(addr)) return json({ error: "That doesn't look like a Solana wallet address." }, 400);

  const tokenAccounts = (programId) =>
    solRpc('getTokenAccountsByOwner', [addr, { programId }, { encoding: 'jsonParsed' }], env).catch(() => null);

  try {
    const [bal, t1, t2] = await Promise.all([
      solRpc('getBalance', [addr], env).catch(() => null),
      tokenAccounts(TOKEN_PROGRAM),
      tokenAccounts(TOKEN_2022),
    ]);

    const sol = (bal && bal.value ? bal.value : 0) / 1e9;

    // Collapse token accounts → balance per mint.
    const byMint = {};
    for (const res of [t1, t2]) {
      for (const acc of (res && res.value) || []) {
        const info = acc.account && acc.account.data && acc.account.data.parsed && acc.account.data.parsed.info;
        const amt = info && info.tokenAmount && info.tokenAmount.uiAmount;
        if (info && amt > 0) byMint[info.mint] = (byMint[info.mint] || 0) + amt;
      }
    }
    let tokens = Object.keys(byMint).map((mint) => ({ mint, amount: byMint[mint] }));

    // Price via Jupiter v3 (free). Jupiter only returns real/liquid tokens → junk stays unpriced.
    const priced = await jupPrices([WSOL, ...tokens.map((t) => t.mint)]);

    tokens = tokens.map((t) => {
      const pr = priced[t.mint];
      const price = pr ? pr.price : null;
      const raw = price != null ? price * t.amount : null;
      // realizable cap: can't exit more than the pool holds
      const valueUsd = raw != null ? (pr.liq ? Math.min(raw, pr.liq) : raw) : null;
      return { mint: t.mint, symbol: null, amount: t.amount, priceUsd: price, valueUsd };
    });
    tokens.sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));

    const solPrice = priced[WSOL] ? priced[WSOL].price : null;
    const solUsd = solPrice != null ? solPrice * sol : null;
    const portfolioUsd = (solUsd || 0) + tokens.reduce((s, t) => s + (t.valueUsd || 0), 0);

    // Resolve symbols for the displayed holdings (Jupiter price has none) — one free DexScreener call.
    const top = tokens.slice(0, 12);
    if (top.length) {
      try {
        const ds = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + top.map((t) => t.mint).join(',')).then((r) => (r.ok ? r.json() : null));
        const symOf = {};
        for (const p of (ds && ds.pairs) || []) {
          const m = p.baseToken && p.baseToken.address;
          if (m && !symOf[m]) symOf[m] = (p.baseToken.symbol || '').replace(/^\$/, '');
        }
        top.forEach((t) => { if (symOf[t.mint]) t.symbol = symOf[t.mint]; });
      } catch (e) { /* symbols best-effort */ }
    }

    return json({
      addr,
      sol,
      solUsd,
      tokenCount: tokens.length,
      portfolioUsd,
      tokens: top,
      source: 'free: publicnode/mainnet-beta + jupiter + dexscreener',
      ts: Date.now(),
    }, 200, { 'cache-control': 'public, max-age=30' });
  } catch (e) {
    return json({ error: e.message || 'Wallet lookup failed.' }, 502);
  }
}
