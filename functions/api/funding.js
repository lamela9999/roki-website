// GET /api/funding?mint=<mint>
// Backward funding trace over a token's top retail holders (Helius, key server-side).
// For each top non-pool/non-CEX holder, find the earliest incoming SOL funder within its
// recent history, then surface shared funders (sybil signal) and fresh-wallet count.
// NOTE: Helius enhanced-tx returns the last ~100 txs/wallet. For wallets with <100 txs that
// window IS their full history → the funder is the genesis funder. For very active wallets we
// only see recent funding (labeled accordingly). This is the cheap, bounded trace; the deep
// transfer-graph version lives in the Python engine (roki-radar/src).

import { json, preflight } from './_utils.js';

export const onRequestOptions = () => preflight();

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const KNOWN_OWNERS = {
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j': 'raydium',
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM': 'exchange/custody',
  '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9': 'exchange/custody',
  '2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S': 'exchange/custody',
};
const FRESH_DAYS = 14;
const MAX_HOLDERS = 4;       // keep CPU/subrequests within CF Pages Functions limits
const TX_LIMIT = 40;         // fewer enhanced-tx to parse (CPU budget)
const TRACE_TIMEOUT_MS = 6000;

export async function onRequestGet({ request, env }) {
  const mint = (new URL(request.url).searchParams.get('mint') || '').trim();
  if (!MINT_RE.test(mint)) return json({ error: "That doesn't look like a Solana mint address." }, 400);

  const KEY = env.HELIUS_API_KEY;
  if (!KEY) return json({ error: 'Forensic backend not configured (missing Helius key).' }, 503);
  const RPC = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;

  const rpc = async (method, params) => {
    const r = await fetch(RPC, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message || 'rpc error'}`);
    return j.result;
  };

  const rpcRetry = async (method, params) => {
    try { return await rpc(method, params); }
    catch (e) { await new Promise((r) => setTimeout(r, 700)); return rpc(method, params); }
  };

  try {
    const largest = await rpcRetry('getTokenLargestAccounts', [mint]);
    const accts = ((largest && largest.value) || []).slice(0, 20);
    if (!accts.length) return json({ mint, error: 'No holders found for this mint.' }, 200);

    const taInfos = await rpc('getMultipleAccounts', [accts.map((a) => a.address), { encoding: 'jsonParsed' }]);
    let holders = accts.map((a, i) => {
      const info = taInfos.value[i] && taInfos.value[i].data && taInfos.value[i].data.parsed && taInfos.value[i].data.parsed.info;
      return { owner: info && info.owner, amount: Number(a.amount) };
    }).filter((h) => h.owner);

    // Classify owners; drop pool/contract + known CEX → keep retail wallets.
    const distinct = [...new Set(holders.map((h) => h.owner))];
    const oi = await rpc('getMultipleAccounts', [distinct, { encoding: 'jsonParsed' }]).catch(() => null);
    const progOf = {};
    if (oi && oi.value) distinct.forEach((o, i) => { progOf[o] = oi.value[i] && oi.value[i].owner; });
    const retail = holders.filter((h) =>
      !KNOWN_OWNERS[h.owner] && progOf[h.owner] === SYSTEM_PROGRAM
    ).slice(0, MAX_HOLDERS);

    const now = Date.now() / 1000;
    const traced = await Promise.all(retail.map(async (h) => {
      try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), TRACE_TIMEOUT_MS);
        const r = await fetch(`https://api.helius.xyz/v0/addresses/${h.owner}/transactions?api-key=${KEY}&limit=${TX_LIMIT}`, { signal: ctrl.signal });
        clearTimeout(to);
        if (!r.ok) return { owner: h.owner, funder: null };
        const txs = await r.json();
        let funder = null, fundTs = null;
        for (let i = txs.length - 1; i >= 0; i--) {
          const nt = (txs[i].nativeTransfers || []).filter((t) => t.toUserAccount === h.owner && t.amount > 0);
          if (nt.length) { funder = nt[0].fromUserAccount; fundTs = txs[i].timestamp; break; }
        }
        const oldestTs = txs.length ? txs[txs.length - 1].timestamp : null;
        const fullHistory = txs.length < TX_LIMIT; // saw all txs → genesis funder
        const fresh = fullHistory && oldestTs && (now - oldestTs) < FRESH_DAYS * 86400;
        return { owner: h.owner, funder, fundTs, fresh, fullHistory };
      } catch (e) { return { owner: h.owner, funder: null }; }
    }));

    // Group shared funders.
    const groups = {};
    traced.forEach((t) => { if (t.funder) (groups[t.funder] = groups[t.funder] || []).push(t.owner); });
    const sharedFunders = Object.keys(groups)
      .filter((f) => groups[f].length >= 2)
      .map((f) => ({ funder: f, count: groups[f].length, holders: groups[f] }))
      .sort((a, b) => b.count - a.count);

    const freshCount = traced.filter((t) => t.fresh).length;
    const genesisCount = traced.filter((t) => t.fullHistory).length;

    return json({
      mint,
      holdersAnalyzed: retail.length,
      freshCount,
      genesisCount,
      sharedFunders,
      window: `last ${TX_LIMIT} tx per holder`,
      note: genesisCount < retail.length
        ? 'Some top holders are highly active; for those the funder shown is the most recent funding seen, not genesis.'
        : 'All analyzed holders had <100 lifetime txs, so funders are genesis-level.',
      source: 'helius',
      ts: Date.now(),
    }, 200, { 'cache-control': 'public, max-age=60' });
  } catch (e) {
    return json({ error: e.message || 'Funding trace failed.' }, 502);
  }
}
