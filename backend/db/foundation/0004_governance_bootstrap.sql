-- Installation-level ceremony, not tenant data or an automatically armed mode.
-- No row, account, permission or organization is seeded by this migration.
ALTER TABLE ertad.permission_grants DROP CONSTRAINT permission_grants_permission_check;
ALTER TABLE ertad.permission_grants ADD CONSTRAINT permission_grants_permission_check
  CHECK (permission IN ('unit.read', 'workitem.create', 'workitem.verify', 'membership.propose', 'membership.approve'));

CREATE TABLE ertad.governance_bootstrap (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  id uuid NOT NULL UNIQUE,
  proposer_account_id uuid NOT NULL REFERENCES ertad.admin_users(id),
  confirmer_account_id uuid NOT NULL REFERENCES ertad.admin_users(id),
  organization_name text NOT NULL CHECK (length(trim(organization_name)) BETWEEN 1 AND 160),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 10 AND 1000),
  status text NOT NULL DEFAULT 'armed' CHECK (status IN ('armed', 'pending', 'completed', 'rejected')),
  armed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  -- Historical IDs, deliberately not FKs: normal expired-session cleanup must work.
  -- The installer checks and locks the live session on every endorsement.
  proposer_session_id uuid,
  confirmer_session_id uuid,
  organization_id uuid REFERENCES ertad.organizations(id),
  CHECK (proposer_account_id <> confirmer_account_id),
  CHECK (isfinite(armed_at) AND isfinite(expires_at) AND expires_at > armed_at AND expires_at <= armed_at + interval '15 minutes'),
  CHECK ((status = 'armed' AND proposer_session_id IS NULL AND confirmer_session_id IS NULL AND organization_id IS NULL)
      OR (status = 'pending' AND proposer_session_id IS NOT NULL AND confirmer_session_id IS NULL AND organization_id IS NULL)
      OR (status = 'completed' AND proposer_session_id IS NOT NULL AND confirmer_session_id IS NOT NULL AND organization_id IS NOT NULL)
      OR (status = 'rejected' AND proposer_session_id IS NOT NULL AND confirmer_session_id IS NOT NULL AND organization_id IS NULL))
);
CREATE TABLE ertad.governance_bootstrap_events (
  id bigserial PRIMARY KEY,
  bootstrap_id uuid NOT NULL REFERENCES ertad.governance_bootstrap(id),
  action text NOT NULL CHECK (action IN ('armed', 'proposed', 'confirmed', 'rejected')),
  actor_account_id uuid REFERENCES ertad.admin_users(id),
  recipient_account_id uuid REFERENCES ertad.admin_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (bootstrap_id, action),
  CHECK ((action = 'armed' AND actor_account_id IS NULL AND recipient_account_id IS NULL)
    OR (action <> 'armed' AND actor_account_id IS NOT NULL AND recipient_account_id IS NOT NULL
        AND actor_account_id <> recipient_account_id))
);
CREATE FUNCTION ertad.guard_bootstrap_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Bootstrap cannot be erased'; END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'proposer_session_id', 'confirmer_session_id', 'organization_id'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'proposer_session_id', 'confirmer_session_id', 'organization_id'])
    OR NOT ((OLD.status = 'armed' AND NEW.status = 'pending')
      OR (OLD.status = 'pending' AND NEW.status IN ('completed', 'rejected')))
    OR (OLD.proposer_session_id IS NOT NULL AND OLD.proposer_session_id IS DISTINCT FROM NEW.proposer_session_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Invalid bootstrap transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bootstrap_transition BEFORE UPDATE OR DELETE ON ertad.governance_bootstrap
  FOR EACH ROW EXECUTE FUNCTION ertad.guard_bootstrap_transition();
CREATE TRIGGER bootstrap_no_truncate BEFORE TRUNCATE ON ertad.governance_bootstrap
  FOR EACH STATEMENT EXECUTE FUNCTION ertad.guard_bootstrap_transition();
CREATE TRIGGER bootstrap_events_no_update_or_delete BEFORE UPDATE OR DELETE ON ertad.governance_bootstrap_events
  FOR EACH ROW EXECUTE FUNCTION ertad.prevent_audit_log_mutation();
CREATE TRIGGER bootstrap_events_no_truncate BEFORE TRUNCATE ON ertad.governance_bootstrap_events
  FOR EACH STATEMENT EXECUTE FUNCTION ertad.prevent_audit_log_mutation();
REVOKE ALL ON FUNCTION ertad.guard_bootstrap_transition() FROM PUBLIC;
-- Bootstrap is an offline installer operation. The API gets no table or function grants.
