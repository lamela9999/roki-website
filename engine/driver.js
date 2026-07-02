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
const LAB_EVERY = (+(process.env.LAB_EVERY_S || 150)) * 1000;
// PHASE 2: wallet scanning moved to the dedicated `roki-wallet-engine` process (its own JSON DB,
// unlimited writes). This driver now ONLY ticks the lab. No /api/walletdb?scan=1 (redundant) and
// no /api/newlaunches polling (v1 burned the Solana Tracker free quota; the site KV-caches it).

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

let ticks = 0, errs = 0;
async function labCycle() {
  ticks++;
  const res = await hit('/api/lab?tick=1');
  log(`labtick #${ticks}:`, res);
  errs = res.startsWith('ERR') || res.startsWith('5') ? errs + 1 : 0;
  if (errs >= 10) { log('10 consecutive failures — exiting so pm2 restarts us clean.'); process.exit(1); }
}

log(`ROKI engine v3 (lab-only) → ${BASE} | lab ${LAB_EVERY / 1000}s`);
labCycle();
setInterval(labCycle, LAB_EVERY);
// heartbeat line every 10 min so `pm2 logs` always shows signs of life
setInterval(() => log('alive · ticks so far:', ticks), 600000);
