#!/usr/bin/env bash
# Fetch a backup from the backups bucket onto this server, to restore from
# (ADR-0050, docs/handover/RUNBOOK.md §5.4). Run as root on the VPS:
#
#   bash /root/gsa-sales-inventory-app/Green-Skill-Agro-Main/deploy/fetch-backup.sh
#   bash .../deploy/fetch-backup.sh --key gsa-20261006T020000Z.dump    # a named one, not the newest
#
# It writes ~/gsa-<stamp>.dump, readable by root alone, and never overwrites a
# file. That file is every customer, price and balance in the business: delete
# it once the restore is done.
set -euo pipefail
cd "$(dirname "$0")/.."
# This app's own pnpm, as everywhere else on the VPS — never a system-wide one.
export PATH=$PWD/.tools/node_modules/.bin:$PATH

pnpm db:fetch-backup "$@"
