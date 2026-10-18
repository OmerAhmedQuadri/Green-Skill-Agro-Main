#!/usr/bin/env bash
# One-time setup of a copy of Green Skill Agro on the VPS — staging or
# production (ADR-0035, ADR-0058). Run as root from that copy's cloned folder:
#
#   bash /root/gsa-sales-inventory-app/staging/Green-Skill-Agro-Main/deploy/setup-vps.sh staging.greenskillagro.com staging
#   bash /root/gsa-sales-inventory-app/production/Green-Skill-Agro-Main/deploy/setup-vps.sh app.greenskillagro.com production
#
# Installs Docker for PostgreSQL; pnpm for this app only; writes the copy's
# .env with generated passwords; starts its database; adds its nginx site and
# certificate. The app itself runs under the existing pm2, beside the other
# app. Safe to run again — it keeps what exists.
set -euo pipefail

DOMAIN=${1:?usage: setup-vps.sh <domain> <staging|production>}
INSTANCE=${2:?usage: setup-vps.sh <domain> <staging|production>}
[[ $INSTANCE == staging || $INSTANCE == production ]] || { echo "The copy is staging or production, not $INSTANCE."; exit 1; }
APP_DIR=$(cd "$(dirname "$0")/.." && pwd)
ENV_FILE=$APP_DIR/.env

log() { printf '\n== %s\n' "$*"; }
[[ $EUID -eq 0 ]] || { echo "Run as root."; exit 1; }
# Package installs ask nothing, and needrestart only lists what it would
# restart — it never restarts nginx, MySQL or anything the other app relies on.
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l NEEDRESTART_SUSPEND=1
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
setenv() { # KEY VALUE — replaces that line, so .env stays line for line like .env.example; adds it if a .env predates the key
  local v=${2//\\/\\\\}; v=${v//&/\\&}; v=${v//|/\\|}
  if grep -q "^$1=" "$ENV_FILE"; then sed -i "s|^$1=.*|$1=$v|" "$ENV_FILE"; else printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"; fi
}
fresh=false
if [[ ! -f $ENV_FILE ]]; then
  cp "$APP_DIR/.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  fresh=true
fi
setenv APP_INSTANCE "$INSTANCE"
cd "$APP_DIR"
source deploy/lib.sh   # the copy's ports and Compose project, from APP_INSTANCE
if $fresh; then
  owner=$(openssl rand -hex 24)
  app=$(openssl rand -hex 24)
  setenv POSTGRES_OWNER_PASSWORD "$owner"
  setenv POSTGRES_APP_PASSWORD "$app"
  setenv DATABASE_URL "postgres://gsa_app:$app@127.0.0.1:$POSTGRES_PORT/gsa"
  setenv DATABASE_OWNER_URL "postgres://gsa_owner:$owner@127.0.0.1:$POSTGRES_PORT/gsa"
  setenv SESSION_SECRET "$(openssl rand -hex 32)"
  # Staging shares the test bucket under its own prefix; production has a bucket of its own.
  setenv S3_KEY_PREFIX "$([[ $INSTANCE == staging ]] && echo staging/ || echo '')"
  for key in S3_ACCESS_KEY S3_SECRET_KEY DEV_SEED_PASSWORD; do setenv "$key" ""; done
fi
setenv APP_URL "https://$DOMAIN"

log "PostgreSQL in Docker for $INSTANCE, on 127.0.0.1:$POSTGRES_PORT"
"${COMPOSE[@]}" up -d --wait

log "Cloudflare's addresses, for the visitor's real IP (the domain is proxied)"
realip=/etc/nginx/snippets/cloudflare-realip.conf
if [[ ! -f $realip ]]; then
  {
    echo "# Cloudflare edge addresses (https://www.cloudflare.com/ips/), fetched $(date -u +%F)."
    echo "# CF-Connecting-IP is trusted only from these. Included by the green-agro site only."
    for list in ips-v4 ips-v6; do { curl -fsS "https://www.cloudflare.com/$list"; echo; } | sed '/^$/d; s/.*/set_real_ip_from &;/'; done
    echo "real_ip_header CF-Connecting-IP;"
  } > "$realip"
fi

log "nginx site for $DOMAIN"
site=/etc/nginx/sites-available/$DOMAIN   # named after its domain, like the VPS's other sites
repoint="sed -i 's#127.0.0.1:[0-9]*;#127.0.0.1:$APP_PORT;#' %s && nginx -t && systemctl reload nginx"
serving=$(grep -l "server_name[[:space:]]\+$DOMAIN;" /etc/nginx/sites-enabled/* 2>/dev/null | head -1 || true)
if [[ -n $serving && $(readlink -f "$serving") != "$site" ]]; then
  # Another file already answers for the domain — left alone (ADR-0058).
  echo "$serving already serves $DOMAIN — left as it is. To send it to this copy (port $APP_PORT):"
  printf "  $repoint\n" "$(readlink -f "$serving")"
else
  if [[ ! -f $site ]]; then   # once written, certbot edits it — never overwrite
    sed -e "s/__DOMAIN__/$DOMAIN/g" -e "s/__PORT__/$APP_PORT/g" "$APP_DIR/deploy/nginx-site.conf" > "$site"
    ln -sf "$site" "/etc/nginx/sites-enabled/$DOMAIN"
  fi
  if ! grep -q "127.0.0.1:$APP_PORT;" "$site"; then
    # At the split, app.greenskillagro.com still sends to staging until production is ready (RUNBOOK §9.3).
    echo "$site sends $DOMAIN to another port — left as it is. To send it to this copy (port $APP_PORT):"
    printf "  $repoint\n" "$site"
  fi
  nginx -t && systemctl reload nginx
  log "Certificate for $DOMAIN"
  certbot --nginx -d "$DOMAIN" --redirect --non-interactive --agree-tos \
    || echo "certbot wants input — run:  certbot --nginx -d $DOMAIN --redirect"
fi

if ! systemctl is-enabled --quiet pm2-root 2>/dev/null; then
  log "Note: pm2 does not start at boot on this VPS (no pm2-root service). 'pm2 startup' would enable it for every pm2 app, including the other one — your call."
fi

if [[ $INSTANCE == staging ]]; then
  log "Done. Next: fill in the R2, email and seed values in $ENV_FILE, then:  git checkout staging && bash $APP_DIR/deploy/deploy.sh --seed"
else
  log "Done. Next: fill in the production R2, email and backup values in $ENV_FILE, then:  bash $APP_DIR/deploy/deploy.sh"
fi
