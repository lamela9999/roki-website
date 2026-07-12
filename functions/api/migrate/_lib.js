// Shared logic for /api/migrate/* — ROKI Solana→EVM migration registration.
//
// Holders sent $ROKI to the migration deposit wallet. This module rebuilds the
// full contribution ledger from chain history (who sent how much), verifies
// ed25519 wallet-ownership signatures, and stores EVM registrations in KV.
//
// Storage layout (ZEN_KV):
//   roki:migration:scan            — cached full scan {scannedAt, senders:{wallet:{raw,txs}}, txCount}
//   roki:migration:sub:<solAddr>   — one key per registration (no read-modify-write races)
//   roki:migration:cfg:secret      — HMAC secret for stateless nonces (self-initialized)
//   roki:migration:cfg:adminkey    — admin key (bootstrapped via admin.js ?savekey=, like sourcetest)
import { solRpc } from '../_utils.js';

export const ROKI_MINT = 'J96hj2LiXw6UFPm7cpGQV99G5SJi4mpP7PQRZFC6brrr';
export const DEPOSIT_ADDRESS = '97EasS5jL7SNhmZeFFWEcbAAyFWABooNVFGSy4wRzji3';
// The deposit wallet's ROKI (Token-2022) associated token account. Fixed for a
// given (owner, mint) pair, so scans don't need a getTokenAccountsByOwner
// discovery call (which 429s constantly from CF egress). If the deposit wallet
// ever changes, re-derive with getTokenAccountsByOwner(DEPOSIT_ADDRESS, {mint}).
export const DEPOSIT_TOKEN_ACCOUNTS = ['FaaKtoLaGsQ3X3TfrBRLueyn38sErjRZvhc6THcP99EJ'];
export const DECIMALS = 9;
export const SYMBOL = 'ROKI';

export const KV = {
  scan: 'roki:migration:scan',
  sub: (sol) => `roki:migration:sub:${sol}`,
  subPrefix: 'roki:migration:sub:',
  secret: 'roki:migration:cfg:secret',
  adminKey: 'roki:migration:cfg:adminkey',
};

export const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export function buildMessage(solAddress, evmAddress, nonce) {
  return `${SYMBOL} migration: link EVM wallet ${evmAddress} to Solana wallet ${solAddress}\nNonce: ${nonce}`;
}

export function toUi(raw) {
  return Number(BigInt(raw)) / 10 ** DECIMALS;
}

// ---- base58 (Solana pubkeys) ----

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c === '1') bytes.unshift(0); else break; }
  return new Uint8Array(bytes);
}

// ---- ed25519 signature verification (WebCrypto) ----

