-- Territorial Groups Stage T4: Scoped Content & Announcements
-- 1. Separate read vs post authorization on global (descendant announcement) channels:
--    descendant group members with channel.read can read/search/acknowledge/download attachments,
--    while channel.post/manage/moderate remain restricted to explicitly granted scopes on the owning unit.
-- 2. Redact ancestor participant directory on descendant announcement reads for non-managers.
-- 3. Surface isMain and audienceScope ('unit_only' | 'unit_and_descendants' | ...) on channel_view.
-- 4. Support optional non-expanding unitId filters on channels/list, work/event_list, and decisions/list.

CREATE OR REPLACE FUNCTION ertad.channel_scope_allowed(
  actor uuid,
  c ertad.channels,
  permission text DEFAULT 'channel.read'
) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT CASE
    WHEN c.channel_kind = 'direct' THEN
      permission IN ('channel.read', 'channel.post')
      AND (
        actor IN (c.direct_peer_low, c.direct_peer_high)
        OR EXISTS (
          SELECT 1
          FROM ertad.channel_direct_participants dp
          WHERE dp.organization_id = c.organization_id
            AND dp.channel_id = c.id
            AND dp.member_id = actor
        )
      )
      AND (permission <> 'channel.post' OR (NOT c.blocked_by_low AND NOT c.blocked_by_high))
      AND EXISTS (
        SELECT 1
        FROM ertad.memberships ms
        JOIN ertad.organizations o ON o.id = ms.organization_id
        WHERE ms.organization_id = c.organization_id
          AND ms.user_id = actor
          AND o.status = 'active'
          AND ertad.member_membership_state(ms) = 'active'
      )
      AND EXISTS (
        SELECT 1
        FROM ertad.units u
        WHERE u.organization_id = c.organization_id
          AND u.status = 'active'
          AND ertad.review_has_scope(actor, c.organization_id, u.id, 'channel.read')
          AND ertad.review_has_scope(actor, c.organization_id, u.id, permission)
      )
      AND (
        permission <> 'channel.post'
        OR EXISTS (
          SELECT 1
          FROM ertad.memberships pms
          WHERE pms.organization_id = c.organization_id
            AND pms.user_id <> actor
            AND (
              pms.user_id IN (c.direct_peer_low, c.direct_peer_high)
              OR EXISTS (
                SELECT 1
                FROM ertad.channel_direct_participants dp2
                WHERE dp2.organization_id = c.organization_id
                  AND dp2.channel_id = c.id
                  AND dp2.member_id = pms.user_id
              )
            )
            AND ertad.member_membership_state(pms) = 'active'
        )
      )
    WHEN c.channel_kind = 'global' THEN
      c.scope_path = ertad.unit_path(c.organization_id, c.unit_id)
      AND CASE
        WHEN permission = 'channel.read' THEN
          EXISTS (
            SELECT 1
            FROM ertad.units du
            WHERE du.organization_id = c.organization_id
              AND du.status = 'active'
              AND (du.id = c.unit_id OR c.unit_id = ANY(ertad.unit_path(c.organization_id, du.id)))
              AND ertad.review_has_scope(actor, c.organization_id, du.id, 'channel.read')
          )
        ELSE
          ertad.review_has_scope(actor, c.organization_id, c.unit_id, 'channel.read')
          AND ertad.review_has_scope(actor, c.organization_id, c.unit_id, permission)
      END
    WHEN c.work_id IS NULL THEN
      c.scope_path = ertad.unit_path(c.organization_id, c.unit_id)
      AND ertad.review_has_scope(actor, c.organization_id, c.unit_id, 'channel.read')
      AND ertad.review_has_scope(actor, c.organization_id, c.unit_id, permission)
    ELSE
      c.scope_path = ertad.unit_path(c.organization_id, c.unit_id)
      AND EXISTS (
        SELECT 1
        FROM ertad.work_items w
        WHERE w.organization_id = c.organization_id
          AND w.id = c.work_id
          AND w.unit_id = c.unit_id
          AND ertad.work_channel_allowed(actor, w, permission)
      )
  END
