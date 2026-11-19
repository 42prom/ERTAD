-- Member privacy disclosure preference (private_hidden default, bucketed_k10, shared_context_opt_in)
-- synchronized with organization_member_labels for mobile/web profile disclosure UI.

CREATE TABLE ertad.member_privacy_settings (
  organization_id uuid NOT NULL REFERENCES ertad.organizations(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES ertad.member_users(id) ON DELETE CASCADE,
  disclosure_mode text NOT NULL DEFAULT 'private_hidden'
    CHECK (disclosure_mode IN ('private_hidden', 'bucketed_k10', 'shared_context_opt_in')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, member_id)
);

REVOKE ALL ON ertad.member_privacy_settings FROM PUBLIC, ertad_app;

CREATE FUNCTION ertad.member_privacy_command(
  sid uuid,
  token text,
  op text,
  org uuid,
  input jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid;
  mode_val text;
  label_val text;
  saved_mode text;
  saved_label text;
BEGIN
  IF op IS NULL OR op NOT IN ('get', 'set') OR org IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid privacy command';
  END IF;

  actor := ertad.review_identity(sid, token, false);
  PERFORM 1 FROM ertad.organizations WHERE id = org AND status = 'active' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
  END IF;

  PERFORM pg_advisory_xact_lock(752991884322001::bigint);
  actor := ertad.review_identity(sid, token, false);

  IF NOT EXISTS (
    SELECT 1
    FROM ertad.memberships m
    WHERE m.organization_id = org
      AND m.user_id = actor
      AND ertad.member_membership_state(m) = 'active'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
  END IF;

  IF op = 'set' THEN
    mode_val := input->>'disclosureMode';
    IF mode_val IS NULL OR mode_val NOT IN ('private_hidden', 'bucketed_k10', 'shared_context_opt_in') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid disclosure mode';
    END IF;

    INSERT INTO ertad.member_privacy_settings (organization_id, member_id, disclosure_mode, updated_at)
    VALUES (org, actor, mode_val, clock_timestamp())
    ON CONFLICT (organization_id, member_id) DO UPDATE
      SET disclosure_mode = EXCLUDED.disclosure_mode,
          updated_at = EXCLUDED.updated_at;

    IF mode_val = 'shared_context_opt_in' THEN
      label_val := NULLIF(trim(COALESCE(input->>'displayName', '')), '');
      IF label_val IS NOT NULL THEN
        IF length(label_val) > 120 THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Display name too long';
        END IF;
        INSERT INTO ertad.organization_member_labels (organization_id, member_id, display_name)
        VALUES (org, actor, label_val)
        ON CONFLICT (organization_id, member_id) DO UPDATE
          SET display_name = EXCLUDED.display_name;
      END IF;
    ELSIF mode_val = 'private_hidden' THEN
      DELETE FROM ertad.organization_member_labels
      WHERE organization_id = org AND member_id = actor;
    END IF;
  END IF;

  SELECT s.disclosure_mode INTO saved_mode
  FROM ertad.member_privacy_settings s
  WHERE s.organization_id = org AND s.member_id = actor;

  SELECT l.display_name INTO saved_label
  FROM ertad.organization_member_labels l
  WHERE l.organization_id = org AND l.member_id = actor;

  RETURN jsonb_build_object(
    'data', jsonb_build_object(
      'organizationId', org,
      'memberId', actor,
      'disclosureMode', COALESCE(saved_mode, 'private_hidden'),
      'displayName', saved_label
    ),
    'audit', jsonb_build_object(
      'actorMemberId', actor,
      'organizationId', org,
      'operation', op,
      'disclosureMode', COALESCE(saved_mode, 'private_hidden')
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION ertad.member_privacy_command(uuid, text, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.member_privacy_command(uuid, text, text, uuid, jsonb) TO ertad_app;

-- Least-privilege predicate for runtime session guards without direct platform_accounts table grants.
CREATE FUNCTION ertad.is_platform_account(target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM ertad.platform_accounts WHERE admin_user_id = target)
$$;

REVOKE ALL ON FUNCTION ertad.is_platform_account(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.is_platform_account(uuid) TO ertad_app;

