// GET /api/migrate/nonce — stateless HMAC-signed nonce for the sign-to-register flow.
import { json, preflight } from '../_utils.js';
import { issueNonce } from './_lib.js';

export const onRequestOptions = () => preflight();

export async function onRequestGet({ env }) {
  return json({ nonce: await issueNonce(env) });
}
