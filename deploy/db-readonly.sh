#!/usr/bin/env bash
# A read-only database login for inspecting staging through an SSH tunnel the
# project lead opens (ADR-0035). Run as root on the VPS, from the app folder:
#
#   bash deploy/db-readonly.sh
#
# Creates the role — or gives it a new password if it exists — and prints the
# ~/.pgpass line for the laptop that tunnels to local port 5433. The role
# reads every table and can change nothing.
set -euo pipefail
cd "$(dirname "$0")/.."
pw=$(openssl rand -hex 24)
# The SQL goes in on stdin, so the password never appears in a process list.
docker compose --env-file .env -f deploy/docker-compose.staging.yml exec -T postgres \
  psql -U gsa_owner -d gsa -q -v ON_ERROR_STOP=1 <<SQL
\\set pw '$pw'
SELECT 'CREATE ROLE gsa_readonly LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gsa_readonly') \\gexec
ALTER ROLE gsa_readonly PASSWORD :'pw';
ALTER ROLE gsa_readonly SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE gsa TO gsa_readonly;
GRANT USAGE ON SCHEMA public, drizzle, pgboss TO gsa_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public, drizzle, pgboss TO gsa_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE gsa_owner IN SCHEMA public GRANT SELECT ON TABLES TO gsa_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE gsa_app IN SCHEMA pgboss GRANT SELECT ON TABLES TO gsa_readonly;
SQL
echo
echo "Copy this line into ~/.pgpass on the laptop (then chmod 600 ~/.pgpass) — never into chat:"
echo "127.0.0.1:5433:gsa:gsa_readonly:$pw"
