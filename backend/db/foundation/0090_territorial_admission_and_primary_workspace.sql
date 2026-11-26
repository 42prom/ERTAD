-- Territorial Groups Stage T3: Governed Member Admission & Primary Local Membership
-- Preserves existing review, lifecycle, unit, and workspace boundaries while adding:
-- 1) Opt-in bounded group admission publication (least-privilege position only)
-- 2) Member self-initiated 'admission' requests requiring independent reviewer approval
-- 3) Unique-per-(org, member) primary local group designation with automatic clearing on deactivation
-- 4) Workspace bootstrap group context projection

ALTER TABLE ertad.units
  ADD COLUMN admission_open boolean NOT NULL DEFAULT false,
  ADD COLUMN admission_position_id uuid;

ALTER TABLE ertad.units
  ADD CONSTRAINT units_admission_position_fk
  FOREIGN KEY (organization_id, id, admission_position_id)
  REFERENCES ertad.positions (organization_id, unit_id, id);

ALTER TABLE ertad.units
  ADD CONSTRAINT units_admission_open_chk CHECK (
    (NOT admission_open)
    OR (operational_type = 'group' AND status = 'active' AND admission_position_id IS NOT NULL)
  );

-- Only active positions with approved bundles and strictly ordinary-member permissions
-- can be published for self-initiated territorial group admission.
CREATE FUNCTION ertad.position_is_admission_eligible(org uuid, target_unit uuid, pos_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM ertad.positions p
    JOIN ertad.permission_bundles b
      ON (b.organization_id, b.id, b.version) = (p.organization_id, p.bundle_id, p.bundle_version)
    WHERE p.organization_id = org
      AND p.unit_id = target_unit
      AND p.id = pos_id
      AND p.status = 'active'
      AND b.status = 'approved'
      AND NOT EXISTS (
        SELECT 1
        FROM ertad.permission_grants g
        WHERE g.organization_id = org
          AND g.bundle_id = p.bundle_id
          AND g.bundle_version = p.bundle_version
          AND g.permission NOT IN (
            'unit.read',
            'workitem.read',
            'workitem.participate',
            'decision.read',
            'decision.vote',
            'contribution.read',
            'channel.read',
            'channel.post'
          )
      )
  );
$$;

