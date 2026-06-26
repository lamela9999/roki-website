# ROKI Engine — always-on data heartbeat

Keeps the live ROKI data (wallet DB, smart-money map, lab sim, new launches) **growing
continuously** from a server you control, instead of fragile cron-job.org pings that keep
auto-disabling. This is the first piece of "owning our own backend."

## What it does
Loops 24/7 and drives the existing endpoints:
- `/api/walletdb?scan=1` every ~90s → grows the wallet DB + smart-money map
- `/api/lab?tick=1` every ~120s → advances the trading sim (server floors to 1 tick / 5 min)
- `/api/newlaunches` every ~120s → keeps the fresh-launch feed warm

## Deploy on the Stringr droplet (Ubuntu)

```bash
# 1. Node 18+ (check first)
node -v   # if missing or <18:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs

# 2. Drop the driver on the box
mkdir -p ~/roki-engine && cd ~/roki-engine
# copy driver.js here (scp, or paste it with: nano driver.js)

# 3. pm2 keeps it alive + restarts on crash/reboot
sudo npm install -g pm2
pm2 start driver.js --name roki-engine
pm2 save
pm2 startup        # then run the one command it prints

# 4. Watch it work
pm2 logs roki-engine
```

You should see lines like `walletscan #1: 200 8200ms wallets=861 new=8` ticking by — that's the
data growing again.

## Tune the cadence (optional)
Faster growth = more Cloudflare KV writes. If you ever hit KV write limits, slow it down:
```bash
pm2 delete roki-engine
WALLET_EVERY_S=180 LAB_EVERY_S=300 pm2 start driver.js --name roki-engine
pm2 save
```

## Stop / restart
```bash
pm2 restart roki-engine
pm2 stop roki-engine
pm2 delete roki-engine
```

## Next step (Phase 2 — true ownership)
This driver still relies on Cloudflare KV (which has daily write limits). The full version moves
the growing data into a **real database on this droplet** (unlimited writes) + a **Helius stream
listener** for genuinely real-time new-token discovery — then the site reads snapshots from here.
That removes all limits and is also the backend needed for real trade execution later.
