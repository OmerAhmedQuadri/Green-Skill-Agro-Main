#!/usr/bin/env bash
# One-time setup of Green Agro staging on the VPS (ADR-0035). Run as root from
# the cloned repository:
#
#   bash /root/green-agro-app/deploy/setup-vps.sh app.greenskillagro.com
#
# Installs Docker for PostgreSQL; pnpm for this app only; writes the
# app's .env with generated passwords; starts the database; adds the nginx site
# and its certificate. The app itself runs under the existing pm2, beside the
# other app. Safe to run again — it keeps what exists.
set -euo pipefail

DOMAIN=${1:?usage: setup-vps.sh <domain>}
APP_DIR=$(cd "$(dirname "$0")/.." && pwd)
ENV_FILE=$APP_DIR/.env
PORT=3000                       # loopback only; nginx proxies to it

log() { printf '\n== %s\n' "$*"; }
[[ $EUID -eq 0 ]] || { echo "Run as root."; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' \
  || { echo "Node 24 or later is needed (found $(node -v))."; exit 1; }

log "pnpm for this app only, in $APP_DIR/.tools — nothing system-wide changes"
# deploy.sh installs the version package.json pins; this proves it works here.
bash "$APP_DIR/deploy/pnpm.sh" --version

log "Docker, for PostgreSQL"
if ! command -v docker >/dev/null; then
  apt-get update -q
  apt-get install -y -q ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi

log "Configuration in $ENV_FILE"
setenv() { # KEY VALUE — replaces that line only, so .env stays line for line like .env.example
  local v=${2//\\/\\\\}; v=${v//&/\\&}; v=${v//|/\\|}
  sed -i "s|^$1=.*|$1=$v|" "$ENV_FILE"
}
if [[ ! -f $ENV_FILE ]]; then
  cp "$APP_DIR/.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  owner=$(openssl rand -hex 24)
  app=$(openssl rand -hex 24)
  setenv POSTGRES_OWNER_PASSWORD "$owner"
  setenv POSTGRES_APP_PASSWORD "$app"
  setenv DATABASE_URL "postgres://gsa_app:$app@127.0.0.1:5432/gsa"
  setenv DATABASE_OWNER_URL "postgres://gsa_owner:$owner@127.0.0.1:5432/gsa"
  setenv SESSION_SECRET "$(openssl rand -hex 32)"
  setenv S3_KEY_PREFIX "staging/"   # staging shares the test bucket, under its own prefix
  for key in S3_ACCESS_KEY S3_SECRET_KEY DEV_SEED_PASSWORD; do setenv "$key" ""; done
fi
setenv APP_URL "https://$DOMAIN"

log "PostgreSQL in Docker, on 127.0.0.1:5432"
docker compose --env-file "$ENV_FILE" -f "$APP_DIR/deploy/docker-compose.staging.yml" up -d --wait

log "nginx site for $DOMAIN"
site=/etc/nginx/sites-available/green-agro
if [[ ! -f $site ]]; then   # once written, certbot edits it — never overwrite
  sed -e "s/__DOMAIN__/$DOMAIN/g" -e "s/__PORT__/$PORT/g" "$APP_DIR/deploy/nginx-site.conf" > "$site"
  ln -sf "$site" /etc/nginx/sites-enabled/green-agro
fi
nginx -t && systemctl reload nginx

log "Certificate for $DOMAIN"
certbot --nginx -d "$DOMAIN" --redirect --non-interactive --agree-tos \
  || echo "certbot wants input — run:  certbot --nginx -d $DOMAIN --redirect"

if ! systemctl is-enabled --quiet pm2-root 2>/dev/null; then
  log "Note: pm2 does not start at boot on this VPS (no pm2-root service). 'pm2 startup' would enable it for every pm2 app, including the other one — your call."
fi

log "Done. Next: fill in the R2, email and seed values in $ENV_FILE, then:  bash $APP_DIR/deploy/deploy.sh --seed"
