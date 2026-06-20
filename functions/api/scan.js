// GET /api/scan?mint=<mint>
// Server-side forensic scan: DexScreener (market) + Helius (authority, holders).
// The Helius key lives in the env binding HELIUS_API_KEY (a Cloudflare secret) and
// is NEVER sent to the browser. Returns real market + safety + top-holder concentration.
// Entity clustering & funding-tree trace are the next phase (heavier transaction-graph work).

import { json, preflight, pickPair, solRpc } from './_utils.js';

export const onRequestOptions = () => preflight();

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SYSTEM_PROGRAM = '11111111111111111111111111111111'; // owns normal wallets; anything else = program/pool

// Owners that are liquidity pools / exchange custody, not retail holders. Labeled so the
// UI can be honest that concentration includes pooled/custodied supply. Extend over time.
const KNOWN_OWNERS = {
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j': 'Raydium AMM',
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM': 'exchange/custody',
  '51yZyDPGEvbS6sBVz9YJG4r6Y8Q3KAR7Wp7AHkS3UR4': 'exchange/custody',
};

export async function onRequestGet({ request, env }) {
  const mint = (new URL(request.url).searchParams.get('mint') || '').trim();
  if (!MINT_RE.test(mint)) return json({ error: "That doesn't look like a Solana mint address." }, 400);

  // Free-first RPC (publicnode/mainnet-beta), Helius only as fallback / for top-holders.
  const rpc = (method, params) => solRpc(method, params, env);

  try {
    const [dex, acct, largest, supply, rug] = await Promise.all([
      fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`).then((r) => r.json()).catch(() => null),
      rpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }]),
      rpc('getTokenLargestAccounts', [mint]).catch(() => null),
      rpc('getTokenSupply', [mint]).catch(() => null),
      // RugCheck (free) → real LP locked/burned % + risk score
      fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);

    // --- market (DexScreener: pick deepest-liquidity Solana pair) ---
    const p = pickPair(dex && dex.pairs, mint);
    const market = p ? {
      name: (p.baseToken && p.baseToken.name) || 'Unknown token',
      symbol: ((p.baseToken && p.baseToken.symbol) || '?').replace(/^\$/, ''),
      priceUsd: parseFloat(p.priceUsd) || 0,
      mcap: p.marketCap || p.fdv || 0,
      liq: (p.liquidity && p.liquidity.usd) || 0,
      vol24: (p.volume && p.volume.h24) || 0,
      dex: p.dexId || 'dex',
      pairCreatedAt: p.pairCreatedAt || 0,
    } : null;

    // --- safety (authority + supply) ---
    const info = acct && acct.value && acct.value.data && acct.value.data.parsed && acct.value.data.parsed.info;
    const total = Number(supply && supply.value && supply.value.amount) || 0;
    const topRisk = rug && rug.risks && rug.risks[0];
    const safety = {
      mintAuth: info ? (info.mintAuthority !== null) : null,
      freezeAuth: info ? (info.freezeAuthority !== null) : null,
      supply: total,
      decimals: (supply && supply.value && supply.value.decimals) ?? (info && info.decimals) ?? null,
      lpLockedPct: rug && rug.lpLockedPct != null ? +rug.lpLockedPct.toFixed(1) : null, // % of LP locked/burned (RugCheck)
      rugScore: rug && rug.score_normalised != null ? rug.score_normalised : null,       // 0-100, higher = riskier
      topRisk: topRisk ? (topRisk.name + (topRisk.level ? ' (' + topRisk.level + ')' : '')) : null,
    };

    // --- holders (top accounts → owners → concentration) ---
    const accts = (largest && largest.value) || [];
    let list = [];
    if (accts.length) {
      const infos = await rpc('getMultipleAccounts', [accts.map((a) => a.address), { encoding: 'jsonParsed' }]).catch(() => null);
      list = accts.map((a, i) => {
        const oi = infos && infos.value && infos.value[i] && infos.value[i].data
          && infos.value[i].data.parsed && infos.value[i].data.parsed.info;
        const owner = (oi && oi.owner) || null;
        return {
          owner, tokenAcct: a.address,
          amount: Number(a.amount), pct: total ? Number(a.amount) / total : 0,
          label: (owner && KNOWN_OWNERS[owner]) || null,
        };
      });
      // Flag owners whose account is program-controlled (LP vaults, protocols) — not retail wallets.
      const distinct = [...new Set(list.map((h) => h.owner).filter(Boolean))];
      if (distinct.length) {
        const oi2 = await rpc('getMultipleAccounts', [distinct, { encoding: 'jsonParsed' }]).catch(() => null);
        if (oi2 && oi2.value) {
          const progOf = {};
          distinct.forEach((o, i) => { progOf[o] = oi2.value[i] && oi2.value[i].owner; });
          list.forEach((h) => { if (!h.label && h.owner && progOf[h.owner] && progOf[h.owner] !== SYSTEM_PROGRAM) h.label = 'pool/contract'; });
        }
      }
    }
    // If the top-holder list came back empty (getTokenLargestAccounts is degraded on Helius for
    // some heavy tokens, e.g. BONK), report it as UNAVAILABLE — never as 0%, which would falsely
    // read as "no concentration = safe."
    const holders = (list.length && total) ? {
      available: true,
      sampled: list.length,
      top1: list[0].pct,
      top10: list.slice(0, 10).reduce((s, h) => s + h.pct, 0),
      pooledPct: list.filter((h) => h.label).reduce((s, h) => s + h.pct, 0),
      list,
    } : {
      available: false,
      sampled: 0,
      reason: 'Top-holder data temporarily unavailable from the RPC for this token — retry in a moment.',
      list: [],
    };

    return json({ mint, market, safety, holders, source: 'helius+dexscreener', ts: Date.now() }, 200, {
      'cache-control': 'public, max-age=30',
    });
  } catch (e) {
    return json({ error: e.message || 'Scan failed.' }, 502);
  }
}
