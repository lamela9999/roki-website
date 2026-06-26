// GET /api/verdict?mint=<mint>
// The "Should I buy this?" tool. Composes everything the lab knows into one explainable verdict
// for ANY pasted token: market health, rug/authority checks, holder concentration, SMART-MONEY
// (which proven-winner wallets are in it — live cross-reference against our wallet DB), and our
// LEARNED signal edge (what each signal has actually paid). Returns a score + verdict + the
// evidence-backed reasons (pros/cons). Read-only, paper-research; never financial advice.

import { json, preflight, pickPair, solRpc } from './_utils.js';

export const onRequestOptions = () => preflight();

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EDGE_SIGS = ['smart-money', 'accumulation', 'volume-spike', 'trending', 'fresh', 'boosted'];
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const cap = (v) => v >= 1e6 ? '$' + (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? '$' + Math.round(v / 1e3) + 'k' : '$' + Math.round(v || 0);

export async function onRequestGet({ request, env }) {
  const mint = (new URL(request.url).searchParams.get('mint') || '').trim();
  if (!MINT_RE.test(mint)) return json({ error: "That doesn't look like a Solana mint address." }, 400);
  const KV = env.ZEN_KV;
  const rpc = (m, p) => solRpc(m, p, env);

  try {
    const [dex, acct, supply, largest, rug, smap, tdb, wdb] = await Promise.all([
      fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`).then((r) => r.json()).catch(() => null),
      rpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }]).catch(() => null),
      rpc('getTokenSupply', [mint]).catch(() => null),
      rpc('getTokenLargestAccounts', [mint]).catch(() => null),
      fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      KV ? KV.get('radar:db:smartmap', 'json').catch(() => null) : null,
      KV ? KV.get('radar:db:tokens', 'json').catch(() => null) : null,
      KV ? KV.get('radar:db:wallets', 'json').catch(() => null) : null,
    ]);

    const p = pickPair(dex && dex.pairs, mint);
    if (!p) return json({ mint, error: 'No live Solana market found for this token (no DEX pair). Too new, or not a tradable SPL token.' }, 200);

    // ---- market + signals ----
    const sym = ((p.baseToken && p.baseToken.symbol) || '?').replace(/^\$/, '');
    const name = (p.baseToken && p.baseToken.name) || 'Unknown';
    const liq = (p.liquidity && p.liquidity.usd) || 0;
    const mcap = p.marketCap || p.fdv || 0;
    const vol24 = (p.volume && p.volume.h24) || 0, vol1 = (p.volume && p.volume.h1) || 0;
    const pcN = (x) => { const n = p.priceChange && p.priceChange[x]; return n != null ? +n : 0; };
    const pc6 = pcN('h6'), pc24 = pcN('h24');
    const tx6 = (p.txns && p.txns.h6) || {}; const buys6 = +tx6.buys || 0, sells6 = +tx6.sells || 0;
    const buyRatio6 = (buys6 + sells6) > 0 ? buys6 / (buys6 + sells6) : 0.5;
    const ageMs = p.pairCreatedAt || 0; const ageDays = ageMs ? (Date.now() - ageMs) / 86400000 : null;
    const spike = vol24 > 0 && vol1 >= 2500 && (vol1 * 24) / vol24 >= 2.2;
    const accum = !spike && pc24 >= 2 && pc24 <= 60 && pc6 >= 0 && (buys6 + sells6) > 0 && buyRatio6 >= 0.55;

    // ---- safety ----
    const info = acct && acct.value && acct.value.data && acct.value.data.parsed && acct.value.data.parsed.info;
    const mintAuth = info ? info.mintAuthority !== null : null;
    const freezeAuth = info ? info.freezeAuthority !== null : null;
    const clean = info ? (!mintAuth && !freezeAuth) : null;
    const lpLockedPct = rug && rug.lpLockedPct != null ? +rug.lpLockedPct.toFixed(1) : null;
    const rugScore = rug && rug.score_normalised != null ? rug.score_normalised : null;
    const topRisk = rug && rug.risks && rug.risks[0] ? rug.risks[0].name : null;
    const total = Number(supply && supply.value && supply.value.amount) || 0;
    const accts = (largest && largest.value) || [];
    const top10 = (accts.length && total) ? accts.slice(0, 10).reduce((s, a) => s + Number(a.amount), 0) / total : null;

    // ---- smart money: cached map first, else LIVE Helius scan cross-referenced vs our winner DB ----
    const winners = {}; // addr -> rank
    if (wdb && wdb.wallets) {
      Object.keys(wdb.wallets).map((a) => ({ a, net: wdb.wallets[a].netSol || 0, n: wdb.wallets[a].n || 0 }))
        .filter((w) => w.net > 0 && w.n >= 3).sort((x, y) => y.net - x.net).slice(0, 300)
        .forEach((w, i) => { winners[w.a] = i + 1; });
    }
    let smartBuyers = [], smartSellers = 0, smartSource = 'none';
    const cached = smap && smap.tokens && smap.tokens[mint];
    if (cached) {
      smartBuyers = cached.buyers || []; smartSellers = cached.sellers || 0; smartSource = 'cached';
    } else if (env.HELIUS_API_KEY) {
      try {
        const r = await fetch(`https://api.helius.xyz/v0/addresses/${mint}/transactions?api-key=${env.HELIUS_API_KEY}&type=SWAP&limit=80`);
        if (r.ok) {
          const txs = await r.json();
          if (Array.isArray(txs)) {
            const per = {};
            for (const t of txs) { const sw = t.events && t.events.swap; if (!sw) continue; const tr = t.feePayer; if (!tr) continue; const pp = per[tr] = per[tr] || { in: 0, out: 0 }; pp.in += (sw.nativeInput && Number(sw.nativeInput.amount)) || 0; pp.out += (sw.nativeOutput && Number(sw.nativeOutput.amount)) || 0; }
            for (const a of Object.keys(per)) { if (winners[a] == null) continue; const net = (per[a].out - per[a].in) / 1e9; if (net < 0) smartBuyers.push({ addr: a, rank: winners[a], tokenNet: +net.toFixed(2) }); else if (net > 0) smartSellers++; }
            smartBuyers.sort((x, y) => x.rank - y.rank);
            smartSource = 'live';
          }
        }
      } catch (e) { /**/ }
    }

    // ---- learned edge ----
    const edge = (tdb && tdb.edge) || {};
    const seen = tdb && tdb.tokens && tdb.tokens[mint];

    // ---- score + reasons ----
    let score = 50; const pros = [], cons = [], info_ = [];
    // safety
    if (clean === true) { score += 12; pros.push('Contract is clean — mint & freeze authority both revoked.'); }
    else if (clean === false) { score -= 26; cons.push('🚩 Mint or freeze authority still LIVE — the dev can mint/freeze. Major rug risk.'); }
    if (lpLockedPct != null) { if (lpLockedPct >= 80) { score += 10; pros.push('LP ' + lpLockedPct + '% locked/burned — hard to pull liquidity.'); } else if (lpLockedPct < 20) { score -= 14; cons.push('Only ' + lpLockedPct + '% of LP locked — liquidity can be pulled.'); } }
    if (rugScore != null && rugScore >= 40) { score -= 12; cons.push('RugCheck risk score ' + rugScore + '/100' + (topRisk ? ' — ' + topRisk : '') + '.'); }
    else if (rugScore != null && rugScore < 15) { score += 4; pros.push('RugCheck risk low (' + rugScore + '/100).'); }
    if (top10 != null) { if (top10 > 0.7) { score -= 12; cons.push('Top 10 holders own ' + Math.round(top10 * 100) + '% — very concentrated, easy to dump on you.'); } else if (top10 < 0.4) { score += 6; pros.push('Holder spread healthy (top 10 own ' + Math.round(top10 * 100) + '%).'); } }
    // liquidity
    if (liq >= 50e3) { score += 8; pros.push('Deep liquidity (' + cap(liq) + ') — low slippage, easier exit.'); }
    else if (liq < 8e3) { score -= 14; cons.push('Thin liquidity (' + cap(liq) + ') — high slippage, hard to exit.'); }
    else { info_.push('Moderate liquidity (' + cap(liq) + ').'); }
    // smart money (our edge)
    if (smartBuyers.length > 0) { const b = Math.min(26, smartBuyers.length * 9); score += b; pros.push('🔥 ' + smartBuyers.length + ' proven-winner wallet' + (smartBuyers.length > 1 ? 's are' : ' is') + ' accumulating (ranks ' + smartBuyers.slice(0, 4).map((x) => '#' + x.rank).join(', ') + ').'); }
    if (smartSellers > 0) { score -= Math.min(18, smartSellers * 6); cons.push(smartSellers + ' proven-winner wallet' + (smartSellers > 1 ? 's are' : ' is') + ' SELLING — they may be exiting.'); }
    if (!smartBuyers.length && !smartSellers) info_.push('No proven-winner wallets detected trading this in the recent window.');
    // momentum / signals
    if (spike) { score -= 8; cons.push('Volume is spiking — buying after a spike historically loses in our data (you may be late).'); }
    if (accum) { score += 6; pros.push('Quiet accumulation pattern (steady buys, no blow-off) — the signal that holds up best for us.'); }
    if (pc24 > 80) { score -= 8; cons.push('Already up ' + Math.round(pc24) + '% (24h) — likely late / extended.'); }
    if (ageDays != null && ageDays < 0.4) { score -= 6; cons.push('Brand new (' + (ageDays * 24).toFixed(0) + 'h old) — unproven, snipe/rug risk highest.'); }
    else if (ageDays != null && ageDays > 7) info_.push('Established (' + Math.round(ageDays) + ' days old).');
    // learned edge on this token's signals
    const fired = []; if (accum) fired.push('accumulation'); if (spike) fired.push('volume-spike'); if (smartBuyers.length) fired.push('smart-money');
    fired.forEach((s) => { const e = edge[s]; if (e && e.n >= 8) { const adj = clamp(Math.round(e.avg / 12), -5, 6); score += adj; info_.push('Learned: "' + s + '" has paid ' + (e.avg >= 0 ? '+' : '') + '$' + e.avg + '/trade (' + e.winRate + '% win, ' + e.n + ' trades) in our data.'); } });
    if (seen && (seen.wins + seen.losses) > 0) info_.push('The lab has traded this token before: ' + seen.wins + 'W/' + seen.losses + 'L, net ' + (seen.pnl >= 0 ? '+' : '') + '$' + Math.round(seen.pnl) + '.');

    score = Math.round(clamp(score, 0, 100));
    const verdict = score >= 72 ? 'Strong buy candidate' : score >= 58 ? 'Lean buy' : score >= 42 ? 'Mixed — be careful' : 'Avoid';
    const verdictKind = score >= 72 ? 'strong' : score >= 58 ? 'buy' : score >= 42 ? 'caution' : 'avoid';

    return json({
      mint, symbol: sym, name, score, verdict, verdictKind,
      market: { priceUsd: parseFloat(p.priceUsd) || 0, mcap, liq, vol24, ageDays: ageDays != null ? +ageDays.toFixed(1) : null, pc24, dex: p.dexId },
      safety: { clean, mintAuth, freezeAuth, lpLockedPct, rugScore, topRisk, top10: top10 != null ? +(top10 * 100).toFixed(0) : null },
      smart: { buyers: smartBuyers.slice(0, 8), buyerCount: smartBuyers.length, sellers: smartSellers, source: smartSource },
      pros, cons, notes: info_,
      disclaimer: 'Research signal, not financial advice. Paper-research only — always verify the chart and DYOR.',
      ts: Date.now(),
    }, 200, { 'cache-control': 'public, max-age=20' });
  } catch (e) {
    return json({ error: e.message || 'Verdict failed.' }, 502);
  }
}
