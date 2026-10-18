#!/usr/bin/env bash
# Build this copy's branch and (re)start it (ADR-0035, ADR-0058). Run as root,
# from the copy's own folder:
#
#   bash /root/gsa-sales-inventory-app/staging/Green-Skill-Agro-Main/deploy/deploy.sh [--seed]
#   bash /root/gsa-sales-inventory-app/production/Green-Skill-Agro-Main/deploy/deploy.sh
#
# Staging deploys the `staging` branch, production `main`. --seed loads the
# sample catalogue and the development accounts — staging only; their
# password is DEV_SEED_PASSWORD from .env.
set -euo pipefail
cd "$(dirname "$0")/.."
# This app's own pnpm, in .tools — never a system-wide one another app may rely on.
bash deploy/pnpm.sh --version >/dev/null
export PATH=$PWD/.tools/node_modules/.bin:$PATH
source deploy/lib.sh

[[ ${1:-} != --seed || $INSTANCE == staging ]] || { echo "Sample data and development accounts are for staging only."; exit 1; }
checked_out=$(git rev-parse --abbrev-ref HEAD)
pull=true
if [[ $checked_out == HEAD ]]; then
  # Rolling back (RUNBOOK §2): an earlier commit of this copy's own branch, checked out by hand.
  git fetch -q origin "$BRANCH"
  git merge-base --is-ancestor HEAD "origin/$BRANCH" || { echo "This is $INSTANCE: $(git rev-parse --short HEAD) is not on $BRANCH."; exit 1; }
  pull=false
elif [[ $checked_out != "$BRANCH" ]]; then
  echo "This is $INSTANCE: it deploys $BRANCH, but $checked_out is checked out. Run: git checkout $BRANCH"; exit 1
fi

log() { printf '\n== %s\n' "$*"; }
for key in S3_ACCESS_KEY S3_SECRET_KEY SMTP_URL; do
  grep -Eq "^$key=.+" .env || { echo "Fill in $key in .env first."; exit 1; }
done

if $pull; then log "Code"; git pull --ff-only
else log "Code — staying on $(git rev-parse --short HEAD), a rollback; git checkout $BRANCH to return"; fi
log "Dependencies";  pnpm install --frozen-lockfile
# ADR-0019, ADR-0037: the worker prints delivery documents in Chromium — the
# version this playwright-core expects, with its system libraries (quick when
# already installed). Browsers go under /root/.cache/ms-playwright.
log "Chromium";      DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l \
                       pnpm --filter @gsa/worker exec playwright-core install --with-deps chromium
log "Build";         pnpm build
log "Database";      "${COMPOSE[@]}" up -d --wait
                     pnpm db:migrate && pnpm db:sync
if [[ ${1:-} == --seed ]]; then
  log "Sample data and development accounts"; pnpm db:seed
fi
# ADR-0058: before the split the one copy ran as gsa-web and gsa-worker, on staging's port. They go
# just before the new names start, so the switch costs a restart, not a build. A no-op afterwards.
pm2 delete gsa-web gsa-worker >/dev/null 2>&1 || true
log "Restart";       pm2 startOrReload deploy/ecosystem.config.cjs --update-env && pm2 save

log "Health of $INSTANCE"
for _ in $(seq 1 30); do
  if curl -fs "http://127.0.0.1:$APP_PORT/api/v1/health"; then echo; exit 0; fi   # quiet while it starts
  sleep 2
done
echo "The app did not become healthy — see:  pm2 logs $WEB"
exit 1
