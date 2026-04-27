#!/usr/bin/env bash
# SplitCat VPS bootstrap
# Tested on Ubuntu 24.04 LTS (Hetzner / DigitalOcean / Vultr).
#
# Usage (on a fresh VPS, as root):
#   curl -fsSL https://raw.githubusercontent.com/YOUR_USER/splitcat/main/deploy/setup-vps.sh | bash
# Or after cloning:
#   sudo bash deploy/setup-vps.sh

set -euo pipefail

echo "==> Updating apt and installing base packages"
apt-get update
apt-get install -y ca-certificates curl gnupg ufw git

echo "==> Installing Docker"
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

echo "==> Configuring firewall (ufw)"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp       # SSH
ufw allow 80/tcp       # HTTP (Caddy uses this for Let's Encrypt challenge)
ufw allow 443/tcp      # HTTPS
ufw --force enable

echo "==> Creating app directory at /opt/splitcat"
mkdir -p /opt/splitcat
cd /opt/splitcat

if [ ! -d .git ]; then
  echo "==> Clone your fork here:"
  echo "    git clone https://github.com/YOUR_USER/splitcat.git /opt/splitcat"
  echo "Then re-run this script, or continue manually with:"
  echo "    cp deploy/.env.example deploy/.env && nano deploy/.env"
  echo "    docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d"
  exit 0
fi

if [ ! -f deploy/.env ]; then
  echo "==> deploy/.env not found. Copying from example."
  cp deploy/.env.example deploy/.env
  echo "!! Edit deploy/.env with your secrets, then re-run this script."
  exit 1
fi

echo "==> Starting stack"
docker compose -f deploy/docker-compose.yml --env-file deploy/.env pull
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build

echo "==> Installing systemd auto-update unit"
cp deploy/splitcat-update.service /etc/systemd/system/
cp deploy/splitcat-update.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now splitcat-update.timer

echo ""
echo "✓ SplitCat is up."
echo "  → Public URL: https://$(grep '^PUBLIC_HOST=' deploy/.env | cut -d= -f2)/"
echo "  → Health:     https://$(grep '^PUBLIC_HOST=' deploy/.env | cut -d= -f2)/health"
echo "  → Logs:       docker compose -f deploy/docker-compose.yml logs -f bot"
echo ""
echo "Next steps:"
echo "  1. Confirm your domain's A record points at this VPS's IP."
echo "  2. Wait ~30s for Caddy to fetch TLS certs."
echo "  3. The bot auto-registers its Telegram webhook on startup — no manual step."
echo "  4. Add the bot to a Telegram group and snap a receipt photo to test."
