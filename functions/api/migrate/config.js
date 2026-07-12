// GET /api/migrate/config — public migration parameters for the /migration page.
import { json, preflight } from '../_utils.js';
import { ROKI_MINT, DEPOSIT_ADDRESS, DECIMALS, SYMBOL } from './_lib.js';

export const onRequestOptions = () => preflight();

export function onRequestGet() {
  return json({
    configured: true,
    tokenSymbol: SYMBOL,
    tokenName: 'Roki The Rabbit',
    mint: ROKI_MINT,
    depositAddress: DEPOSIT_ADDRESS,
    decimals: DECIMALS,
  });
}
