#!/usr/bin/env bash
# Nightly database backup (ADR-0020, docs/handover/RUNBOOK.md §5). Run as root
# on the VPS — this is the command cron calls:
#
#   bash /root/gsa-sales-inventory-app/Green-Skill-Agro-Main/deploy/backup.sh
#   bash .../deploy/backup.sh --dry-run     # prove it works, write nothing
#
# Dumps the database out of its container, uploads it to the backups bucket,
# deletes the ones past retention, and removes the local copy on the way out —
# a dump is every customer, price and balance in the business, and it should
# not sit on the disk afterwards.
set -euo pipefail
cd "$(dirname "$0")/.."
# This app's own pnpm, as everywhere else on the VPS — never a system-wide one.
export PATH=$PWD/.tools/node_modules/.bin:$PATH

COMPOSE=(docker compose --env-file .env -f deploy/docker-compose.staging.yml)

dump=$(mktemp -t gsa-backup.XXXXXXXX)
chmod 600 "$dump"
trap 'rm -f "$dump"' EXIT   # including on failure: never leave one behind

# -Fc is PostgreSQL's compressed custom format — the one pg_restore reads.
# The owner role, because it is the only one that can read every table.
"${COMPOSE[@]}" exec -T postgres pg_dump -U gsa_owner -d gsa -Fc > "$dump"
[ -s "$dump" ] || { echo "Stopped: the dump is empty. Nothing was uploaded." >&2; exit 1; }

pnpm db:backup --file "$dump" "$@"
