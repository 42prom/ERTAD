-- 0085: Member directory verification/authorization visibility, filtering & summary counters.
-- Preserves strict org-scoped member_unit_visible checks and zero PII leakage.

CREATE OR REPLACE FUNCTION ertad.member_summary(
  actor uuid,
  org uuid,
  member uuid,
  target uuid
) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'id', member,
    'displayName', (
      SELECT display_name
      FROM ertad.organization_member_labels
      WHERE organization_id = org AND member_id = member
    ),
    'memberships', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', m.id,
          'unitId', m.unit_id,
          'unitName', u.name,
          'positionId', m.position_id,
          'positionName', p.name,
          'status', ertad.member_membership_state(m),
          'validFrom', m.valid_from,
          'validUntil', m.valid_until
        )
        ORDER BY u.name, p.name, m.id
      )
      FROM ertad.member_memberships(actor, org, member, target) m
      JOIN ertad.units u ON u.organization_id = org AND u.id = m.unit_id
      JOIN ertad.positions p ON p.organization_id = org AND p.id = m.position_id
    ), '[]'::jsonb),
    'points', CASE
      WHEN EXISTS (SELECT 1 FROM ertad.member_points_scopes(actor, org, member, target)) THEN (
        SELECT COALESCE(sum(e.points), 0)::text
        FROM ertad.contribution_entries e
        WHERE e.organization_id = org
          AND e.user_id = member
          AND ertad.review_has_scope(actor, org, e.unit_id, 'contribution.read')
          AND EXISTS (
            SELECT 1
            FROM ertad.member_points_scopes(actor, org, member, target) s
            WHERE s.id = ANY(ertad.unit_path(org, e.unit_id))
          )
      )
      ELSE NULL
    END,
    'verificationStatus', (
      SELECT jsonb_build_object(
        'assuranceLevel', COALESCE(ip.assurance_level, 'unverified'),
        'sodCscaVerified', COALESCE(ip.sod_csca_verified, false),
        'citizenshipCountry', COALESCE(ip.citizenship_country, ''),
        'verifiedAt', ip.verified_at,
        'hasWebAccount', (mu.web_account_id IS NOT NULL),
        'documentCount', (
          SELECT count(*)::integer
          FROM ertad.member_verification_documents d
          WHERE d.member_id = member
        ),
        'activeDeviceCount', (
          SELECT count(*)::integer
          FROM ertad.mobile_device_bindings b
          WHERE b.member_id = member AND b.status = 'active'
        ),
        'linkedGoogleCount', (
          SELECT count(*)::integer
          FROM ertad.member_google_accounts g
          WHERE g.member_id = member
        )
      )
      FROM ertad.member_users mu
      LEFT JOIN ertad.member_identity_proofs ip ON ip.member_id = mu.id
      WHERE mu.id = member
    )
  )
$$;

