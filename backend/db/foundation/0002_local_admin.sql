-- Adapted from ERTAD's administrator/session/audit schema, isolated from member data.
-- Local development access only; the application still refuses production startup.
CREATE TABLE ertad.admin_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email varchar(255) NOT NULL UNIQUE CHECK (email = lower(trim(email))),
  password_hash varchar(255) NOT NULL,
  role text NOT NULL CHECK (role IN ('superadmin', 'admin', 'moderator', 'observer')),
  full_name varchar(100),
  is_active boolean NOT NULL DEFAULT true,
  failed_login_attempts integer NOT NULL DEFAULT 0 CHECK (failed_login_attempts BETWEEN 0 AND 1000),
  locked_until timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  mfa_secret_encrypted text NOT NULL CHECK (mfa_secret_encrypted LIKE 'v2:%'),
  mfa_enabled boolean NOT NULL DEFAULT true CHECK (mfa_enabled),
  mfa_enrolled_at timestamptz NOT NULL DEFAULT now(),
  mfa_last_counter bigint NOT NULL DEFAULT -1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX admin_users_canonical_email ON ertad.admin_users (lower(email));

CREATE TABLE ertad.admin_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid NOT NULL REFERENCES ertad.admin_users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  csrf_token_hash char(64) NOT NULL CHECK (csrf_token_hash ~ '^[0-9a-f]{64}$'),
  csrf_token_encrypted text NOT NULL CHECK (csrf_token_encrypted LIKE 'v2:%'),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  step_up_expires_at timestamptz,
  ip_address inet,
  user_agent varchar(512),
  CHECK (idle_expires_at <= absolute_expires_at),
  CHECK (step_up_expires_at IS NULL OR step_up_expires_at <= absolute_expires_at)
);
CREATE INDEX admin_sessions_user_active ON ertad.admin_sessions (admin_user_id, created_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX admin_sessions_cleanup ON ertad.admin_sessions (absolute_expires_at, revoked_at);

CREATE TABLE ertad.audit_log (
  id bigserial PRIMARY KEY,
  event_type text NOT NULL CHECK (length(event_type) <= 80),
  payload text NOT NULL CHECK (jsonb_typeof(payload::jsonb) = 'object' AND length(payload) <= 4096),
  previous_hash char(64) NOT NULL CHECK (previous_hash ~ '^[0-9a-f]{64}$'),
  row_hash char(64) NOT NULL CHECK (row_hash ~ '^[0-9a-f]{64}$'),
  created_at text NOT NULL
);
CREATE FUNCTION ertad.prevent_audit_log_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END;
$$;
CREATE TRIGGER audit_log_no_update_or_delete BEFORE UPDATE OR DELETE ON ertad.audit_log
  FOR EACH ROW EXECUTE FUNCTION ertad.prevent_audit_log_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON ertad.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION ertad.prevent_audit_log_mutation();

GRANT SELECT ON ertad.admin_users TO ertad_app;
GRANT UPDATE (failed_login_attempts, locked_until, last_login_at, mfa_enabled, mfa_enrolled_at, mfa_last_counter, updated_at)
  ON ertad.admin_users TO ertad_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ertad.admin_sessions TO ertad_app;
GRANT SELECT, INSERT ON ertad.audit_log TO ertad_app;
GRANT USAGE, SELECT ON SEQUENCE ertad.audit_log_id_seq TO ertad_app;