-- Extend membership_reviews CHECK constraints cleanly to allow kind = 'admission'
-- where requester_id = target_id while preserving all independent-decision invariants.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conrelid = 'ertad.membership_reviews'::regclass
      AND contype = 'c'
      AND (
        conname = 'membership_reviews_kind_check'
        OR (pg_get_constraintdef(oid) LIKE '%requester_id <> target_id%' AND pg_get_constraintdef(oid) NOT LIKE '%decision_by%')
        OR pg_get_constraintdef(oid) LIKE '%source_id IS NULL%'
        OR pg_get_constraintdef(oid) LIKE '%valid_until%'
      )
  LOOP
    EXECUTE format('ALTER TABLE ertad.membership_reviews DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE ertad.membership_reviews
  ADD CONSTRAINT membership_reviews_kind_check
  CHECK (kind IN ('grant', 'transfer', 'revoke', 'suspend', 'resume', 'revision', 'admission'));

ALTER TABLE ertad.membership_reviews
  ADD CHECK (
    (kind = 'admission' AND requester_id = target_id)
    OR (kind <> 'admission' AND requester_id <> target_id)
  );

ALTER TABLE ertad.membership_reviews
  ADD CHECK (
    (kind IN ('grant', 'admission') AND source_id IS NULL AND source_snapshot IS NULL AND source_path IS NULL AND destination_path IS NULL)
    OR (kind NOT IN ('grant', 'admission') AND source_id IS NOT NULL AND source_snapshot IS NOT NULL AND jsonb_typeof(source_snapshot) = 'object'
      AND source_path IS NOT NULL AND cardinality(source_path) > 0 AND destination_path IS NOT NULL AND cardinality(destination_path) > 0)
  );

ALTER TABLE ertad.membership_reviews
  ADD CHECK (
    (kind IN ('revoke', 'suspend', 'resume', 'revision') AND valid_until IS NULL)
    OR (kind IN ('grant', 'transfer', 'admission') AND valid_until IS NOT NULL AND isfinite(valid_until)
      AND valid_until > expires_at AND valid_until <= created_at + interval '366 days')
  );

CREATE INDEX membership_reviews_admission_lookup
  ON ertad.membership_reviews (organization_id, target_id, unit_id, status, expires_at)
  WHERE kind = 'admission';

CREATE OR REPLACE FUNCTION ertad.membership_change_scope(actor uuid, r ertad.membership_reviews, permission text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT ertad.review_has_scope(actor, r.organization_id, r.unit_id, permission)
    AND (
      r.kind IN ('grant', 'admission')
      OR (
        ertad.review_has_scope(actor, r.organization_id, (r.source_snapshot->>'unit_id')::uuid, permission)
        AND ertad.member_unit_visible(actor, r.organization_id, (r.source_snapshot->>'unit_id')::uuid)
        AND ertad.member_unit_visible(actor, r.organization_id, r.unit_id)
      )
    );
$$;

CREATE OR REPLACE FUNCTION ertad.review_visible(member uuid, r ertad.membership_reviews)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT (r.kind = 'admission' AND r.requester_id = member)
    OR (r.kind <> 'admission' AND r.requester_id = member AND ertad.membership_change_scope(member, r, 'membership.propose'))
    OR (member NOT IN (r.requester_id, r.target_id) AND ertad.membership_change_scope(member, r, 'membership.approve'))
    OR (
      r.target_id = member
      AND r.status <> 'pending'
      AND ertad.review_has_scope(member, r.organization_id, r.unit_id, 'unit.read')
      AND (
        r.kind IN ('grant', 'admission')
        OR ertad.review_has_scope(member, r.organization_id, (r.source_snapshot->>'unit_id')::uuid, 'unit.read')
      )
    );
$$;

CREATE OR REPLACE FUNCTION ertad.position_retirement_blocked(org uuid, source uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
      SELECT 1 FROM ertad.memberships
      WHERE organization_id = org AND position_id = source
        AND status IN ('active', 'suspended')
        AND (valid_until IS NULL OR valid_until > clock_timestamp())
    )
    OR EXISTS (
      SELECT 1 FROM ertad.membership_reviews
      WHERE organization_id = org AND position_id = source
        AND kind IN ('grant', 'transfer', 'revision', 'admission')
        AND status = 'pending' AND expires_at > clock_timestamp()
    )
    OR EXISTS (
      SELECT 1 FROM ertad.collective_proposals
      WHERE organization_id = org AND kind = 'position_revision'
        AND parameters->>'sourceId' = source::text
        AND status = 'pending' AND deadline > clock_timestamp()
    )
    OR EXISTS (
      SELECT 1 FROM ertad.units
      WHERE organization_id = org AND status = 'active'
        AND admission_open AND admission_position_id = source
    );
$$;

-- Primary local group preference per (organization, member).
-- Runtime has no direct DML access; cleared automatically if membership leaves 'active'.
CREATE TABLE ertad.member_primary_groups (
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES ertad.member_users(id),
  membership_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, user_id),
  FOREIGN KEY (organization_id, membership_id) REFERENCES ertad.memberships(organization_id, id)
);

CREATE INDEX member_primary_groups_membership
  ON ertad.member_primary_groups (organization_id, membership_id);

REVOKE ALL ON TABLE ertad.member_primary_groups FROM PUBLIC, ertad_app;

CREATE FUNCTION ertad.clear_inactive_primary_group()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.status <> 'active' OR (NEW.valid_until IS NOT NULL AND NEW.valid_until <= clock_timestamp()) THEN
    DELETE FROM ertad.member_primary_groups
    WHERE organization_id = NEW.organization_id AND membership_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER z_clear_inactive_primary_group
  AFTER UPDATE ON ertad.memberships
  FOR EACH ROW
  EXECUTE FUNCTION ertad.clear_inactive_primary_group();

-- Wrap membership_review_command so independent reviewers decide kind = 'admission' requests
-- without allowing self-approval or non-eligible position grants.
ALTER FUNCTION ertad.membership_review_command(uuid, text, text, uuid, jsonb)
  RENAME TO membership_before_admission_command;

REVOKE ALL ON FUNCTION ertad.membership_before_admission_command(uuid, text, text, uuid, jsonb) FROM PUBLIC, ertad_app;

CREATE FUNCTION ertad.membership_review_command(sid uuid, token text, op text, org uuid, input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  actor uuid;
  r ertad.membership_reviews;
  p ertad.positions;
  u ertad.units;
  decision text;
  key uuid;
  mid uuid;
  changed boolean := false;
BEGIN
  IF op = 'decide' THEN
    actor := ertad.review_identity(sid, token, true);
    PERFORM 1 FROM ertad.organizations WHERE id = org AND status = 'active' FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
    END IF;
    PERFORM pg_advisory_xact_lock(752991884322001::bigint);
    PERFORM ertad.review_identity(sid, token, true);
    SELECT * INTO r FROM ertad.membership_reviews WHERE organization_id = org AND id = (input->>'id')::uuid FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
    END IF;
    IF r.kind = 'admission' THEN
      IF actor IN (r.requester_id, r.target_id)
        OR NOT ertad.review_has_scope(actor, org, r.unit_id, 'membership.approve') THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
      END IF;
      decision := input->>'decision';
      key := (input->>'key')::uuid;
      IF decision NOT IN ('approved', 'rejected') THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid decision';
      END IF;
      IF r.status <> 'pending' THEN
        IF (r.status, r.decision_by, r.decision_key, r.decision_reason)
          IS DISTINCT FROM (decision, actor, key, input->>'reason') THEN
          RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Request conflict';
        END IF;
      ELSE
        PERFORM 1 FROM ertad.member_users WHERE id = r.target_id FOR SHARE;
        IF r.expires_at <= clock_timestamp() OR r.valid_until <= clock_timestamp() THEN
          RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Request conflict';
        END IF;
        IF decision = 'approved' THEN
          SELECT * INTO u FROM ertad.units WHERE organization_id = org AND id = r.unit_id;
          SELECT * INTO p FROM ertad.positions WHERE organization_id = org AND id = r.position_id;
          IF u.id IS NULL OR u.status <> 'active' OR u.kind <> 'authority' OR u.operational_type <> 'group'
            OR NOT u.admission_open OR u.admission_position_id IS DISTINCT FROM r.position_id
            OR p.id IS NULL OR p.status <> 'active'
            OR (p.unit_id, p.bundle_id, p.bundle_version) IS DISTINCT FROM (r.unit_id, r.bundle_id, r.bundle_version)
            OR NOT ertad.position_is_admission_eligible(org, r.unit_id, r.position_id)
            OR NOT EXISTS (SELECT 1 FROM ertad.member_users WHERE id = r.target_id AND status = 'active')
            OR EXISTS (
              SELECT 1 FROM ertad.memberships m
              WHERE m.organization_id = org
                AND m.user_id = r.target_id
                AND m.unit_id = r.unit_id
                AND m.status IN ('active', 'suspended')
                AND (m.valid_until IS NULL OR m.valid_until > clock_timestamp())
            ) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Request conflict';
          END IF;
          INSERT INTO ertad.memberships (
            organization_id, user_id, unit_id, position_id, bundle_version, valid_from, valid_until
          )
          VALUES (
            org, r.target_id, r.unit_id, r.position_id, r.bundle_version, clock_timestamp(), r.valid_until
          )
          RETURNING id INTO mid;
        END IF;
        UPDATE ertad.membership_reviews
        SET status = decision,
            decision_by = actor,
            decision_reason = input->>'reason',
            decision_at = clock_timestamp(),
            decision_key = key,
            membership_id = mid
        WHERE organization_id = org AND id = r.id
        RETURNING * INTO r;
        INSERT INTO ertad.review_notifications (organization_id, review_id, recipient_id)
        VALUES (org, r.id, r.target_id)
        ON CONFLICT DO NOTHING;
        changed := true;
      END IF;
      RETURN jsonb_build_object(
        'data', jsonb_build_object('id', r.id, 'status', r.status),
        'audit', jsonb_build_object('actorId', actor, 'organizationId', org, 'operation', op, 'reviewId', r.id, 'changed', changed)
      );
    END IF;
  END IF;
  RETURN ertad.membership_before_admission_command(sid, token, op, org, input);
END;
$$;

REVOKE ALL ON FUNCTION ertad.membership_review_command(uuid, text, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.membership_review_command(uuid, text, text, uuid, jsonb) TO ertad_app;

-- Wrap review_finish so post-audit recheck covers kind = 'admission' cleanly.
ALTER FUNCTION ertad.review_finish(uuid, text, uuid, uuid)
  RENAME TO review_before_admission_finish;

REVOKE ALL ON FUNCTION ertad.review_before_admission_finish(uuid, text, uuid, uuid) FROM PUBLIC, ertad_app;

CREATE FUNCTION ertad.review_finish(sid uuid, token text, org uuid, rid uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid;
  r ertad.membership_reviews;
BEGIN
  actor := ertad.review_identity(sid, token, true);
  SELECT * INTO r FROM ertad.membership_reviews WHERE organization_id = org AND id = rid;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
  END IF;
  IF r.kind = 'admission' THEN
    IF r.expires_at <= clock_timestamp()
      OR r.valid_until <= clock_timestamp()
      OR r.status = 'pending'
      OR r.decision_by IS DISTINCT FROM actor
      OR actor IN (r.requester_id, r.target_id)
      OR NOT ertad.review_has_scope(actor, org, r.unit_id, 'membership.approve') THEN
      RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Request conflict';
    END IF;
    IF r.status = 'approved' AND NOT EXISTS (
      SELECT 1 FROM ertad.memberships m
      WHERE m.organization_id = org
        AND m.id = r.membership_id
        AND m.user_id = r.target_id
        AND m.unit_id = r.unit_id
        AND m.position_id = r.position_id
        AND m.status = 'active'
        AND m.valid_from <= clock_timestamp()
        AND (m.valid_until IS NULL OR m.valid_until > clock_timestamp())
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Request conflict';
    END IF;
    RETURN;
  END IF;
  PERFORM ertad.review_before_admission_finish(sid, token, org, rid);
END;
$$;

REVOKE ALL ON FUNCTION ertad.review_finish(uuid, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.review_finish(uuid, text, uuid, uuid) TO ertad_app;

-- Update unit_command: project admission settings + canConfigureAdmission, and clear admission_open on archival.
CREATE OR REPLACE FUNCTION ertad.unit_command(sid uuid, token text, op text, org uuid, input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  actor uuid;
  r ertad.unit_reviews;
  result jsonb;
  changed boolean := false;
  target ertad.units;
  change_kind text;
  propose_permission text;
  approve_permission text;
  parent uuid;
  expiry timestamptz;
  page integer;
  view_name text;
  new_unit uuid;
  new_channel uuid;
  main_title text;
  area text;
  unit_type text;
BEGIN
  IF op NOT IN ('contexts', 'units', 'list', 'detail', 'propose', 'change', 'decide', 'geography') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid operation';
  END IF;
  actor := ertad.review_identity(sid, token, op IN ('propose', 'change', 'decide'));
  IF op = 'contexts' THEN
    PERFORM 1 FROM ertad.organizations o WHERE EXISTS (SELECT 1 FROM ertad.memberships m WHERE m.organization_id = o.id AND m.user_id = actor) ORDER BY o.id FOR SHARE;
  ELSIF op IN ('propose', 'change', 'decide') THEN
    PERFORM 1 FROM ertad.organizations WHERE id = org AND status = 'active' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied'; END IF;
  ELSE
    PERFORM 1 FROM ertad.organizations WHERE id = org AND status = 'active' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied'; END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(752991884322001::bigint);
  PERFORM ertad.review_identity(sid, token, op IN ('propose', 'change', 'decide'));
  IF op = 'contexts' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name) ORDER BY o.name, o.id), '[]') INTO result
      FROM ertad.organizations o WHERE o.status = 'active' AND EXISTS (SELECT 1 FROM ertad.units u
        WHERE u.organization_id = o.id AND ertad.review_has_scope(actor, o.id, u.id, 'unit.read'));
  ELSIF op = 'geography' THEN
    IF NOT EXISTS (SELECT 1 FROM ertad.units u WHERE u.organization_id = org AND ertad.review_has_scope(actor, org, u.id, 'unit.read')) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
    END IF;
    SELECT jsonb_build_object('version', '2026-11-26.1', 'coverage', 'operational_baseline',
      'additionalReferencesPending', true, 'items', COALESCE(jsonb_agg(jsonb_build_object(
        'id', a.id, 'parentId', a.parent_id, 'kind', a.kind, 'nameKa', a.name_ka, 'nameEn', a.name_en) ORDER BY a.name_ka, a.id), '[]'))
    INTO result FROM (SELECT * FROM ertad.geographic_areas WHERE active ORDER BY id LIMIT 500) a;
  ELSIF op = 'units' THEN
    IF COALESCE(input->>'status', 'active') NOT IN ('active', 'archived') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid status';
    END IF;
    page := COALESCE((input->>'page')::integer, 1);
    IF page NOT BETWEEN 1 AND 1000 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid page';
    END IF;
    WITH visible AS (
      SELECT u.id, u.name, u.kind, u.status, u.version, u.operational_type, u.geographic_area_id,
        u.admission_open, u.admission_position_id,
        CASE WHEN u.admission_position_id IS NOT NULL THEN (
          SELECT p.name FROM ertad.positions p WHERE p.organization_id = org AND p.id = u.admission_position_id
        ) ELSE NULL END AS admission_position_name,
        u.status = 'active' AND u.kind = 'authority' AND u.operational_type = 'group'
          AND ertad.review_has_scope(actor, org, u.id, 'unit.read')
          AND ertad.review_has_scope(actor, org, u.id, 'membership.approve') AS "canConfigureAdmission",
        CASE WHEN u.parent_id IS NULL THEN jsonb_build_array('unclassified', 'region')
          WHEN u.operational_type = 'region' THEN jsonb_build_array('locality')
          WHEN u.operational_type = 'locality' THEN jsonb_build_array('group')
          WHEN u.operational_type = 'group' THEN jsonb_build_array('team')
          WHEN u.operational_type = 'team' THEN '[]'::jsonb
          ELSE jsonb_build_array('unclassified') END AS child_types,
        CASE WHEN u.operational_type <> 'unclassified' OR u.parent_id IS NULL
          OR NOT ertad.review_has_scope(actor, org, u.parent_id, 'unit.read') THEN '[]'::jsonb
          WHEN EXISTS (SELECT 1 FROM ertad.units p WHERE p.organization_id = org AND p.id = u.parent_id AND p.parent_id IS NULL) THEN jsonb_build_array('region')
          ELSE COALESCE((SELECT CASE p.operational_type WHEN 'region' THEN jsonb_build_array('locality')
            WHEN 'locality' THEN jsonb_build_array('group') WHEN 'group' THEN jsonb_build_array('team') ELSE '[]'::jsonb END
            FROM ertad.units p WHERE p.organization_id = org AND p.id = u.parent_id), '[]'::jsonb) END AS classify_types,
        CASE WHEN ertad.review_has_scope(actor, org, u.parent_id, 'unit.read') THEN
          (SELECT p.geographic_area_id FROM ertad.units p WHERE p.organization_id = org AND p.id = u.parent_id)
          ELSE NULL END AS parent_geographic_area_id,
        (SELECT jsonb_build_object('id', g.id, 'nameKa', g.name_ka, 'nameEn', g.name_en) FROM ertad.geographic_areas g WHERE g.id = u.geographic_area_id) AS geography,
        CASE WHEN ertad.review_has_scope(actor, org, u.id, 'channel.read') THEN
          (SELECT c.id FROM ertad.channels c WHERE c.organization_id = org AND c.unit_id = u.id AND c.is_main AND NOT c.archived LIMIT 1)
          ELSE NULL END AS main_channel_id,
        u.status = 'active' AND u.kind = 'authority' AND u.parent_id IS NOT NULL AND u.operational_type = 'unclassified'
          AND ertad.review_has_scope(actor, org, u.parent_id, 'unit.read')
          AND ertad.review_has_scope(actor, org, u.parent_id, 'unit.change.propose') AS "canClassify",
        CASE WHEN ertad.review_has_scope(actor, org, u.parent_id, 'unit.read') THEN u.parent_id ELSE NULL END AS parent_id,
        CASE WHEN ertad.review_has_scope(actor, org, u.parent_id, 'unit.read') THEN (SELECT p.name FROM ertad.units p WHERE p.organization_id = org AND p.id = u.parent_id) ELSE NULL END AS parent_name,
        u.status = 'active' AND ertad.review_has_scope(actor, org, u.id, 'unit.propose') AND u.kind = 'authority' AND u.operational_type <> 'team' AS "canPropose",
        u.kind = 'authority' AND ertad.review_has_scope(actor, org, u.parent_id, 'unit.read')
          AND ertad.review_has_scope(actor, org, u.parent_id, 'unit.change.propose') AS "canChange",
        CASE WHEN u.status = 'active' AND u.kind = 'authority' AND ertad.review_has_scope(actor, org, u.parent_id, 'unit.read')
          AND ertad.review_has_scope(actor, org, u.parent_id, 'unit.change.propose') THEN to_jsonb(ertad.unit_archive_blockers(org, u.id)) ELSE '[]'::jsonb END AS "archiveBlockers"
      FROM ertad.units u
      WHERE u.organization_id = org AND u.status = COALESCE(input->>'status', 'active')
        AND (
          (u.status = 'active' AND ertad.review_has_scope(actor, org, u.id, 'unit.read'))
          OR (u.status = 'archived' AND ertad.review_has_scope(actor, org, u.parent_id, 'unit.read')
            AND (ertad.review_has_scope(actor, org, u.parent_id, 'unit.change.propose') OR ertad.review_has_scope(actor, org, u.parent_id, 'unit.change.approve')))
        )
        AND position(lower(COALESCE(input->>'search', '')) in lower(u.name)) > 0
    ),
    paged AS (SELECT * FROM visible ORDER BY name, id LIMIT 25 OFFSET (page - 1) * 25)
    SELECT jsonb_build_object(
      'items', COALESCE((SELECT jsonb_agg(to_jsonb(paged) ORDER BY name, id) FROM paged), '[]'),
      'total', (SELECT count(*) FROM visible),
      'page', page,
      'pageSize', 25
    ) INTO result;
  ELSIF op = 'propose' THEN
    parent := (input->>'parentId')::uuid; expiry := (input->>'expiresAt')::timestamptz;
    unit_type := COALESCE(input->>'operationalType', 'unclassified'); area := input->>'geographicAreaId';
    IF NOT ertad.review_has_scope(actor, org, parent, 'unit.read') OR NOT ertad.review_has_scope(actor, org, parent, 'unit.propose') THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
    END IF;
    SELECT * INTO r FROM ertad.unit_reviews WHERE organization_id = org AND requester_id = actor AND request_key = (input->>'key')::uuid;
    IF FOUND THEN
      IF r.kind <> 'create' OR (r.parent_id, r.name, r.reason, r.expires_at, r.operational_type, r.geographic_area_id)
        IS DISTINCT FROM (parent, trim(input->>'name'), trim(input->>'reason'), expiry, unit_type, area) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Request conflict';
      END IF;
    ELSE
      IF NOT EXISTS (SELECT 1 FROM ertad.units WHERE organization_id = org AND id = parent AND kind = 'authority' AND status = 'active')
        OR expiry <= clock_timestamp() OR expiry > clock_timestamp() + interval '7 days' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid parent or deadline';
      END IF;
      PERFORM ertad.validate_unit_territory(org, parent, unit_type, area);
      INSERT INTO ertad.unit_reviews (
        organization_id, parent_id, parent_path, name, requester_id, reason, request_key, expires_at,
        operational_type, geographic_area_id, parent_territory_version
      )
      VALUES (
        org, parent, ertad.unit_path(org, parent), trim(input->>'name'), actor, trim(input->>'reason'),
        (input->>'key')::uuid, expiry, unit_type, area,
        (SELECT territory_version FROM ertad.units WHERE organization_id = org AND id = parent)
      )
      RETURNING * INTO r;
      changed := true;
    END IF;
    result := jsonb_build_object('id', r.id, 'status', r.status, 'unitId', r.unit_id);
  ELSIF op = 'change' THEN
    change_kind := input->>'kind'; expiry := (input->>'expiresAt')::timestamptz;
    IF change_kind IS NULL OR change_kind NOT IN ('rename', 'archive', 'restore', 'territory')
      OR (change_kind = 'rename' AND (input->>'name' IS NULL OR length(trim(input->>'name')) NOT BETWEEN 1 AND 160))
      OR (change_kind IN ('archive', 'restore', 'territory') AND input ? 'name') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid change';
    END IF;
    SELECT * INTO target FROM ertad.units WHERE organization_id = org AND id = (input->>'unitId')::uuid;
    IF NOT FOUND OR target.parent_id IS NULL OR target.kind <> 'authority'
      OR NOT ertad.review_has_scope(actor, org, target.parent_id, 'unit.read')
      OR NOT ertad.review_has_scope(actor, org, target.parent_id, 'unit.change.propose') THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
    END IF;
    unit_type := CASE WHEN change_kind = 'territory' THEN input->>'operationalType' ELSE target.operational_type END;
    area := CASE WHEN change_kind = 'territory' THEN input->>'geographicAreaId' ELSE target.geographic_area_id END;
    SELECT * INTO r FROM ertad.unit_reviews WHERE organization_id = org AND requester_id = actor AND request_key = (input->>'key')::uuid;
    IF FOUND THEN
      IF (r.kind, r.target_id, r.target_version, r.reason, r.expires_at) IS DISTINCT FROM
        (change_kind, target.id, (input->>'version')::integer, trim(input->>'reason'), expiry)
        OR (change_kind = 'rename' AND r.name IS DISTINCT FROM trim(input->>'name'))
        OR (change_kind = 'territory' AND (r.operational_type, r.geographic_area_id) IS DISTINCT FROM (unit_type, area)) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Request conflict';
      END IF;
    ELSE
      IF target.status IS DISTINCT FROM (CASE WHEN change_kind = 'restore' THEN 'archived' ELSE 'active' END)
        OR target.version IS DISTINCT FROM (input->>'version')::integer
        OR (change_kind = 'rename' AND target.name = trim(input->>'name')) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Unit changed';
      END IF;
      IF expiry <= clock_timestamp() OR expiry > clock_timestamp() + interval '7 days' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid deadline';
      END IF;
      IF change_kind = 'territory' THEN
        IF target.operational_type <> 'unclassified' OR unit_type IS NULL OR unit_type = 'unclassified' THEN
          RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Territory already classified';
        END IF;
        PERFORM ertad.validate_unit_territory(org, target.parent_id, unit_type, area);
      END IF;
      IF change_kind = 'archive' AND cardinality(ertad.unit_archive_blockers(org, target.id)) > 0 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Unit has linked records';
      END IF;
      INSERT INTO ertad.unit_reviews (
        organization_id, parent_id, parent_path, name, requester_id, reason, request_key, expires_at,
        kind, target_id, target_version, original_name, operational_type, geographic_area_id, parent_territory_version
      )
      VALUES (
        org, target.parent_id, ertad.unit_path(org, target.parent_id),
        CASE WHEN change_kind = 'rename' THEN trim(input->>'name') ELSE target.name END,
        actor, trim(input->>'reason'), (input->>'key')::uuid, expiry, change_kind, target.id, target.version,
        target.name, unit_type, area, (SELECT territory_version FROM ertad.units WHERE organization_id = org AND id = target.parent_id)
      )
      RETURNING * INTO r;
      changed := true;
    END IF;
    result := jsonb_build_object('id', r.id, 'status', r.status, 'unitId', r.unit_id);
  ELSIF op IN ('detail', 'decide') THEN
    SELECT * INTO r FROM ertad.unit_reviews WHERE organization_id = org AND id = (input->>'id')::uuid;
    IF NOT FOUND OR NOT ertad.unit_review_visible(actor, r) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
    END IF;
    propose_permission := CASE WHEN r.kind = 'create' THEN 'unit.propose' ELSE 'unit.change.propose' END;
    approve_permission := CASE WHEN r.kind = 'create' THEN 'unit.approve' ELSE 'unit.change.approve' END;
    IF op = 'decide' THEN
      IF actor = r.requester_id OR NOT ertad.review_has_scope(actor, org, r.parent_id, approve_permission) THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
      END IF;
      IF input->>'decision' NOT IN ('approved', 'rejected') OR length(trim(input->>'reason')) NOT BETWEEN 10 AND 1000 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid decision';
      END IF;
      IF r.status <> 'pending' THEN
        IF (r.decision_by, r.decision_key, r.status, r.decision_reason)
          IS DISTINCT FROM (actor, (input->>'key')::uuid, input->>'decision', trim(input->>'reason')) THEN
          RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Request conflict';
        END IF;
      ELSE
        IF r.expires_at <= clock_timestamp() OR NOT ertad.review_has_scope(r.requester_id, org, r.parent_id, propose_permission)
          OR NOT EXISTS (SELECT 1 FROM ertad.units WHERE organization_id = org AND id = r.parent_id AND kind = 'authority')
          OR NOT ertad.review_has_scope(r.requester_id, org, r.parent_id, 'unit.read')
          OR r.parent_path IS DISTINCT FROM ertad.unit_path(org, r.parent_id) THEN
          RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Request conflict';
        END IF;
        IF r.kind <> 'create' THEN
          SELECT * INTO target FROM ertad.units WHERE organization_id = org AND id = r.target_id;
          IF NOT FOUND OR target.parent_id IS DISTINCT FROM r.parent_id OR target.version IS DISTINCT FROM r.target_version
            OR target.status IS DISTINCT FROM (CASE WHEN r.kind = 'restore' THEN 'archived' ELSE 'active' END)
            OR target.kind <> 'authority' THEN
            RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Unit changed';
          END IF;
        END IF;
        IF input->>'decision' = 'approved' THEN
          IF r.kind IN ('create', 'territory') THEN
            IF r.parent_territory_version IS NOT NULL AND r.parent_territory_version IS DISTINCT FROM
              (SELECT territory_version FROM ertad.units WHERE organization_id = org AND id = r.parent_id) THEN
              RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Territorial parent changed';
            END IF;
            PERFORM ertad.validate_unit_territory(org, r.parent_id, r.operational_type, r.geographic_area_id);
          END IF;
          IF r.kind IN ('create', 'rename', 'restore') AND EXISTS (
            SELECT 1 FROM ertad.units
            WHERE organization_id = org AND parent_id = r.parent_id
              AND id IS DISTINCT FROM r.target_id AND status = 'active' AND lower(trim(name)) = lower(r.name)
          ) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Duplicate unit';
          END IF;
          IF r.kind = 'create' THEN
            INSERT INTO ertad.units (organization_id, parent_id, name, kind, operational_type, geographic_area_id)
            VALUES (org, r.parent_id, r.name, 'authority', r.operational_type, r.geographic_area_id)
            RETURNING id INTO new_unit;
            IF r.operational_type = 'group' THEN
              main_title := CASE WHEN length(trim(r.name)) >= 3 THEN left(trim(r.name), 120) ELSE left(trim(r.name) || ' chat', 120) END;
              INSERT INTO ertad.channels (organization_id, unit_id, scope_path, title, creator_id, channel_kind, is_main)
              VALUES (org, new_unit, ertad.unit_path(org, new_unit), main_title, actor, 'group', true)
              RETURNING id INTO new_channel;
            END IF;
          ELSE
            IF r.kind = 'archive' AND cardinality(ertad.unit_archive_blockers(org, r.target_id, r.id)) > 0 THEN
              RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Unit has linked records';
            END IF;
            UPDATE ertad.units
            SET name = r.name,
                status = CASE WHEN r.kind = 'archive' THEN 'archived' ELSE 'active' END,
                admission_open = CASE WHEN r.kind = 'archive' THEN false ELSE admission_open END,
                admission_position_id = CASE WHEN r.kind = 'archive' THEN NULL ELSE admission_position_id END,
                operational_type = CASE WHEN r.kind = 'territory' THEN r.operational_type ELSE operational_type END,
                geographic_area_id = CASE WHEN r.kind = 'territory' THEN r.geographic_area_id ELSE geographic_area_id END
            WHERE organization_id = org AND id = r.target_id
            RETURNING id INTO new_unit;
          END IF;
        END IF;
        UPDATE ertad.unit_reviews
        SET status = input->>'decision', decision_by = actor, decision_key = (input->>'key')::uuid,
            decision_reason = trim(input->>'reason'), decision_at = clock_timestamp(),
            unit_id = new_unit, main_channel_id = new_channel
        WHERE organization_id = org AND id = r.id
        RETURNING * INTO r;
        changed := true;
      END IF;
      result := jsonb_build_object('id', r.id, 'status', r.status, 'unitId', r.unit_id, 'mainChannelId', r.main_channel_id);
    ELSE
      result := (to_jsonb(r) - ARRAY['request_key', 'decision_key', 'parent_path']) || jsonb_build_object(
        'parent_name', (SELECT name FROM ertad.units WHERE organization_id = org AND id = r.parent_id),
        'status', CASE WHEN r.status = 'pending' AND r.expires_at <= clock_timestamp() THEN 'expired' ELSE r.status END,
        'operational_type', r.operational_type,
        'geographic_area_id', r.geographic_area_id,
        'main_channel_id', CASE WHEN r.unit_id IS NOT NULL AND ertad.review_has_scope(actor, org, r.unit_id, 'channel.read') THEN r.main_channel_id ELSE NULL END,
        'geography', (SELECT jsonb_build_object('id', g.id, 'nameKa', g.name_ka, 'nameEn', g.name_en) FROM ertad.geographic_areas g WHERE g.id = r.geographic_area_id),
        'canDecide', r.status = 'pending' AND r.expires_at > clock_timestamp() AND actor <> r.requester_id AND ertad.review_has_scope(actor, org, r.parent_id, approve_permission)
      );
    END IF;
  ELSE
    page := COALESCE((input->>'page')::integer, 1);
    view_name := COALESCE(input->>'view', 'pending');
    IF page NOT BETWEEN 1 AND 1000 OR view_name NOT IN ('pending', 'mine', 'history') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid filter';
    END IF;
    WITH visible AS (
      SELECT r.id, r.name, r.kind, r.original_name, r.target_id, r.operational_type, r.geographic_area_id,
        u.name AS parent_name, r.parent_id, r.created_at, r.expires_at,
        CASE WHEN r.status = 'pending' AND r.expires_at <= clock_timestamp() THEN 'expired' ELSE r.status END AS status
      FROM ertad.unit_reviews r
      JOIN ertad.units u ON (u.organization_id, u.id) = (r.organization_id, r.parent_id)
      WHERE r.organization_id = org AND ertad.unit_review_visible(actor, r)
        AND (
          (view_name = 'mine' AND r.requester_id = actor)
          OR (view_name = 'pending' AND r.requester_id <> actor AND r.status = 'pending' AND r.expires_at > clock_timestamp())
          OR (view_name = 'history' AND (r.status <> 'pending' OR r.expires_at <= clock_timestamp()))
        )
    ),
    paged AS (SELECT * FROM visible ORDER BY expires_at, id LIMIT 25 OFFSET (page - 1) * 25)
    SELECT jsonb_build_object(
      'items', COALESCE((SELECT jsonb_agg(to_jsonb(paged) ORDER BY expires_at, id) FROM paged), '[]'),
      'total', (SELECT count(*) FROM visible),
      'page', page,
      'pageSize', 25
    ) INTO result;
  END IF;
  RETURN jsonb_build_object(
    'data', result,
    'audit', jsonb_build_object('actorId', actor, 'organizationId', org, 'operation', op, 'reviewId', r.id, 'changed', changed)
  );
END;
$$;

-- Dedicated territorial discovery, member admission request, primary-group preference, and group admission settings command.
CREATE FUNCTION ertad.territory_command(sid uuid, token text, op text, org uuid, input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  actor uuid;
  result jsonb;
  changed boolean := false;
  review_id uuid;
  area_id text;
  unit_row ertad.units;
  pos_row ertad.positions;
  m_row ertad.memberships;
  rev_row ertad.membership_reviews;
  key uuid;
  req_unit uuid;
  req_mid uuid;
  open_flag boolean;
  expiry timestamptz;
  until_at timestamptz;
  reason_text text;
  primary_mid uuid;
BEGIN
  IF op NOT IN ('catalogue', 'groups', 'my_groups', 'group_options', 'request_admission', 'set_primary', 'configure_group') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid operation';
  END IF;

  actor := ertad.review_identity(sid, token, op = 'configure_group');

  IF op IN ('request_admission', 'set_primary', 'configure_group') THEN
    PERFORM 1 FROM ertad.organizations WHERE id = org AND status = 'active' FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
    END IF;
  ELSIF op <> 'catalogue' THEN
    PERFORM 1 FROM ertad.organizations WHERE id = org AND status = 'active' FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(752991884322001::bigint);
  PERFORM ertad.review_identity(sid, token, op = 'configure_group');

  IF op = 'catalogue' THEN
    SELECT jsonb_build_object(
      'version', '2026-11-26.1',
      'coverage', 'operational_baseline',
      'additionalReferencesPending', true,
      'items', COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'id', a.id,
            'parentId', a.parent_id,
            'kind', a.kind,
            'nameKa', a.name_ka,
            'nameEn', a.name_en
          )
          ORDER BY a.name_ka, a.id
        ),
        '[]'
      )
    )
    INTO result
    FROM (SELECT * FROM ertad.geographic_areas WHERE active ORDER BY id LIMIT 500) a;

  ELSIF op = 'groups' THEN
    area_id := NULLIF(trim(COALESCE(input->>'areaId', '')), '');
    IF area_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ertad.geographic_areas WHERE id = area_id AND active) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid area';
    END IF;

    WITH RECURSIVE matched_areas AS (
      SELECT id FROM ertad.geographic_areas WHERE id = area_id
      UNION ALL
      SELECT g.id FROM ertad.geographic_areas g JOIN matched_areas m ON g.parent_id = m.id
    )
    SELECT jsonb_build_object(
      'organizationId', org,
      'areaId', area_id,
      'items', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', u.id,
            'name', u.name,
            'geographicAreaId', u.geographic_area_id,
            'geography', (
              SELECT jsonb_build_object('id', g.id, 'nameKa', g.name_ka, 'nameEn', g.name_en)
              FROM ertad.geographic_areas g WHERE g.id = u.geographic_area_id
            ),
            'positionName', p.name,
            'historyNote', 'standard_group_retention',
            'alreadyMember', EXISTS (
              SELECT 1 FROM ertad.memberships m
              WHERE m.organization_id = org
                AND m.user_id = actor
                AND m.unit_id = u.id
                AND m.status IN ('active', 'suspended')
                AND (m.valid_until IS NULL OR m.valid_until > clock_timestamp())
            ),
            'pendingRequestId', (
              SELECT r.id FROM ertad.membership_reviews r
              WHERE r.organization_id = org
                AND r.target_id = actor
                AND r.unit_id = u.id
                AND r.kind = 'admission'
                AND r.status = 'pending'
                AND r.expires_at > clock_timestamp()
              ORDER BY r.created_at DESC, r.id DESC
              LIMIT 1
            )
          )
          ORDER BY u.name, u.id
        )
        FROM ertad.units u
        JOIN ertad.positions p
          ON (p.organization_id, p.unit_id, p.id) = (u.organization_id, u.id, u.admission_position_id)
        WHERE u.organization_id = org
          AND u.status = 'active'
          AND u.kind = 'authority'
          AND u.operational_type = 'group'
          AND u.admission_open
          AND ertad.position_is_admission_eligible(org, u.id, u.admission_position_id)
          AND (area_id IS NULL OR u.geographic_area_id IN (SELECT id FROM matched_areas))
      ), '[]')
    ) INTO result;

  ELSIF op = 'my_groups' THEN
    SELECT pg.membership_id INTO primary_mid
    FROM ertad.member_primary_groups pg
    JOIN ertad.memberships m ON (m.organization_id, m.id) = (pg.organization_id, pg.membership_id)
    JOIN ertad.units u ON (u.organization_id, u.id) = (m.organization_id, m.unit_id)
    JOIN ertad.positions p ON (p.organization_id, p.unit_id, p.id) = (m.organization_id, m.unit_id, m.position_id)
    JOIN ertad.permission_bundles b ON (b.organization_id, b.id, b.version) = (p.organization_id, p.bundle_id, p.bundle_version)
    WHERE pg.organization_id = org
      AND pg.user_id = actor
      AND m.user_id = actor
      AND m.status = 'active'
      AND m.valid_from <= clock_timestamp()
      AND (m.valid_until IS NULL OR m.valid_until > clock_timestamp())
      AND u.status = 'active'
      AND u.kind = 'authority'
      AND u.operational_type = 'group'
      AND p.status = 'active'
      AND b.status = 'approved'
      AND m.bundle_version = p.bundle_version;

    SELECT jsonb_build_object(
      'organizationId', org,
      'primaryMembershipId', primary_mid,
      'groups', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'membershipId', m.id,
            'unitId', u.id,
            'unitName', u.name,
            'geographicAreaId', u.geographic_area_id,
            'geography', (
              SELECT jsonb_build_object('id', g.id, 'nameKa', g.name_ka, 'nameEn', g.name_en)
              FROM ertad.geographic_areas g WHERE g.id = u.geographic_area_id
            ),
            'positionId', p.id,
            'positionName', p.name,
            'validFrom', m.valid_from,
            'validUntil', m.valid_until,
            'mainChannelId', CASE
              WHEN ertad.review_has_scope(actor, org, u.id, 'channel.read') THEN (
                SELECT c.id FROM ertad.channels c
                WHERE c.organization_id = org AND c.unit_id = u.id AND c.is_main AND NOT c.archived
                LIMIT 1
              )
              ELSE NULL
            END,
            'isPrimary', (m.id IS NOT DISTINCT FROM primary_mid AND primary_mid IS NOT NULL)
          )
          ORDER BY (m.id = primary_mid) DESC NULLS LAST, u.name, m.id
        )
        FROM ertad.memberships m
        JOIN ertad.units u ON (u.organization_id, u.id) = (m.organization_id, m.unit_id)
        JOIN ertad.positions p ON (p.organization_id, p.unit_id, p.id) = (m.organization_id, m.unit_id, m.position_id)
        JOIN ertad.permission_bundles b ON (b.organization_id, b.id, b.version) = (p.organization_id, p.bundle_id, p.bundle_version)
        WHERE m.organization_id = org
          AND m.user_id = actor
          AND m.status = 'active'
          AND m.valid_from <= clock_timestamp()
          AND (m.valid_until IS NULL OR m.valid_until > clock_timestamp())
          AND u.status = 'active'
          AND u.kind = 'authority'
          AND u.operational_type = 'group'
          AND p.status = 'active'
          AND b.status = 'approved'
          AND m.bundle_version = p.bundle_version
      ), '[]'),
      'pendingAdmissions', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', r.id,
            'unitId', r.unit_id,
            'unitName', u.name,
            'positionName', p.name,
            'status', CASE WHEN r.status = 'pending' AND r.expires_at <= clock_timestamp() THEN 'expired' ELSE r.status END,
            'createdAt', r.created_at,
            'expiresAt', r.expires_at
          )
          ORDER BY r.created_at DESC, r.id DESC
        )
        FROM ertad.membership_reviews r
        JOIN ertad.units u ON (u.organization_id, u.id) = (r.organization_id, r.unit_id)
        JOIN ertad.positions p ON (p.organization_id, p.unit_id, p.id) = (r.organization_id, r.unit_id, r.position_id)
        WHERE r.organization_id = org
          AND r.target_id = actor
          AND r.kind = 'admission'
          AND r.status = 'pending'
          AND r.expires_at > clock_timestamp()
      ), '[]')
    ) INTO result;

  ELSIF op = 'group_options' THEN
    req_unit := (input->>'unitId')::uuid;
    SELECT * INTO unit_row FROM ertad.units WHERE organization_id = org AND id = req_unit;
    IF NOT FOUND
      OR unit_row.status <> 'active'
      OR unit_row.kind <> 'authority'
      OR unit_row.operational_type <> 'group'
      OR NOT ertad.review_has_scope(actor, org, req_unit, 'unit.read')
      OR NOT ertad.review_has_scope(actor, org, req_unit, 'membership.approve') THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
    END IF;

    SELECT jsonb_build_object(
      'unitId', unit_row.id,
      'admissionOpen', unit_row.admission_open,
      'admissionPositionId', unit_row.admission_position_id,
      'eligiblePositions', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object('id', p.id, 'name', p.name, 'bundleVersion', p.bundle_version)
          ORDER BY p.name, p.id
        )
        FROM ertad.positions p
        WHERE p.organization_id = org
          AND p.unit_id = unit_row.id
          AND ertad.position_is_admission_eligible(org, unit_row.id, p.id)
      ), '[]')
    ) INTO result;

  ELSIF op = 'request_admission' THEN
    req_unit := (input->>'unitId')::uuid;
    key := (input->>'key')::uuid;
    reason_text := trim(COALESCE(input->>'reason', ''));
    IF length(reason_text) NOT BETWEEN 10 AND 1000 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid reason';
    END IF;

    SELECT * INTO rev_row
    FROM ertad.membership_reviews
    WHERE organization_id = org AND requester_id = actor AND request_key = key;

    IF FOUND THEN
      IF rev_row.kind <> 'admission'
        OR rev_row.unit_id IS DISTINCT FROM req_unit
        OR rev_row.reason IS DISTINCT FROM reason_text
        OR (input ? 'expiresAt' AND rev_row.expires_at IS DISTINCT FROM (input->>'expiresAt')::timestamptz)
        OR (input ? 'validUntil' AND rev_row.valid_until IS DISTINCT FROM (input->>'validUntil')::timestamptz) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Request conflict';
      END IF;
      review_id := rev_row.id;
    ELSE
      SELECT * INTO unit_row FROM ertad.units WHERE organization_id = org AND id = req_unit;
      IF NOT FOUND
        OR unit_row.status <> 'active'
        OR unit_row.kind <> 'authority'
        OR unit_row.operational_type <> 'group'
        OR NOT unit_row.admission_open
        OR unit_row.admission_position_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
      END IF;

      IF NOT ertad.position_is_admission_eligible(org, unit_row.id, unit_row.admission_position_id) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Admission position unavailable';
      END IF;

      SELECT * INTO pos_row
      FROM ertad.positions
      WHERE organization_id = org AND unit_id = unit_row.id AND id = unit_row.admission_position_id;

      IF EXISTS (
        SELECT 1 FROM ertad.memberships m
        WHERE m.organization_id = org
          AND m.user_id = actor
          AND m.unit_id = unit_row.id
          AND m.status IN ('active', 'suspended')
          AND (m.valid_until IS NULL OR m.valid_until > clock_timestamp())
      ) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Already a member of this group';
      END IF;

      IF EXISTS (
        SELECT 1 FROM ertad.membership_reviews r
        WHERE r.organization_id = org
          AND r.target_id = actor
          AND r.unit_id = unit_row.id
          AND r.kind = 'admission'
          AND r.status = 'pending'
          AND r.expires_at > clock_timestamp()
      ) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Pending admission already exists';
      END IF;

      expiry := COALESCE((input->>'expiresAt')::timestamptz, clock_timestamp() + interval '7 days');
      until_at := COALESCE((input->>'validUntil')::timestamptz, clock_timestamp() + interval '365 days');
      IF expiry <= clock_timestamp()
        OR expiry > clock_timestamp() + interval '7 days'
        OR until_at <= expiry
        OR until_at > clock_timestamp() + interval '365 days' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Invalid dates';
      END IF;

      INSERT INTO ertad.membership_reviews (
        organization_id, requester_id, target_id, unit_id, position_id, bundle_id, bundle_version,
        reason, valid_until, expires_at, request_key, kind
      )
      VALUES (
        org, actor, actor, unit_row.id, pos_row.id, pos_row.bundle_id, pos_row.bundle_version,
        reason_text, until_at, expiry, key, 'admission'
      )
      RETURNING * INTO rev_row;
      review_id := rev_row.id;
      changed := true;
    END IF;

    result := jsonb_build_object(
      'id', rev_row.id,
      'status', rev_row.status,
      'unitId', rev_row.unit_id,
      'positionId', rev_row.position_id,
      'expiresAt', rev_row.expires_at
    );

  ELSIF op = 'set_primary' THEN
    IF jsonb_typeof(input->'membershipId') = 'null' OR NOT (input ? 'membershipId') THEN
      DELETE FROM ertad.member_primary_groups WHERE organization_id = org AND user_id = actor;
      changed := true;
      result := jsonb_build_object('organizationId', org, 'primaryMembershipId', NULL);
    ELSE
      req_mid := (input->>'membershipId')::uuid;
      SELECT * INTO m_row FROM ertad.memberships WHERE organization_id = org AND id = req_mid;
      IF NOT FOUND OR m_row.user_id <> actor THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
      END IF;
      SELECT * INTO unit_row FROM ertad.units WHERE organization_id = org AND id = m_row.unit_id;
      SELECT * INTO pos_row FROM ertad.positions WHERE organization_id = org AND unit_id = m_row.unit_id AND id = m_row.position_id;
      IF m_row.status <> 'active'
        OR m_row.valid_from > clock_timestamp()
        OR (m_row.valid_until IS NOT NULL AND m_row.valid_until <= clock_timestamp())
        OR unit_row.id IS NULL
        OR unit_row.status <> 'active'
        OR unit_row.kind <> 'authority'
        OR unit_row.operational_type <> 'group'
        OR pos_row.id IS NULL
        OR pos_row.status <> 'active'
        OR pos_row.bundle_version <> m_row.bundle_version
        OR NOT EXISTS (
          SELECT 1 FROM ertad.permission_bundles b
          WHERE b.organization_id = org AND b.id = pos_row.bundle_id AND b.version = pos_row.bundle_version AND b.status = 'approved'
        ) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Membership is not eligible as primary local group';
      END IF;

      INSERT INTO ertad.member_primary_groups (organization_id, user_id, membership_id, updated_at)
      VALUES (org, actor, m_row.id, clock_timestamp())
      ON CONFLICT (organization_id, user_id)
      DO UPDATE SET membership_id = EXCLUDED.membership_id, updated_at = EXCLUDED.updated_at;
      changed := true;
      result := jsonb_build_object(
        'organizationId', org,
        'primaryMembershipId', m_row.id,
        'unitId', unit_row.id,
        'unitName', unit_row.name
      );
    END IF;

  ELSE
    -- configure_group
    req_unit := (input->>'unitId')::uuid;
    open_flag := COALESCE((input->>'admissionOpen')::boolean, false);
    SELECT * INTO unit_row FROM ertad.units WHERE organization_id = org AND id = req_unit FOR UPDATE;
    IF NOT FOUND
      OR unit_row.status <> 'active'
      OR unit_row.kind <> 'authority'
      OR unit_row.operational_type <> 'group'
      OR NOT ertad.review_has_scope(actor, org, req_unit, 'unit.read')
      OR NOT ertad.review_has_scope(actor, org, req_unit, 'membership.approve') THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
    END IF;

    IF open_flag THEN
      IF input->>'admissionPositionId' IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Position required';
      END IF;
      SELECT * INTO pos_row
      FROM ertad.positions
      WHERE organization_id = org
        AND unit_id = unit_row.id
        AND id = (input->>'admissionPositionId')::uuid;
      IF NOT FOUND OR NOT ertad.position_is_admission_eligible(org, unit_row.id, pos_row.id) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Position is not eligible for public member admission';
      END IF;
      UPDATE ertad.units
      SET admission_open = true,
          admission_position_id = pos_row.id
      WHERE organization_id = org AND id = unit_row.id
      RETURNING * INTO unit_row;
    ELSE
      UPDATE ertad.units
      SET admission_open = false,
          admission_position_id = NULL
      WHERE organization_id = org AND id = unit_row.id
      RETURNING * INTO unit_row;
    END IF;
    changed := true;
    result := jsonb_build_object(
      'unitId', unit_row.id,
      'admissionOpen', unit_row.admission_open,
      'admissionPositionId', unit_row.admission_position_id
    );
  END IF;

  RETURN jsonb_build_object(
    'data', result,
    'audit', jsonb_build_object(
      'actorId', actor,
      'organizationId', org,
      'operation', op,
      'reviewId', review_id,
      'changed', changed
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION ertad.position_is_admission_eligible(uuid, uuid, uuid),
  ertad.clear_inactive_primary_group(),
  ertad.territory_command(uuid, text, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.territory_command(uuid, text, text, uuid, jsonb) TO ertad_app;

-- Update workspace_bootstrap to include active authorized local group contexts & primary designation.
CREATE OR REPLACE FUNCTION ertad.workspace_bootstrap(sid uuid, token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  account uuid;
  actor uuid;
  grant_row ertad.platform_accounts;
  platform_access jsonb;
  reviews_ctx jsonb;
  review_count_json jsonb;
  pending_reviews integer := 0;
  units_ctx jsonb;
  groups_ctx jsonb;
  decisions_ctx jsonb;
  work_ctx jsonb;
  collective_ctx jsonb;
  points_ctx jsonb;
  channels_ctx jsonb;
  members_ctx jsonb;
  positions_ctx jsonb;
  invitations_ctx jsonb;
  inbox_data jsonb;
  work_orgs uuid[];
  decision_orgs uuid[];
  collective_orgs uuid[];
  open_work integer := 0;
  offered_work integer := 0;
  overdue_work integer := 0;
  upcoming_events_48h integer := 0;
  open_decisions integer := 0;
  pending_collective integer := 0;
  schedule_data jsonb := '[]'::jsonb;
  urgent_data jsonb := '[]'::jsonb;
  now_ts timestamptz := clock_timestamp();
BEGIN
  SELECT admin_user_id INTO account
  FROM ertad.admin_sessions
  WHERE id = sid AND token_hash = token
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
  END IF;

  PERFORM 1 FROM ertad.admin_users WHERE id = account FOR SHARE;
  SELECT * INTO grant_row FROM ertad.platform_accounts WHERE admin_user_id = account FOR SHARE;
  PERFORM pg_advisory_xact_lock(752991884322001::bigint);

  IF NOT EXISTS (
    SELECT 1
    FROM ertad.admin_sessions s
    JOIN ertad.admin_users a ON a.id = s.admin_user_id
    WHERE s.id = sid
      AND s.token_hash = token
      AND s.revoked_at IS NULL
      AND s.idle_expires_at > clock_timestamp()
      AND s.absolute_expires_at > clock_timestamp()
      AND a.is_active
      AND (a.locked_until IS NULL OR a.locked_until <= clock_timestamp())
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
  END IF;

  platform_access := ertad.platform_console_command(sid, token, 'access', '{}'::jsonb)->'data';

  IF COALESCE((platform_access->>'technicalAccount')::boolean, false) THEN
    RETURN jsonb_build_object(
      'data', jsonb_build_object(
        'platformAccess', platform_access,
        'reviews', '[]'::jsonb,
        'reviewCount', null,
        'units', '[]'::jsonb,
        'groups', '[]'::jsonb,
        'decisions', '[]'::jsonb,
        'work', '[]'::jsonb,
        'collective', '[]'::jsonb,
        'points', '[]'::jsonb,
        'channels', '[]'::jsonb,
        'members', '[]'::jsonb,
        'positions', '[]'::jsonb,
        'invitations', '[]'::jsonb,
        'inbox', jsonb_build_object('contexts', '[]'::jsonb, 'unread', 0, 'actionRequired', 0),
        'summary', jsonb_build_object(
          'openWork', 0,
          'offeredWork', 0,
          'overdueWork', 0,
          'upcomingEvents48h', 0,
          'openDecisions', 0,
          'pendingReviews', 0,
          'pendingCollective', 0,
          'schedule', '[]'::jsonb,
          'urgent', '[]'::jsonb
        )
      ),
      'audit', jsonb_build_object('adminUserId', account, 'technicalAccount', true)
    );
  END IF;

  actor := ertad.review_identity(sid, token, false);

  reviews_ctx := COALESCE(ertad.membership_review_command(sid, token, 'contexts', NULL, '{}'::jsonb)->'data', '[]'::jsonb);
  SELECT COALESCE(SUM((ertad.membership_review_command(sid, token, 'list', (el->>'id')::uuid, '{"view":"pending","page":1}'::jsonb)->'data'->>'total')::integer), 0)
    INTO pending_reviews
  FROM jsonb_array_elements(reviews_ctx) AS el;
  review_count_json := CASE WHEN jsonb_array_length(reviews_ctx) > 0 THEN to_jsonb(pending_reviews) ELSE 'null'::jsonb END;

  units_ctx := COALESCE(ertad.unit_command(sid, token, 'contexts', NULL, '{}'::jsonb)->'data', '[]'::jsonb);
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'organizationId', m.organization_id,
      'organizationName', o.name,
      'membershipId', m.id,
      'unitId', m.unit_id,
      'unitName', u.name,
      'geographicAreaId', u.geographic_area_id,
      'geography', (
        SELECT jsonb_build_object('id', g.id, 'nameKa', g.name_ka, 'nameEn', g.name_en)
        FROM ertad.geographic_areas g
        WHERE g.id = u.geographic_area_id
      ),
      'positionId', m.position_id,
      'positionName', p.name,
      'mainChannelId', CASE
        WHEN ertad.review_has_scope(actor, m.organization_id, m.unit_id, 'channel.read') THEN (
          SELECT c.id
          FROM ertad.channels c
          WHERE c.organization_id = m.organization_id
            AND c.unit_id = m.unit_id
            AND c.is_main
            AND NOT c.archived
          LIMIT 1
        )
        ELSE NULL
      END,
      'isPrimary', (pg.membership_id IS NOT DISTINCT FROM m.id AND pg.membership_id IS NOT NULL)
    )
    ORDER BY o.name, (pg.membership_id = m.id) DESC NULLS LAST, u.name, m.id
  ), '[]'::jsonb)
  INTO groups_ctx
  FROM ertad.memberships m
  JOIN ertad.organizations o ON o.id = m.organization_id
  JOIN ertad.units u ON u.organization_id = m.organization_id AND u.id = m.unit_id
  JOIN ertad.positions p ON p.organization_id = m.organization_id AND p.unit_id = m.unit_id AND p.id = m.position_id
  JOIN ertad.permission_bundles b ON b.organization_id = p.organization_id AND b.id = p.bundle_id AND b.version = p.bundle_version
  LEFT JOIN ertad.member_primary_groups pg ON pg.organization_id = m.organization_id AND pg.user_id = m.user_id
  WHERE m.user_id = actor
    AND o.status = 'active'
    AND u.status = 'active'
    AND u.kind = 'authority'
    AND u.operational_type = 'group'
    AND m.status = 'active'
    AND m.valid_from <= now_ts
    AND (m.valid_until IS NULL OR m.valid_until > now_ts)
    AND p.status = 'active'
    AND b.status = 'approved'
    AND m.bundle_version = p.bundle_version;

  decisions_ctx := COALESCE(ertad.decision_command(sid, token, 'contexts', NULL, '{}'::jsonb)->'data', '[]'::jsonb);
  work_ctx := COALESCE(ertad.work_command(sid, token, 'contexts', NULL, '{}'::jsonb)->'data', '[]'::jsonb);
  collective_ctx := COALESCE(ertad.collective_command(sid, token, 'contexts', NULL, '{}'::jsonb)->'data', '[]'::jsonb);
  points_ctx := COALESCE(ertad.collective_command(sid, token, 'point_contexts', NULL, '{}'::jsonb)->'data', '[]'::jsonb);
  channels_ctx := COALESCE(ertad.channel_command(sid, token, 'contexts', NULL, '{}'::jsonb, ''::text)->'data', '[]'::jsonb);
  members_ctx := COALESCE(ertad.member_directory_command(sid, token, 'contexts', NULL, '{}'::jsonb)->'data', '[]'::jsonb);
  positions_ctx := COALESCE(ertad.collective_command(sid, token, 'position_contexts', NULL, '{}'::jsonb)->'data', '[]'::jsonb);
  invitations_ctx := COALESCE(ertad.web_invite_command(sid, token, 'contexts', NULL, '{}'::jsonb)->'data', '[]'::jsonb);
  inbox_data := COALESCE(ertad.inbox_command(sid, token, 'summary', NULL, '{}'::jsonb)->'data', '{"contexts":[],"unread":0,"actionRequired":0}'::jsonb);

  SELECT COALESCE(array_agg((el->>'id')::uuid), '{}'::uuid[]) INTO work_orgs FROM jsonb_array_elements(work_ctx) el;
  SELECT COALESCE(array_agg((el->>'id')::uuid), '{}'::uuid[]) INTO decision_orgs FROM jsonb_array_elements(decisions_ctx) el;
  SELECT COALESCE(array_agg((el->>'id')::uuid), '{}'::uuid[]) INTO collective_orgs FROM jsonb_array_elements(collective_ctx) el;

  WITH visible_work AS MATERIALIZED (
    SELECT w.organization_id, w.id, w.title, w.status, w.deadline, w.priority
    FROM ertad.work_items w
    WHERE w.organization_id = ANY(work_orgs)
      AND w.status IN ('open', 'offered')
      AND ertad.work_visible(actor, w)
  ),
  visible_events AS MATERIALIZED (
    SELECT e.organization_id, e.id, e.title, e.starts_at
    FROM ertad.mobilization_events e
    WHERE e.organization_id = ANY(work_orgs)
      AND e.status = 'open'
      AND ertad.event_visible(actor, e)
  ),
  visible_decisions AS MATERIALIZED (
    SELECT d.organization_id, d.id, d.title, d.closes_at
    FROM ertad.decisions d
    WHERE d.organization_id = ANY(decision_orgs)
      AND d.status = 'open'
      AND d.closes_at > now_ts
      AND ertad.decision_visible(actor, d)
  ),
  visible_collective AS MATERIALIZED (
    SELECT p.organization_id, p.id, p.deadline
    FROM ertad.collective_proposals p
    WHERE p.organization_id = ANY(collective_orgs)
      AND p.status = 'pending'
      AND p.deadline > now_ts
      AND ertad.collective_visible(actor, p)
  ),
  days AS (
    SELECT gs AS day_offset, (now_ts::date + gs) AS day_date
    FROM pg_catalog.generate_series(0, 6) AS gs
  )
  SELECT
    COALESCE((SELECT count(*) FROM visible_work WHERE status = 'open'), 0),
    COALESCE((SELECT count(*) FROM visible_work WHERE status = 'offered'), 0),
    COALESCE((SELECT count(*) FROM visible_work WHERE deadline <= now_ts), 0),
    COALESCE((SELECT count(*) FROM visible_events WHERE starts_at >= now_ts AND starts_at <= now_ts + interval '48 hours'), 0),
    COALESCE((SELECT count(*) FROM visible_decisions), 0),
    COALESCE((SELECT count(*) FROM visible_collective), 0),
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'dayOffset', d.day_offset,
          'date', pg_catalog.to_char(d.day_date, 'YYYY-MM-DD'),
          'tasks', (SELECT count(*) FROM visible_work w WHERE w.deadline::date = d.day_date),
          'events', (SELECT count(*) FROM visible_events e WHERE e.starts_at::date = d.day_date),
          'decisions', (SELECT count(*) FROM visible_decisions dec WHERE dec.closes_at::date = d.day_date),
          'proposals', (SELECT count(*) FROM visible_collective col WHERE col.deadline::date = d.day_date)
        )
        ORDER BY d.day_offset
      )
      FROM days d
    ), '[]'::jsonb),
    COALESCE((
      SELECT jsonb_agg(u.item ORDER BY u.due_at ASC, u.id ASC)
      FROM (
        SELECT sub.due_at, sub.id, jsonb_build_object(
          'kind', sub.kind,
          'organizationId', sub.organization_id,
          'id', sub.id,
          'title', sub.title,
          'dueAt', sub.due_at,
          'overdue', sub.due_at <= now_ts,
          'route', sub.route
        ) AS item
        FROM (
          SELECT 'task'::text AS kind, organization_id, id, title, deadline AS due_at,
                 '/tasks'::text AS route
          FROM visible_work
          WHERE deadline <= now_ts + interval '7 days'
          UNION ALL
          SELECT 'event'::text AS kind, organization_id, id, title, starts_at AS due_at,
                 '/events'::text AS route
          FROM visible_events
          WHERE starts_at >= now_ts - interval '2 hours' AND starts_at <= now_ts + interval '7 days'
          UNION ALL
          SELECT 'decision'::text AS kind, organization_id, id, title, closes_at AS due_at,
                 '/decisions'::text AS route
          FROM visible_decisions
          WHERE closes_at <= now_ts + interval '7 days'
        ) sub
        ORDER BY sub.due_at ASC, sub.id ASC
        LIMIT 6
      ) u
    ), '[]'::jsonb)
  INTO
    open_work, offered_work, overdue_work, upcoming_events_48h,
    open_decisions, pending_collective, schedule_data, urgent_data;

  RETURN jsonb_build_object(
    'data', jsonb_build_object(
      'platformAccess', platform_access,
      'reviews', reviews_ctx,
      'reviewCount', review_count_json,
      'units', units_ctx,
      'groups', groups_ctx,
      'decisions', decisions_ctx,
      'work', work_ctx,
      'collective', collective_ctx,
      'points', points_ctx,
      'channels', channels_ctx,
      'members', members_ctx,
      'positions', positions_ctx,
      'invitations', invitations_ctx,
      'inbox', inbox_data,
      'summary', jsonb_build_object(
        'openWork', open_work,
        'offeredWork', offered_work,
        'overdueWork', overdue_work,
        'upcomingEvents48h', upcoming_events_48h,
        'openDecisions', open_decisions,
        'pendingReviews', pending_reviews,
        'pendingCollective', pending_collective,
        'schedule', schedule_data,
        'urgent', urgent_data
      )
    ),
    'audit', jsonb_build_object(
      'actorId', actor,
      'technicalAccount', false,
      'organizationCount', jsonb_array_length(units_ctx)
    )
  );
END;
$$;
