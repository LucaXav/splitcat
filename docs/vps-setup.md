# VPS setup

Step-by-step for bringing up SplitCat on a fresh Linux VPS. Assumes Ubuntu 24.04 LTS.

## 1. Provision a VPS

Minimum: **1 vCPU, 2 GB RAM, 20 GB disk**. Hetzner CX11 (€3.29/month) is ideal. DigitalOcean's $4 droplet works too.

For Singapore latency, use AWS Lightsail Singapore ($5/month) or DigitalOcean SGP1 ($6/month). Hetzner EU is fine if latency isn't critical.

During provisioning:
- SSH key auth only
- Label it `splitcat-prod`

## 2. Point a domain at it

Add an `A` record for `splitcat.yourdomain.com` → VPS's IPv4. Caddy uses this to fetch a Let's Encrypt cert automatically on first boot.

If you don't own a domain: any registrar (Cloudflare Registrar, Porkbun) works. For testing, a free DuckDNS subdomain is fine.

## 3. SSH in

```bash
ssh root@YOUR_VPS_IP
```

## 4. Clone the repo

```bash
apt update && apt install -y git
git clone https://github.com/YOUR_USERNAME/splitcat.git /opt/splitcat
cd /opt/splitcat
```

## 5. Configure secrets

```bash
cp deploy/.env.example deploy/.env
nano deploy/.env
```

Fill in:

| Var | How to get it |
|---|---|
| `PUBLIC_HOST` | The domain you set up (e.g. `splitcat.yourdomain.com`) |
| `PUBLIC_URL` | `https://` + the same domain |
| `DATABASE_URL` | Neon Postgres connection string. Sign up at [neon.tech](https://neon.tech), create a project, copy the pooled connection string from "Connection Details" |
| `TELEGRAM_BOT_TOKEN` | From [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_WEBHOOK_SECRET` | `openssl rand -hex 32` |
| `ANTHROPIC_API_KEY` | From [console.anthropic.com](https://console.anthropic.com) |
| `MINI_APP_URL` | Leave blank for now; fill in after Vercel deploy |
| `MINI_APP_SECRET` | `openssl rand -hex 32` (must match Vercel's value) |

### Apply the schema to Neon

The Neon database starts empty. Apply the schema once from any machine that can reach Neon (your laptop or the VPS):

```bash
psql "$DATABASE_URL" < db/schema.sql
```

Re-run only when `db/schema.sql` changes — the file is idempotent enough for fresh databases but not for migrations on existing data.

## 6. Run the bootstrap script

```bash
bash deploy/setup-vps.sh
```

This installs Docker, opens ports 22/80/443 in the firewall, builds and brings up the stack, and enables the auto-update systemd timer.

Watch the logs:
```bash
docker compose -f deploy/docker-compose.yml logs -f bot
```

You should see:
```
Bot HTTP server listening port=3000
Webhook registered with Telegram webhookUrl=https://splitcat.yourdomain.com/telegram-webhook
Nudge scheduler started cron=0 */6 * * * tz=Asia/Singapore
```

Wait ~30 seconds for Caddy to fetch a TLS cert, then verify:
```bash
curl https://splitcat.yourdomain.com/health
# → {"ok":true,"ts":1234567890}
```

## 7. Deploy the Mini App

See [`../mini-app/README.md`](../mini-app/README.md). After it's live, paste the Vercel URL into `deploy/.env` as `MINI_APP_URL`, then rebuild:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

## 8. Test

Add the bot to a Telegram group, send `/start`, snap a receipt photo.

---

## Ongoing ops

### Push-to-deploy

Push to `main` on GitHub. The `splitcat-update.timer` runs every 5 minutes on the VPS, pulls the latest code, rebuilds the bot image, and restarts. About 60 seconds of downtime during rebuild — for a side project this is fine. Add a CI step before deploy if you want zero-downtime.

To force an immediate update:
```bash
systemctl start splitcat-update.service
```

To watch:
```bash
journalctl -u splitcat-update.service -f
```

### Backups

Neon takes care of point-in-time recovery for you (7 days on the free tier). For an off-site logical dump, run from any machine that can reach Neon:

```bash
cat > /etc/cron.daily/splitcat-backup <<'EOF'
#!/bin/bash
source /opt/splitcat/deploy/.env
pg_dump "$DATABASE_URL" | gzip > /var/backups/splitcat-$(date +%F).sql.gz
find /var/backups -name 'splitcat-*.sql.gz' -mtime +14 -delete
EOF
chmod +x /etc/cron.daily/splitcat-backup
```

For off-site, pipe to `aws s3 cp` or `rclone` to your storage of choice.

### Restore

```bash
gunzip < /var/backups/splitcat-2026-04-15.sql.gz | psql "$DATABASE_URL"
```

### Scaling

This stack handles a few hundred active users comfortably. Past that:

- Neon scales transparently — bump the compute size in the Neon dashboard if you outgrow the free tier.
- Run two bot instances behind Caddy with `WEBHOOK_PROVIDED_TOKEN` rotation, sharing the same Neon database.
- The nudge scheduler can stay on one instance — partition by `group_id % N` if you ever need multiple workers.
