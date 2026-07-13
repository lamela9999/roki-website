// GET /api/migrate/admin?key=<ADMIN_KEY> — the migration payout list.
//   &format=csv          → downloadable CSV (solana_wallet, evm_wallet, amount_to_send, ...)
//   &includeUnlinked=1   → also rows for depositors who never registered an EVM wallet
//   &rescan=1            → force a fresh on-chain scan first
//   &savekey=<key>       → one-time bootstrap of the admin key (only while none is set;
//                          same pattern as sourcetest.js — env.MIGRATION_ADMIN_KEY overrides KV)
import { json, preflight } from '../_utils.js';
import { KV, SOL_ADDR_RE, getScan, contributionOf, toUi, allSubmissions, getAdminKey, isAdmin } from './_lib.js';

export const onRequestOptions = () => preflight();

// POST /api/migrate/admin?key=<ADMIN_KEY> — import a ledger scanned elsewhere.
// Body: { senders: { <solWallet>: { raw: "<digits>", txs: <n> } }, txCount }
// Used to seed the KV scan cache when RPC is throttled from CF egress; live
// rescans replace it whenever they succeed.
export async function onRequestPost({ request, env }) {
  if (!(await isAdmin(env, request))) return json({ error: 'Bad admin key.' }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad JSON body.' }, 400); }
  const senders = {};
  for (const [wallet, e] of Object.entries((body && body.senders) || {})) {
    if (!SOL_ADDR_RE.test(wallet) || !e || !/^\d+$/.test(String(e.raw))) {
      return json({ error: `Invalid entry: ${wallet}` }, 400);
    }
    senders[wallet] = { raw: String(e.raw), txs: Number(e.txs) || 0 };
  }
  if (Object.keys(senders).length === 0) return json({ error: 'Empty ledger refused.' }, 400);
  // curated: founder-reviewed final list — getScan() will never let a live
  // chain rescan overwrite it (pass curated:false to keep live rescans on)
  const curated = body.curated !== false;
  const scan = { scannedAt: Date.now(), senders, txCount: Number(body.txCount) || 0, imported: true, curated };
  await env.ZEN_KV.put(KV.scan, JSON.stringify(scan));
  return json({
    ok: true,
    wallets: Object.keys(senders).length,
    totalUi: Object.values(senders).reduce((s, e) => s + toUi(e.raw), 0),
  });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);

  const savekey = url.searchParams.get('savekey');
  if (savekey) {
    if (await getAdminKey(env)) return json({ error: 'Admin key already set.' }, 403);
    if (savekey.length < 16) return json({ error: 'Key too short (min 16 chars).' }, 400);
    await env.ZEN_KV.put(KV.adminKey, savekey);
    return json({ ok: true, note: 'Admin key saved. Keep it safe — it cannot be read back.' });
  }

  if (!(await isAdmin(env, request))) return json({ error: 'Bad admin key.' }, 403);

  let scan;
  try {
    scan = await getScan(env, { force: url.searchParams.get('rescan') === '1' });
  } catch (e) {
    return json({ error: 'Scan failed and no cached scan exists yet.', detail: String(e.message || e) }, 503);
  }

  const subs = await allSubmissions(env);
  const linkedSet = new Set(subs.map((s) => s.solAddress));
  // live on-chain amounts win over the snapshot stored at submit time
  const linked = subs.map((s) => {
    const c = contributionOf(scan, s.solAddress);
    return { ...s, amountRaw: c.raw || s.amountRaw, amountUi: c.raw ? c.ui : s.amountUi, txCount: c.txs || s.txCount };
  }).sort((a, b) => b.amountUi - a.amountUi);
  const unlinked = Object.entries(scan.senders)
    .filter(([w]) => !linkedSet.has(w))
    .map(([wallet, e]) => ({ wallet, raw: e.raw, ui: toUi(e.raw), txs: e.txs }))
    .sort((a, b) => b.ui - a.ui);

  if (url.searchParams.get('format') === 'csv') {
    const rows = [['solana_wallet', 'evm_wallet', 'amount_to_send', 'amount_raw', 'tx_count', 'updated_at']];
    for (const s of linked) rows.push([s.solAddress, s.evmAddress, s.amountUi, s.amountRaw, s.txCount, s.updatedAt]);
    if (url.searchParams.get('includeUnlinked') === '1') {
      for (const c of unlinked) rows.push([c.wallet, 'NO_EVM_SUBMITTED', c.ui, c.raw, c.txs, '']);
    }
    return new Response(rows.map((r) => r.join(',')).join('\n'), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="roki-migration-list.csv"',
        'cache-control': 'no-store',
      },
    });
  }

  return json({
    scannedAt: scan.scannedAt,
    stale: Boolean(scan.stale),
    scanError: scan.scanError || null,
    totalLinkedUi: linked.reduce((s, x) => s + (x.amountUi || 0), 0),
    totalDepositedUi: Object.values(scan.senders).reduce((s, e) => s + toUi(e.raw), 0),
    linked,
    unlinked,
  });
}