CREATE OR REPLACE FUNCTION ertad.member_directory_command(
  sid uuid,
  token text,
  op text,
  org uuid,
  input jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid;
  target uuid := (input->>'unitId')::uuid;
  member uuid := (input->>'memberId')::uuid;
  data jsonb;
  page_number integer := COALESCE((input->>'page')::integer, 1);
  term text := trim(COALESCE(input->>'search', ''));
  role_term text := trim(COALESCE(input->>'role', ''));
  state text := COALESCE(input->>'status', 'active');
  ver_filter text := COALESCE(input->>'verification', 'all');
  work_data jsonb;
BEGIN
  actor := ertad.review_identity(sid, token, false);
  IF op NOT IN ('contexts', 'units', 'list', 'detail')
    OR page_number NOT BETWEEN 1 AND 1000
    OR length(term) > 120
    OR length(role_term) > 120
    OR state NOT IN ('all', 'active', 'suspended', 'ended', 'expired', 'scheduled', 'inactive')
    OR ver_filter NOT IN ('all', 'verified', 'unverified')
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid directory query';
  END IF;

  IF op = 'contexts' THEN
    PERFORM 1 FROM ertad.organizations ORDER BY id FOR SHARE;
  ELSE
    PERFORM 1 FROM ertad.organizations WHERE id = org AND status = 'active' FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(752991884322001::bigint);
  PERFORM ertad.review_identity(sid, token, false);

  IF op = 'contexts' THEN
    SELECT COALESCE(
      jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name) ORDER BY o.name, o.id),
      '[]'::jsonb
    )
    INTO data
    FROM ertad.organizations o
    WHERE o.status = 'active'
      AND EXISTS (
        SELECT 1 FROM ertad.units u
        WHERE u.organization_id = o.id
          AND ertad.member_unit_visible(actor, o.id, u.id)
      );
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM ertad.units u
      WHERE u.organization_id = org AND ertad.member_unit_visible(actor, org, u.id)
    ) OR (target IS NOT NULL AND NOT ertad.member_unit_visible(actor, org, target)) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
    END IF;

    IF op = 'units' THEN
      WITH visible AS (
        SELECT u.id, u.name
        FROM ertad.units u
        WHERE u.organization_id = org
          AND ertad.member_unit_visible(actor, org, u.id)
          AND position(lower(term) IN lower(u.name)) > 0
      ),
      paged AS (
        SELECT * FROM visible ORDER BY name, id LIMIT 25 OFFSET (page_number - 1) * 25
      )
      SELECT jsonb_build_object(
        'items', COALESCE((SELECT jsonb_agg(to_jsonb(paged) ORDER BY name, id) FROM paged), '[]'::jsonb),
        'total', (SELECT count(*) FROM visible),
        'page', page_number,
        'pageSize', 25
      ) INTO data;

    ELSIF op = 'list' THEN
      WITH base_visible AS (
        SELECT DISTINCT m.user_id,
          COALESCE(ip.assurance_level = 'biometric_verified', false) AS is_verified
        FROM ertad.member_memberships(actor, org, NULL, target) m
        JOIN ertad.positions p ON p.organization_id = org AND p.id = m.position_id
        LEFT JOIN ertad.organization_member_labels l
          ON l.organization_id = org AND l.member_id = m.user_id
        LEFT JOIN ertad.member_identity_proofs ip
          ON ip.member_id = m.user_id
        WHERE (state = 'all' OR ertad.member_membership_state(m) = state)
          AND position(lower(role_term) IN lower(p.name)) > 0
          AND (
            term = ''
            OR lower(m.user_id::text) = lower(term)
            OR position(lower(term) IN lower(COALESCE(l.display_name, ''))) > 0
          )
      ),
      visible AS (
        SELECT user_id
        FROM base_visible
        WHERE ver_filter = 'all'
          OR (ver_filter = 'verified' AND is_verified)
          OR (ver_filter = 'unverified' AND NOT is_verified)
      ),
      paged AS (
        SELECT v.user_id
        FROM visible v
        LEFT JOIN ertad.organization_member_labels l
          ON l.organization_id = org AND l.member_id = v.user_id
        ORDER BY lower(l.display_name) NULLS LAST, v.user_id
        LIMIT 25 OFFSET (page_number - 1) * 25
      )
      SELECT jsonb_build_object(
        'items', COALESCE((
          SELECT jsonb_agg(
            ertad.member_summary(actor, org, p.user_id, target)
            ORDER BY lower(l.display_name) NULLS LAST, p.user_id
          )
          FROM paged p
          LEFT JOIN ertad.organization_member_labels l
            ON l.organization_id = org AND l.member_id = p.user_id
        ), '[]'::jsonb),
        'total', (SELECT count(*) FROM visible),
        'verifiedTotal', (SELECT count(*) FROM base_visible WHERE is_verified),
        'unverifiedTotal', (SELECT count(*) FROM base_visible WHERE NOT is_verified),
        'page', page_number,
        'pageSize', 25
      ) INTO data;

    ELSE
      IF member IS NULL OR NOT EXISTS (
        SELECT 1 FROM ertad.member_memberships(actor, org, member, target)
      ) THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Member unavailable';
      END IF;
      data := ertad.member_summary(actor, org, member, target);
      WITH visible AS (
        SELECT w.id, w.title, w.unit_id, a.status, a.progress
        FROM ertad.work_assignments a
        JOIN ertad.work_items w ON w.organization_id = a.organization_id AND w.id = a.work_id
        WHERE a.organization_id = org
          AND a.user_id = member
          AND ertad.member_unit_visible(actor, org, w.unit_id)
          AND (target IS NULL OR target = ANY(ertad.unit_path(org, w.unit_id)))
          AND ertad.work_visible(actor, w)
          AND (
            member = actor
            OR ertad.review_has_scope(actor, org, w.unit_id, 'workitem.create')
            OR ertad.review_has_scope(actor, org, w.unit_id, 'workitem.verify')
          )
      ),
      paged AS (
        SELECT * FROM visible ORDER BY title, id LIMIT 25 OFFSET (page_number - 1) * 25
      )
      SELECT jsonb_build_object(
        'items', COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object('id', id, 'title', title, 'status', status, 'progress', progress)
            ORDER BY title, id
          )
          FROM paged
        ), '[]'::jsonb),
        'total', (SELECT count(*) FROM visible),
        'page', page_number,
        'pageSize', 25,
        'verified', (SELECT count(*) FROM visible WHERE status = 'verified')
      ) INTO work_data;

      data := data || jsonb_build_object(
        'work', work_data,
        'pointsScopes', COALESCE((
          SELECT jsonb_agg(to_jsonb(s) ORDER BY s.name, s.id)
          FROM ertad.member_points_scopes(actor, org, member, target) s
        ), '[]'::jsonb),
        'canPropose', (
          member <> actor AND EXISTS (
            SELECT 1 FROM ertad.member_memberships(actor, org, member, target) m
            WHERE ertad.review_has_scope(actor, org, m.unit_id, 'membership.propose')
          )
        )
      );
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'data', data,
    'audit', jsonb_build_object('actorId', actor, 'organizationId', org, 'operation', op)
  );
END $$;

REVOKE ALL ON FUNCTION ertad.member_summary(uuid, uuid, uuid, uuid) FROM PUBLIC, ertad_app;
REVOKE ALL ON FUNCTION ertad.member_directory_command(uuid, text, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.member_directory_command(uuid, text, text, uuid, jsonb) TO ertad_app;
