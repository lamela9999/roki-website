#!/usr/bin/env node
/*
 * ROKI Engine — the always-on heartbeat.
 *
 * Runs 24/7 on a server (your Stringr droplet) and keeps the live data GROWING continuously,
 * replacing the fragile cron-job.org pings that keep auto-disabling. It just drives the existing
 * endpoints on a tight loop:
 *   • /api/walletdb?scan=1  → grows the wallet DB + smart-money map (the part that was stagnant)
 *   • /api/lab?tick=1       → advances the trading sim (server floors it to one tick / 5 min)
 *   • /api/newlaunches      → keeps the fresh-launch feed warm
 *
 * Node 18+ (built-in fetch). Run under pm2 so it restarts on crash/reboot. See README.md.
 *
 * Tune cadence with env vars (seconds): WALLET_EVERY_S, LAB_EVERY_S, NL_EVERY_S.
 */

const BASE = process.env.ROKI_BASE || 'https://roki.buzz';
const WALLET_EVERY = (+(process.env.WALLET_EVERY_S || 90)) * 1000;
const LAB_EVERY = (+(process.env.LAB_EVERY_S || 120)) * 1000;
const NL_EVERY = (+(process.env.NL_EVERY_S || 120)) * 1000;

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function hit(path) {
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + path, { signal: AbortSignal.timeout(70000) });
    const body = await r.text();
    let extra = '';
    try { const j = JSON.parse(body); if (j.walletsKnown != null) extra = `wallets=${j.walletsKnown} new=${j.newWallets}`; else if (j.tick != null) extra = `tick=${j.tick} adv=${j.advanced}`; else if (j.count != null) extra = `count=${j.count}`; } catch (e) { /**/ }
    return `${r.status} ${Date.now() - t0}ms ${extra}`;
  } catch (e) { return 'ERR ' + (e.message || e); }
}

let scans = 0;
async function walletCycle() { scans++; log(`walletscan #${scans}:`, await hit('/api/walletdb?scan=1')); }
async function labCycle() { log('labtick:', await hit('/api/lab?tick=1')); }
async function nlCycle() { await hit('/api/newlaunches'); }

log(`ROKI engine → ${BASE} | wallet ${WALLET_EVERY / 1000}s · lab ${LAB_EVERY / 1000}s · newlaunches ${NL_EVERY / 1000}s`);
walletCycle();
setInterval(walletCycle, WALLET_EVERY);
setTimeout(() => { labCycle(); setInterval(labCycle, LAB_EVERY); }, 5000);
setTimeout(() => { nlCycle(); setInterval(nlCycle, NL_EVERY); }, 10000);
