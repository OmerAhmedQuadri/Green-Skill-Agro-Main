#!/bin/sh
# Two roles (ADR-0008, DEVELOPMENT §5):
#   gsa_owner — owns the schema, runs migrations (created by the image as POSTGRES_USER)
#   gsa_app   — runtime role; ledger tables later revoke UPDATE/DELETE from it
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE ROLE gsa_app LOGIN PASSWORD '${GSA_APP_PASSWORD}';
  GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO gsa_app;
  GRANT USAGE ON SCHEMA public TO gsa_app;
  ALTER DEFAULT PRIVILEGES FOR ROLE gsa_owner IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gsa_app;
  ALTER DEFAULT PRIVILEGES FOR ROLE gsa_owner IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO gsa_app;
  -- pg-boss keeps its queue tables in its own schema, owned by the runtime role.
  CREATE SCHEMA pgboss AUTHORIZATION gsa_app;
EOSQL