$$;

ALTER FUNCTION ertad.channel_view(uuid, ertad.channels)
  RENAME TO channel_before_t4_view;

CREATE FUNCTION ertad.channel_view(actor uuid, c ertad.channels) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT ertad.channel_before_t4_view(actor, c) || jsonb_build_object(
    'isMain', c.is_main,
    'audienceScope', CASE
      WHEN c.channel_kind = 'global' THEN 'unit_and_descendants'
      WHEN c.channel_kind = 'group' THEN 'unit_only'
      ELSE c.channel_kind
    END
  );
$$;

ALTER FUNCTION ertad.channel_command(uuid, text, text, uuid, jsonb, text)
  RENAME TO channel_before_t4_command;

CREATE FUNCTION ertad.channel_command(
  sid uuid,
  token text,
  op text,
  org uuid,
  input jsonb,
  fingerprint text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid;
  c ertad.channels;
  result jsonb;
  kind_filter text;
  view_filter text;
  page integer;
  target_unit uuid;
BEGIN
  IF op = 'participants' THEN
    result := ertad.channel_before_t4_command(sid, token, op, org, input, fingerprint);
    actor := ertad.review_identity(sid, token, false);
    SELECT * INTO c
    FROM ertad.channels
    WHERE organization_id = org AND id = (input->>'id')::uuid;
    -- Viewing a descendant announcement must not disclose ancestor unit membership directories.
    IF FOUND
      AND c.channel_kind = 'global'
      AND NOT ertad.review_has_scope(actor, org, c.unit_id, 'channel.manage')
      AND NOT ertad.member_unit_visible(actor, org, c.unit_id) THEN
      result := jsonb_set(result, '{data,items}', '[]'::jsonb);
    END IF;
    RETURN result;
  END IF;

  IF op = 'list' AND NULLIF(pg_catalog.btrim(COALESCE(input->>'unitId', '')), '') IS NOT NULL THEN
    kind_filter := COALESCE(input->>'kind', 'all');
    view_filter := COALESCE(input->>'view', 'active');
    page := COALESCE((input->>'page')::integer, 1);
    target_unit := (input->>'unitId')::uuid;

    IF kind_filter NOT IN ('all', 'group', 'global', 'task', 'direct', 'member_all') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid channel kind filter';
    END IF;
    IF view_filter NOT IN ('active', 'archived', 'unread') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid view';
    END IF;
    IF page NOT BETWEEN 1 AND 1000 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid pagination';
    END IF;

    actor := ertad.review_identity(sid, token, false);
    PERFORM 1 FROM ertad.organizations WHERE id = org AND status = 'active' FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Channels unavailable';
    END IF;
    PERFORM pg_advisory_xact_lock(752991884322001::bigint);
    actor := ertad.review_identity(sid, token, false);

    IF NOT EXISTS (
      SELECT 1
      FROM ertad.units u
      WHERE u.organization_id = org
        AND u.status = 'active'
        AND ertad.review_has_scope(actor, org, u.id, 'channel.read')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Channels unavailable';
    END IF;

    WITH visible AS MATERIALIZED (
      SELECT ertad.channel_view(actor, ch) AS v
      FROM ertad.channels ch
      WHERE ch.organization_id = org
        AND ertad.channel_allowed(actor, ch)
        AND CASE kind_filter
          WHEN 'all' THEN ch.channel_kind <> 'direct'
          WHEN 'member_all' THEN true
          ELSE ch.channel_kind = kind_filter
        END
        AND (
          (ch.channel_kind = 'group' AND ch.unit_id = target_unit)
          OR (ch.channel_kind = 'global' AND ch.unit_id = ANY(ertad.unit_path(org, target_unit)))
          OR (ch.channel_kind = 'task' AND (ch.unit_id = target_unit OR target_unit = ANY(ertad.unit_path(org, ch.unit_id))))
          OR (ch.channel_kind = 'direct')
        )
    ),
    filtered AS (
      SELECT v
      FROM visible
      WHERE CASE view_filter
        WHEN 'archived' THEN (v->>'archived')::boolean
        WHEN 'unread' THEN NOT (v->>'archived')::boolean AND (v->>'unread')::integer > 0
        ELSE NOT (v->>'archived')::boolean
      END
    ),
    paged AS (
      SELECT v
      FROM filtered
      ORDER BY COALESCE(v->'lastMessage'->>'createdAt', '') DESC, v->>'title', v->>'id'
      LIMIT 25 OFFSET (page - 1) * 25
    )
    SELECT jsonb_build_object(
      'items', COALESCE((SELECT jsonb_agg(v ORDER BY COALESCE(v->'lastMessage'->>'createdAt', '') DESC, v->>'title', v->>'id') FROM paged), '[]'::jsonb),
      'total', (SELECT count(*) FROM filtered),
      'page', page
    ) INTO result;

    RETURN jsonb_build_object(
      'data', result,
      'audit', jsonb_build_object('actorId', actor, 'organizationId', org, 'operation', op, 'channelId', NULL, 'changed', false)
    );
  END IF;

  RETURN ertad.channel_before_t4_command(sid, token, op, org, input, fingerprint);
END;
$$;

-- Non-expanding unitId filter on mobilization event listings.
ALTER FUNCTION ertad.work_command(uuid, text, text, uuid, jsonb)
  RENAME TO work_before_t4_command;

CREATE FUNCTION ertad.work_command(
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
#variable_conflict use_column
DECLARE
  actor uuid;
  page_number integer;
  target_unit uuid;
  data jsonb;
BEGIN
  IF op = 'event_list' AND NULLIF(pg_catalog.btrim(COALESCE(input->>'unitId', '')), '') IS NOT NULL THEN
    page_number := COALESCE((input->>'page')::integer, 1);
    target_unit := (input->>'unitId')::uuid;
    IF page_number NOT BETWEEN 1 AND 1000
      OR COALESCE(input->>'status', 'open') NOT IN ('open', 'completed', 'cancelled')
      OR length(COALESCE(input->>'search', '')) > 80 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid filter';
    END IF;

    actor := ertad.review_identity(sid, token, false);
    PERFORM 1 FROM ertad.organizations WHERE id = org AND status = 'active' FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
    END IF;
    PERFORM pg_advisory_xact_lock(752991884322001::bigint);
    PERFORM ertad.review_identity(sid, token, false);

    WITH visible AS (
      SELECT e.*
      FROM ertad.mobilization_events e
      WHERE e.organization_id = org
        AND ertad.event_visible(actor, e)
        AND e.status = COALESCE(input->>'status', 'open')
        AND position(lower(COALESCE(input->>'search', '')) IN lower(e.title)) > 0
        AND (
          e.unit_id = target_unit
          OR target_unit = ANY(ertad.unit_path(org, e.unit_id))
          OR e.unit_id = ANY(ertad.unit_path(org, target_unit))
        )
    ),
    paged AS (
      SELECT * FROM visible ORDER BY starts_at, id LIMIT 25 OFFSET (page_number - 1) * 25
    )
    SELECT jsonb_build_object(
      'items', COALESCE((SELECT jsonb_agg(ertad.event_view(actor, paged::ertad.mobilization_events) ORDER BY starts_at, id) FROM paged), '[]'::jsonb),
      'total', (SELECT count(*) FROM visible),
      'page', page_number,
      'pageSize', 25
    ) INTO data;

    RETURN jsonb_build_object(
      'data', data,
      'audit', jsonb_build_object('actorId', actor, 'organizationId', org, 'operation', op, 'changed', false)
    );
  END IF;

  RETURN ertad.work_before_t4_command(sid, token, op, org, input);
END;
$$;

-- Non-expanding unitId filter on decision listings.
ALTER FUNCTION ertad.decision_command(uuid, text, text, uuid, jsonb)
  RENAME TO decision_before_t4_command;

CREATE FUNCTION ertad.decision_command(
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
#variable_conflict use_column
DECLARE
  actor uuid;
  n integer;
  view_name text;
  target_unit uuid;
  result jsonb;
BEGIN
  IF op = 'list' AND NULLIF(pg_catalog.btrim(COALESCE(input->>'unitId', '')), '') IS NOT NULL THEN
    n := COALESCE((input->>'page')::integer, 1);
    view_name := COALESCE(input->>'view', 'open');
    target_unit := (input->>'unitId')::uuid;
    IF n NOT BETWEEN 1 AND 1000 OR view_name NOT IN ('draft', 'scheduled', 'open', 'closed', 'cancelled') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid filter';
    END IF;

    actor := ertad.review_identity(sid, token, false);
    PERFORM 1 FROM ertad.organizations WHERE id = org AND status = 'active' FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
    END IF;
    PERFORM pg_advisory_xact_lock(752991884322001::bigint);
    PERFORM ertad.review_identity(sid, token, false);

    WITH visible AS (
      SELECT d.*
      FROM ertad.decisions d
      WHERE d.organization_id = org
        AND ertad.decision_visible(actor, d)
        AND CASE
          WHEN d.status = 'open' AND d.closes_at <= clock_timestamp() THEN 'closed'
          WHEN d.status = 'open' AND d.opens_at IS NOT NULL AND d.opens_at > clock_timestamp() THEN 'scheduled'
          ELSE d.status
        END = view_name
        AND position(lower(COALESCE(input->>'search', '')) IN lower(d.title)) > 0
        AND (
          d.unit_id = target_unit
          OR d.unit_id = ANY(ertad.unit_path(org, target_unit))
          OR target_unit = ANY(d.included_unit_ids)
          OR EXISTS (
            SELECT 1 FROM pg_catalog.unnest(d.included_unit_ids) inc
            WHERE inc = ANY(ertad.unit_path(org, target_unit))
          )
        )
        AND NOT (target_unit = ANY(d.excluded_unit_ids))
    ),
    paged AS (
      SELECT * FROM visible ORDER BY created_at DESC, id LIMIT 25 OFFSET (n - 1) * 25
    )
    SELECT jsonb_build_object(
      'items', COALESCE((SELECT jsonb_agg(ertad.decision_view(actor, paged::ertad.decisions) ORDER BY created_at DESC, id) FROM paged), '[]'::jsonb),
      'total', (SELECT count(*) FROM visible),
      'page', n,
      'pageSize', 25
    ) INTO result;

    RETURN jsonb_build_object(
      'data', result,
      'audit', jsonb_build_object('actorId', actor, 'organizationId', org, 'operation', op, 'decisionId', NULL, 'changed', false)
    );
  END IF;

  RETURN ertad.decision_before_t4_command(sid, token, op, org, input);
END;
$$;

REVOKE ALL ON FUNCTION ertad.channel_before_t4_view(uuid, ertad.channels),
  ertad.channel_view(uuid, ertad.channels),
  ertad.channel_before_t4_command(uuid, text, text, uuid, jsonb, text),
  ertad.work_before_t4_command(uuid, text, text, uuid, jsonb),
  ertad.decision_before_t4_command(uuid, text, text, uuid, jsonb) FROM PUBLIC, ertad_app;
REVOKE ALL ON FUNCTION ertad.channel_scope_allowed(uuid, ertad.channels, text),
  ertad.channel_command(uuid, text, text, uuid, jsonb, text),
  ertad.work_command(uuid, text, text, uuid, jsonb),
  ertad.decision_command(uuid, text, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.channel_command(uuid, text, text, uuid, jsonb, text),
  ertad.work_command(uuid, text, text, uuid, jsonb),
  ertad.decision_command(uuid, text, text, uuid, jsonb) TO ertad_app;
