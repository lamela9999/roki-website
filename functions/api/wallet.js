// GET /api/wallet?addr=<wallet>
// Real wallet portfolio via Helius (key server-side): SOL balance + SPL token holdings,
// priced via DexScreener (batched) where the token trades. Entity resolution /
// classification / plus-minus is the forensic layer (Phase 3), not computed here yet.

import { json, preflight } from './_utils.js';

export const onRequestOptions = () => preflight();

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const WSOL = 'So11111111111111111111111111111111111111112';

export async function onRequestGet({ request, env }) {
  const addr = (new URL(request.url).searchParams.get('addr') || '').trim();
  if (!ADDR_RE.test(addr)) return json({ error: "That doesn't look like a Solana wallet address." }, 400);

  const KEY = env.HELIUS_API_KEY;
  if (!KEY) return json({ error: 'Forensic backend not configured (missing Helius key).' }, 503);
  const EP = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;

  const rpc = async (method, params) => {
    const r = await fetch(EP, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message || 'rpc error'}`);
    return j.result;
  };
  const tokenAccounts = (programId) =>
    rpc('getTokenAccountsByOwner', [addr, { programId }, { encoding: 'jsonParsed' }]).catch(() => null);

  try {
    const [bal, t1, t2] = await Promise.all([
      rpc('getBalance', [addr]),
      tokenAccounts(TOKEN_PROGRAM),
      tokenAccounts(TOKEN_2022),
    ]);

    const sol = (bal && bal.value ? bal.value : 0) / 1e9;

    // Collapse token accounts → balance per mint (a wallet can hold a mint in multiple accounts).
    const byMint = {};
    for (const res of [t1, t2]) {
      for (const acc of (res && res.value) || []) {
        const info = acc.account && acc.account.data && acc.account.data.parsed && acc.account.data.parsed.info;
        const amt = info && info.tokenAmount && info.tokenAmount.uiAmount;
        if (info && amt > 0) byMint[info.mint] = (byMint[info.mint] || 0) + amt;
      }
    }
    let tokens = Object.keys(byMint).map((mint) => ({ mint, amount: byMint[mint] }));

    // Price the holdings via DexScreener (batched, up to 30 mints/call). Include WSOL to value SOL.
    const priceMints = [WSOL, ...tokens.map((t) => t.mint)].slice(0, 30);
    const priceOf = {};
    const symOf = {};
    const dexGet = async (u) => { for (let i = 0; i < 3; i++) { try { const r = await fetch(u); if (r.ok) return await r.json(); } catch (e) { /* retry */ } await new Promise((res) => setTimeout(res, 400)); } return null; };
    try {
      const dr = await dexGet(`https://api.dexscreener.com/latest/dex/tokens/${priceMints.join(',')}`);
      for (const p of (dr && dr.pairs) || []) {
        const m = p.baseToken && p.baseToken.address;
        const liq = (p.liquidity && p.liquidity.usd) || 0;
        if (m && (priceOf[m] === undefined || liq > (priceOf[m]._liq || 0))) {
          priceOf[m] = { price: parseFloat(p.priceUsd) || 0, _liq: liq };
          symOf[m] = (p.baseToken.symbol || '').replace(/^\$/, '');
        }
      }
    } catch (e) { /* pricing is best-effort */ }

    // Only trust a price if the pair has real liquidity — thin pools give garbage prices
    // that would inflate the portfolio with phantom value.
    const MIN_LIQ_USD = 2000;
    tokens = tokens.map((t) => {
      const pr = priceOf[t.mint];
      const liquid = pr && pr._liq >= MIN_LIQ_USD;
      const price = liquid ? pr.price : null;
      // Realizable value: you can't exit more than the pool holds. Caps phantom value from
      // scam tokens with manipulated prices in thin pools.
      const raw = price != null ? price * t.amount : null;
      const valueUsd = raw != null ? Math.min(raw, pr._liq) : null;
      return {
        mint: t.mint,
        symbol: symOf[t.mint] || null,
        amount: t.amount,
        priceUsd: price,
        valueUsd,
        capped: raw != null && raw > pr._liq,
      };
    });
    tokens.sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));

    const solPrice = priceOf[WSOL] ? priceOf[WSOL].price : null;
    const solUsd = solPrice != null ? solPrice * sol : null;
    const portfolioUsd = (solUsd || 0) + tokens.reduce((s, t) => s + (t.valueUsd || 0), 0);

    return json({
      addr,
      sol,
      solUsd,
      tokenCount: tokens.length,
      portfolioUsd,
      tokens: tokens.slice(0, 12),
      source: 'helius+dexscreener',
      ts: Date.now(),
    }, 200, { 'cache-control': 'public, max-age=30' });
  } catch (e) {
    return json({ error: e.message || 'Wallet lookup failed.' }, 502);
  }
}
