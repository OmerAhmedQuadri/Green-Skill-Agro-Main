-- ADR-0008 / AUD-004: the audit log is append-only for the runtime role.
-- Corrections are new records, never edits. Migrations run as gsa_owner.
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_log" FROM gsa_app;
