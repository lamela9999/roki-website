// GET /api/gate?addr=<wallet>
// Token-gate check for the ROKI Bot platform: does this wallet hold >= 10,000,000 $ROKI?
// $ROKI is a Token-2022 mint (9 decimals). Read-only, non-custodial — balance only.
// FREE stack: balance via free public RPC (official mainnet-beta serves getTokenAccountsByOwner),
// Helius only as a fallback. Never moves funds, never requests signing.

import { json, preflight, solRpc } from './_utils.js';

export const onRequestOptions = () => preflight();

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ROKI_MINT = 'J96hj2LiXw6UFPm7cpGQV99G5SJi4mpP7PQRZFC6brrr';
const ROKI_DECIMALS = 9;
const REQUIRED = 10_000_000; // 10M $ROKI unlocks bot creation

export async function onRequestGet({ request, env }) {
  const addr = (new URL(request.url).searchParams.get('addr') || '').trim();
  if (!ADDR_RE.test(addr)) return json({ error: "That doesn't look like a Solana wallet address." }, 400);

  try {
    // getTokenAccountsByOwner takes EITHER a mint OR a programId filter (not both).
    // Filtering by mint finds the $ROKI account regardless of token program (it's Token-2022).
    const res = await solRpc('getTokenAccountsByOwner', [addr, { mint: ROKI_MINT }, { encoding: 'jsonParsed' }], env);
    let balance = 0;
    for (const acc of (res && res.value) || []) {
      const ui = acc.account && acc.account.data && acc.account.data.parsed
        && acc.account.data.parsed.info && acc.account.data.parsed.info.tokenAmount
        && acc.account.data.parsed.info.tokenAmount.uiAmount;
      if (ui) balance += ui;
    }
    return json({
      addr,
      mint: ROKI_MINT,
      decimals: ROKI_DECIMALS,
      balance,
      required: REQUIRED,
      eligible: balance >= REQUIRED,
      shortfall: balance >= REQUIRED ? 0 : REQUIRED - balance,
      source: 'free: mainnet-beta',
      ts: Date.now(),
    }, 200, { 'cache-control': 'public, max-age=15' });
  } catch (e) {
    return json({ error: e.message || 'Gate check failed.' }, 502);
  }
}
