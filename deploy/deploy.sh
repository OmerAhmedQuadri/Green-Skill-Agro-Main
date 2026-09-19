#!/usr/bin/env bash
# Build the checked-out branch and (re)start the app (ADR-0035). Run as root:
#
#   bash /root/green-agro-app/deploy/deploy.sh [--seed]
#
# --seed loads the sample catalogue and the development accounts — staging
# only; their password is DEV_SEED_PASSWORD from .env.
set -euo pipefail
cd "$(dirname "$0")/.."
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

log() { printf '\n== %s\n' "$*"; }
for key in S3_ACCESS_KEY S3_SECRET_KEY SMTP_URL; do
  grep -Eq "^$key=.+" .env || { echo "Fill in $key in .env first."; exit 1; }
done

log "Code";          git pull --ff-only
log "Dependencies";  pnpm install --frozen-lockfile
log "Build";         pnpm build
log "Database";      docker compose --env-file .env -f deploy/docker-compose.staging.yml up -d --wait
                     pnpm db:migrate && pnpm db:sync
if [[ ${1:-} == --seed ]]; then
  log "Sample data and development accounts"; pnpm db:seed
fi
log "Restart";       pm2 startOrReload deploy/ecosystem.config.cjs --update-env && pm2 save

log "Health"
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3000/api/v1/health; then echo; exit 0; fi
  sleep 2
done
echo "The app did not become healthy — see:  pm2 logs gsa-web"
exit 1
