#!/usr/bin/env bash
# Docker Compose for this copy's database (ADR-0058) — the right container,
# whichever folder it is run from. As root on the VPS:
#
#   bash deploy/db.sh ps
#   bash deploy/db.sh exec -T postgres psql -U gsa_owner -d gsa
set -euo pipefail
cd "$(dirname "$0")/.."
source deploy/lib.sh
exec "${COMPOSE[@]}" "$@"
