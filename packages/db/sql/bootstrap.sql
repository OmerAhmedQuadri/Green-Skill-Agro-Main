-- Database-level setup for the two-role model (ADR-0008, DEVELOPMENT §6).
-- Run once per database as a superuser, after the gsa_owner and gsa_app roles
-- exist. Idempotent. Used by the Docker init script, the integration-test
-- database, and production provisioning — one definition for all three.

DO $$ BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO gsa_app', current_database());
END $$;

GRANT USAGE ON SCHEMA public TO gsa_app;

-- Tables created by migrations (as gsa_owner) are readable and writable by the
-- runtime role; ledger and audit migrations then revoke UPDATE/DELETE.
ALTER DEFAULT PRIVILEGES FOR ROLE gsa_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gsa_app;
ALTER DEFAULT PRIVILEGES FOR ROLE gsa_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO gsa_app;

-- pg-boss creates partition tables at runtime, so its schema belongs to the
-- runtime role (the worker starts pg-boss with createSchema: false).
CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION gsa_app;
