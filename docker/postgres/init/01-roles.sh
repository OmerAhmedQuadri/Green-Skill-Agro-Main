#!/bin/sh
# Two roles (ADR-0008, DEVELOPMENT §6):
#   gsa_owner — owns the schema, runs migrations (created by the image as POSTGRES_USER)
#   gsa_app   — runtime role; ledger and audit tables revoke UPDATE/DELETE from it
# Database-level grants come from the shared packages/db/sql/bootstrap.sql.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -c "CREATE ROLE gsa_app LOGIN PASSWORD '${GSA_APP_PASSWORD}';"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f /bootstrap/bootstrap.sql
