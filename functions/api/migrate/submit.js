// POST /api/migrate/submit — register (or update) the EVM wallet for a Solana wallet.
// Body: { solAddress, evmAddress, nonce, signature (base64 ed25519 over buildMessage) }
// The amount is NEVER taken from the user — it comes from the on-chain scan.
import { json, preflight } from '../_utils.js';
import {
  SOL_ADDR_RE, EVM_ADDR_RE, KV, SYMBOL,
  buildMessage, checkNonce, b58decode, b64decode, verifyEd25519,
  getScan, contributionOf,
} from './_lib.js';

export const onRequestOptions = () => preflight();

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request body.' }, 400); }
  const { solAddress, evmAddress, nonce, signature } = body || {};

  // 1. fresh server-issued nonce
  if (!(await checkNonce(env, nonce))) {
    return json({ error: 'Session expired — please try signing again.' }, 400);
  }

  // 2. addresses
  const pubkey = SOL_ADDR_RE.test(String(solAddress || '')) ? b58decode(solAddress) : null;
  if (!pubkey || pubkey.length !== 32) return json({ error: 'Invalid Solana address.' }, 400);
  const evm = String(evmAddress || '').trim();
  if (!EVM_ADDR_RE.test(evm)) {
    return json({ error: 'Invalid EVM address (must be 0x + 40 hex characters).' }, 400);
  }

  // 3. the Solana wallet must have signed exactly the expected message
  let ok = false;
  try {
    ok = await verifyEd25519(pubkey, buildMessage(solAddress, evm, nonce), b64decode(signature));
  } catch { ok = false; }
  if (!ok) return json({ error: 'Signature verification failed.' }, 401);

  // 4. wallet must actually have deposited
  let scan;
  try { scan = await getScan(env); } catch (e) {
    return json({ error: 'Could not verify deposits right now — try again in a minute.' }, 503);
  }
  const c = contributionOf(scan, solAddress);
  if (BigInt(c.raw) <= 0n) {
    return json({
      error: `No ${SYMBOL} deposits found from this wallet. If you just sent, wait a few minutes and retry. ` +
        'Note: tokens sent directly from an exchange cannot be attributed to you — contact the team with your transaction signature.',
    }, 400);
  }

  // 5. store — one KV key per Solana wallet, updates keep an audit history
  const now = new Date().toISOString();
  const prev = await env.ZEN_KV.get(KV.sub(solAddress), 'json');
  const record = {
    solAddress,
    evmAddress: evm.toLowerCase(),
    amountRaw: c.raw,
    amountUi: c.ui,
    txCount: c.txs,
    firstSubmittedAt: prev ? prev.firstSubmittedAt : now,
    updatedAt: now,
    proof: { message: buildMessage(solAddress, evm, nonce), signature: String(signature) },
    history: [...((prev && prev.history) || []), { at: now, evmAddress: evm.toLowerCase() }].slice(-20),
  };
  await env.ZEN_KV.put(KV.sub(solAddress), JSON.stringify(record));

  return json({
    ok: true,
    amountUi: c.ui,
    submission: { solAddress, evmAddress: record.evmAddress, updatedAt: now },
  });
}
