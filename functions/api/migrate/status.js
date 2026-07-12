// GET /api/migrate/status?wallet=<solAddress> — verified deposit total + existing registration.
import { json, preflight } from '../_utils.js';
import { SOL_ADDR_RE, KV, getScan, contributionOf, b58decode } from './_lib.js';

export const onRequestOptions = () => preflight();

export async function onRequestGet({ request, env }) {
  const wallet = (new URL(request.url).searchParams.get('wallet') || '').trim();
  if (!SOL_ADDR_RE.test(wallet) || (b58decode(wallet) || []).length !== 32) {
    return json({ error: 'Invalid Solana address.' }, 400);
  }
  try {
    const scan = await getScan(env);
    const c = contributionOf(scan, wallet);
    const sub = await env.ZEN_KV.get(KV.sub(wallet), 'json');
    return json({
      solAddress: wallet,
      amountRaw: c.raw,
      amountUi: c.ui,
      txCount: c.txs,
      scannedAt: scan.scannedAt,
      stale: Boolean(scan.stale),
      submission: sub ? { evmAddress: sub.evmAddress, updatedAt: sub.updatedAt } : null,
    });
  } catch (e) {
    return json({ error: 'Could not check deposits right now — try again in a minute.', detail: String(e.message || e) }, 503);
  }
}