export async function verifyEd25519(pubkeyBytes, message, sigBytes) {
  const msg = new TextEncoder().encode(message);
  let key;
  try {
    key = await crypto.subtle.importKey('raw', pubkeyBytes, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, sigBytes, msg);
  } catch {
    // older workerd naming
    key = await crypto.subtle.importKey('raw', pubkeyBytes, { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' }, false, ['verify']);
    return await crypto.subtle.verify('NODE-ED25519', key, sigBytes, msg);
  }
}

export function b64decode(s) {
  const bin = atob(String(s));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- stateless HMAC nonces (KV is eventually consistent, so no per-nonce storage) ----

async function getSecret(env) {
  let s = await env.ZEN_KV.get(KV.secret);
  if (!s) {
    s = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
    await env.ZEN_KV.put(KV.secret, s);
  }
  return s;
}

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function issueNonce(env) {
  const ts = Date.now();
  const mac = (await hmacHex(await getSecret(env), String(ts))).slice(0, 32);
  return `${ts}.${mac}`;
}

export async function checkNonce(env, nonce) {
  const [tsStr, mac] = String(nonce || '').split('.');
  const ts = Number(tsStr);
  if (!ts || !mac) return false;
  if (Math.abs(Date.now() - ts) > 10 * 60_000) return false;
  const expect = (await hmacHex(await getSecret(env), tsStr)).slice(0, 32);
  return timingSafeEq(mac, expect);
}

export function timingSafeEq(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- admin auth: env var wins, else KV-stashed key (sourcetest ?savekey= pattern) ----

export async function getAdminKey(env) {
  return env.MIGRATION_ADMIN_KEY || (await env.ZEN_KV.get(KV.adminKey)) || null;
}

export async function isAdmin(env, request) {
  const key = new URL(request.url).searchParams.get('key') || request.headers.get('x-admin-key') || '';
  const stored = await getAdminKey(env);
  return Boolean(stored && key && timingSafeEq(key, stored));
}

// ---- on-chain scan: full rebuild each pass (idempotent — concurrent scans converge) ----

function rpcUrls(env) {
  return [
    env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}` : null,
    'https://api.mainnet-beta.solana.com',
    'https://solana-rpc.publicnode.com',
  ].filter(Boolean);
}

// One JSON-RPC batch request = one subrequest, so a full history scan stays
// well inside the Workers subrequest budget.
async function txBatch(sigs, env) {
  const body = sigs.map((s, i) => ({
    jsonrpc: '2.0', id: i, method: 'getTransaction',
    params: [s, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }],
  }));
  let lastErr = 'no endpoint';
  for (const url of rpcUrls(env)) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) { lastErr = `HTTP ${r.status}`; continue; }
      const arr = await r.json();
      if (!Array.isArray(arr)) { lastErr = 'non-batch response'; continue; }
      if (arr.some((x) => x.error && /429|limit|too many/i.test(JSON.stringify(x.error)))) { lastErr = 'rate limited'; continue; }
      const byId = new Map(arr.map((x) => [x.id, x.result]));
      return sigs.map((_, i) => byId.get(i) ?? null);
    } catch (e) { lastErr = String(e.message || e); }
  }
  throw new Error(`tx batch failed: ${lastErr}`);
}

function creditTransfers(tx, depositTokenAccount, senders) {
  if (!tx || (tx.meta && tx.meta.err)) return;
  const instructions = [...((tx.transaction && tx.transaction.message && tx.transaction.message.instructions) || [])];
  for (const inner of (tx.meta && tx.meta.innerInstructions) || []) instructions.push(...inner.instructions);
  for (const ix of instructions) {
    const parsed = ix.parsed;
    if (!parsed || (parsed.type !== 'transfer' && parsed.type !== 'transferChecked')) continue;
    const info = parsed.info;
    if (info.destination !== depositTokenAccount) continue;
    const amount = parsed.type === 'transferChecked' ? info.tokenAmount && info.tokenAmount.amount : info.amount;
    const sender = info.authority || info.multisigAuthority || (info.signers && info.signers[0]);
    if (!sender || !amount) continue;
    const entry = senders[sender] || { raw: '0', txs: 0 };
    entry.raw = (BigInt(entry.raw) + BigInt(amount)).toString();
    entry.txs += 1;
    senders[sender] = entry;
  }
}

async function rescan(env) {
  const tokenAccounts = DEPOSIT_TOKEN_ACCOUNTS;
  const senders = {};
  let txCount = 0;
  for (const acc of tokenAccounts) {
    // full signature history, newest-first pages
    const sigs = [];
    let before;
    for (;;) {
      const page = await solRpc('getSignaturesForAddress', [acc, { limit: 1000, before, commitment: 'confirmed' }], env);
      if (!Array.isArray(page)) throw new Error('signature fetch failed');
      sigs.push(...page);
      if (page.length < 1000) break;
      before = page[page.length - 1].signature;
    }
    const ok = sigs.filter((s) => !s.err).map((s) => s.signature);
    txCount += ok.length;
    const CHUNK = 25;
    for (let i = 0; i < ok.length; i += CHUNK) {
      const txs = await txBatch(ok.slice(i, i + CHUNK), env);
      for (const tx of txs) creditTransfers(tx, acc, senders);
    }
  }
  return { scannedAt: Date.now(), senders, txCount };
}

export async function getScan(env, { maxAgeMs = 5 * 60_000, force = false } = {}) {
  const cached = await env.ZEN_KV.get(KV.scan, 'json');
  if (cached && !force && Date.now() - cached.scannedAt < maxAgeMs) return cached;
  try {
    const fresh = await rescan(env);
    await env.ZEN_KV.put(KV.scan, JSON.stringify(fresh));
    return fresh;
  } catch (e) {
    // serve last-good rather than nothing (same stale pattern as regime.js)
    if (cached) return { ...cached, stale: true, scanError: String(e.message || e) };
    throw e;
  }
}

export function contributionOf(scan, wallet) {
  const e = scan.senders[wallet];
  if (!e) return { raw: '0', ui: 0, txs: 0 };
  return { raw: e.raw, ui: toUi(e.raw), txs: e.txs };
}

export async function allSubmissions(env) {
  const subs = [];
  let cursor;
  for (;;) {
    const page = await env.ZEN_KV.list({ prefix: KV.subPrefix, cursor });
    for (const k of page.keys) {
      const rec = await env.ZEN_KV.get(k.name, 'json');
      if (rec) subs.push(rec);
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return subs;
}
