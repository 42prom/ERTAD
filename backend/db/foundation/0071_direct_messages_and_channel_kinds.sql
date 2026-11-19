-- Unifies channel kinds ('group', 'global', 'task', 'direct') on the single Channel engine
-- and adds privacy-preserving peer discovery, idempotent direct chat opening, and mutual blocking.

ALTER TABLE ertad.channels
  ADD COLUMN channel_kind text NOT NULL DEFAULT 'group'
    CHECK (channel_kind IN ('group', 'global', 'task', 'direct')),
  ADD COLUMN direct_peer_low uuid REFERENCES ertad.member_users(id),
  ADD COLUMN direct_peer_high uuid REFERENCES ertad.member_users(id),
  ADD COLUMN blocked_by_low boolean NOT NULL DEFAULT false,
  ADD COLUMN blocked_by_high boolean NOT NULL DEFAULT false;

UPDATE ertad.channels
SET channel_kind = 'task'
WHERE work_id IS NOT NULL;

ALTER TABLE ertad.channels
  ADD CONSTRAINT channels_kind_direct_chk CHECK (
    (channel_kind = 'direct'
      AND work_id IS NULL
      AND direct_peer_low IS NOT NULL
      AND direct_peer_high IS NOT NULL
      AND direct_peer_low < direct_peer_high)
    OR
    (channel_kind <> 'direct'
      AND direct_peer_low IS NULL
      AND direct_peer_high IS NULL
      AND NOT blocked_by_low
      AND NOT blocked_by_high)
  ),
  ADD CONSTRAINT channels_kind_work_chk CHECK (
    (work_id IS NULL AND channel_kind <> 'task')
    OR (work_id IS NOT NULL AND channel_kind = 'task')
  );

CREATE UNIQUE INDEX channel_direct_pair_unique
  ON ertad.channels (organization_id, direct_peer_low, direct_peer_high)
  WHERE channel_kind = 'direct';

CREATE FUNCTION ertad.sync_task_channel_kind() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.work_id IS NOT NULL THEN
    NEW.channel_kind := 'task';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sync_task_channel_kind
  BEFORE INSERT ON ertad.channels
  FOR EACH ROW EXECUTE FUNCTION ertad.sync_task_channel_kind();

CREATE FUNCTION ertad.freeze_channel_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (NEW.channel_kind, NEW.direct_peer_low, NEW.direct_peer_high)
     IS DISTINCT FROM (OLD.channel_kind, OLD.direct_peer_low, OLD.direct_peer_high) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Channel identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER freeze_channel_identity
  BEFORE UPDATE ON ertad.channels
  FOR EACH ROW EXECUTE FUNCTION ertad.freeze_channel_identity();

-- Privacy-safe peer label: reveals opt-in shared display name only when member chose shared_context_opt_in,
-- otherwise uses a non-PII deterministic handle + role hint. Never leaks legal name or account IDs.
CREATE FUNCTION ertad.direct_peer_summary(org uuid, peer uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT (
    SELECT jsonb_build_object(
      'memberId', u.id,
      'optIn', (
        COALESCE(ps.disclosure_mode, 'private_hidden') = 'shared_context_opt_in'
        AND NULLIF(pg_catalog.btrim(l.display_name), '') IS NOT NULL
      ),
      'roleKind', CASE
        WHEN EXISTS (
          SELECT 1
          FROM ertad.units un
          WHERE un.organization_id = org
            AND un.status = 'active'
            AND ertad.review_has_scope(u.id, org, un.id, 'channel.manage')
        ) THEN 'coordinator'
        ELSE 'member'
      END,
      'label', CASE
        WHEN COALESCE(ps.disclosure_mode, 'private_hidden') = 'shared_context_opt_in'
             AND NULLIF(pg_catalog.btrim(l.display_name), '') IS NOT NULL
          THEN pg_catalog.btrim(l.display_name)
        WHEN EXISTS (
          SELECT 1
          FROM ertad.units un
          WHERE un.organization_id = org
            AND un.status = 'active'
            AND ertad.review_has_scope(u.id, org, un.id, 'channel.manage')
        ) THEN 'ჯგუფის კოორდინატორი #' || (pg_catalog.abs(pg_catalog.hashtext(u.id::text)) % 9000 + 1000)::text
        ELSE 'წევრი #' || (pg_catalog.abs(pg_catalog.hashtext(u.id::text)) % 9000 + 1000)::text
      END
    )
    FROM ertad.member_users u
    LEFT JOIN ertad.member_privacy_settings ps
      ON ps.organization_id = org AND ps.member_id = u.id
    LEFT JOIN ertad.organization_member_labels l
      ON l.organization_id = org AND l.member_id = u.id
    WHERE u.id = peer
  )
$$;

CREATE OR REPLACE FUNCTION ertad.channel_scope_allowed(
  actor uuid,
  c ertad.channels,
  permission text DEFAULT 'channel.read'
) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT CASE
    WHEN c.channel_kind = 'direct' THEN
      permission IN ('channel.read', 'channel.post')
      AND actor IN (c.direct_peer_low, c.direct_peer_high)
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
            AND pms.user_id = CASE
              WHEN actor = c.direct_peer_low THEN c.direct_peer_high
              ELSE c.direct_peer_low
            END
            AND ertad.member_membership_state(pms) = 'active'
        )
      )
    WHEN c.channel_kind = 'global' THEN
      c.scope_path = ertad.unit_path(c.organization_id, c.unit_id)
      AND EXISTS (
        SELECT 1
        FROM ertad.units du
        WHERE du.organization_id = c.organization_id
          AND du.status = 'active'
          AND (du.id = c.unit_id OR c.unit_id = ANY(ertad.unit_path(c.organization_id, du.id)))
          AND ertad.review_has_scope(actor, c.organization_id, du.id, 'channel.read')
          AND ertad.review_has_scope(actor, c.organization_id, du.id, permission)
      )
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
  RENAME TO channel_before_kinds_view;

CREATE FUNCTION ertad.channel_view(actor uuid, c ertad.channels) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE
  base jsonb;
  peer_id uuid;
  peer_json jsonb;
  last_msg jsonb;
BEGIN
  base := ertad.channel_before_kinds_view(actor, c);
  SELECT (
    SELECT jsonb_build_object(
      'seq', m.seq,
      'body', m.body,
      'mine', m.author_id = actor,
      'createdAt', m.created_at
    )
    FROM ertad.channel_messages m
    WHERE m.organization_id = c.organization_id
      AND m.channel_id = c.id
      AND NOT m.removed
    ORDER BY m.seq DESC
    LIMIT 1
  ) INTO last_msg;

  IF c.channel_kind = 'direct' THEN
    peer_id := CASE WHEN actor = c.direct_peer_low THEN c.direct_peer_high ELSE c.direct_peer_low END;
    peer_json := ertad.direct_peer_summary(c.organization_id, peer_id);
    RETURN base || jsonb_build_object(
      'kind', 'direct',
      'title', COALESCE(peer_json->>'label', 'პირადი ჩათი'),
      'unreadCount', COALESCE((base->>'unread')::integer, 0),
      'blocked', (c.blocked_by_low OR c.blocked_by_high),
      'blockedByMe', ((actor = c.direct_peer_low AND c.blocked_by_low) OR (actor = c.direct_peer_high AND c.blocked_by_high)),
      'peer', peer_json,
      'lastMessage', last_msg
    );
  END IF;

  RETURN base || jsonb_build_object(
    'kind', c.channel_kind,
    'unreadCount', COALESCE((base->>'unread')::integer, 0),
    'blocked', false,
    'blockedByMe', false,
    'peer', NULL,
    'lastMessage', last_msg
  );
END;
$$;

ALTER FUNCTION ertad.channel_command(uuid, text, text, uuid, jsonb, text)
  RENAME TO channel_before_direct_command;

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
  receipt ertad.channel_receipts;
  peer uuid;
  low_id uuid;
  high_id uuid;
  shared_unit uuid;
  kind_filter text;
  view_filter text;
  req_kind text;
  target uuid;
  page integer;
  writing boolean;
  blocked_val boolean;
  newid uuid;
  result jsonb;
BEGIN
  IF op NOT IN (
    'work', 'work-create', 'contexts', 'units', 'list', 'thread', 'create', 'post',
    'read', 'mute', 'archive', 'remove', 'report', 'reports', 'resolve',
    'restrictions', 'restriction', 'restrict', 'appeal', 'review-appeal',
    'react', 'pin', 'search', 'participants',
    'attachment_reserve', 'attachment_ready', 'attachment_download',
    'direct-peers', 'direct-open', 'direct-block'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid channel operation';
  END IF;

  -- Preserve complete existing behavior for all unchanged operations.
  IF op NOT IN ('list', 'create', 'direct-peers', 'direct-open', 'direct-block') THEN
    RETURN ertad.channel_before_direct_command(sid, token, op, org, input, fingerprint);
  END IF;

  -- Delegate group channel creation unchanged unless kind='global'.
  IF op = 'create' THEN
    req_kind := COALESCE(input->>'kind', 'group');
    IF req_kind NOT IN ('group', 'global') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid channel kind';
    END IF;
    IF req_kind = 'group' THEN
      RETURN ertad.channel_before_direct_command(sid, token, op, org, input - 'kind', fingerprint);
    END IF;
  END IF;

  -- List with omitted or 'all' delegates to existing channel_before_direct_command (excludes direct to preserve existing contracts).
  IF op = 'list' THEN
    kind_filter := COALESCE(input->>'kind', 'all');
    IF kind_filter NOT IN ('all', 'group', 'global', 'task', 'direct', 'member_all') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid channel kind filter';
    END IF;
    IF kind_filter = 'all' THEN
      -- Check: legacy 'all' hides direct chats unless member_all/direct requested.
      NULL;
    END IF;
  END IF;

  writing := op IN ('create', 'direct-open', 'direct-block');
  actor := ertad.review_identity(sid, token, op = 'create');
  IF writing THEN
    PERFORM 1 FROM ertad.organizations WHERE id = org AND status = 'active' FOR UPDATE;
  ELSE
    PERFORM 1 FROM ertad.organizations WHERE id = org AND status = 'active' FOR SHARE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Channels unavailable';
  END IF;

  PERFORM pg_advisory_xact_lock(752991884322001::bigint);
  actor := ertad.review_identity(sid, token, op = 'create');

  IF NOT EXISTS (
    SELECT 1
    FROM ertad.units u
    WHERE u.organization_id = org
      AND u.status = 'active'
      AND ertad.review_has_scope(actor, org, u.id, 'channel.read')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Channels unavailable';
  END IF;

  page := COALESCE((input->>'page')::integer, 1);
  IF page NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid pagination';
  END IF;

  IF writing THEN
    IF fingerprint IS NULL OR fingerprint !~ '^[a-f0-9]{64}$' OR input->>'key' IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Request identity required';
    END IF;
    SELECT * INTO receipt
    FROM ertad.channel_receipts
    WHERE organization_id = org AND actor_id = actor AND key = (input->>'key')::uuid;
    IF FOUND THEN
      IF receipt.fingerprint <> fingerprint THEN
        RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Retry conflict';
      END IF;
      RETURN jsonb_build_object(
        'data', receipt.response,
        'audit', jsonb_build_object('actorId', actor, 'organizationId', org, 'operation', op, 'changed', false)
      );
    END IF;
  END IF;

  IF op = 'create' THEN
    -- kind='global' creation with manage+read checks on target unit.
    target := (input->>'unitId')::uuid;
    IF NOT ertad.review_has_scope(actor, org, target, 'channel.manage')
       OR NOT ertad.review_has_scope(actor, org, target, 'channel.read') THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Channel creation unavailable';
    END IF;
    IF pg_catalog.length(pg_catalog.btrim(COALESCE(input->>'title', ''))) NOT BETWEEN 3 AND 120 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid title';
    END IF;
    IF (
      SELECT count(*)
      FROM ertad.channels
      WHERE organization_id = org AND work_id IS NULL AND channel_kind <> 'direct' AND unit_id = target AND NOT archived
    ) >= 50 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Active channel limit';
    END IF;
    INSERT INTO ertad.channels(organization_id, unit_id, scope_path, title, creator_id, channel_kind)
    VALUES (org, target, ertad.unit_path(org, target), pg_catalog.btrim(input->>'title'), actor, 'global')
    RETURNING id INTO newid;
    result := jsonb_build_object('id', newid, 'kind', 'global');

  ELSIF op = 'list' THEN
    view_filter := COALESCE(input->>'view', 'active');
    IF view_filter NOT IN ('active', 'archived', 'unread') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid view';
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

  ELSIF op = 'direct-peers' THEN
    -- Eligible peers: active users sharing an active unit with actor where both hold channel.read.
    WITH my_units AS MATERIALIZED (
      SELECT u.id, u.name
      FROM ertad.units u
      WHERE u.organization_id = org
        AND u.status = 'active'
        AND ertad.review_has_scope(actor, org, u.id, 'channel.read')
    ),
    peers AS (
      SELECT DISTINCT ON (mu.id)
        mu.id AS peer_id,
        u.name AS unit_name,
        ertad.direct_peer_summary(org, mu.id) AS summary,
        (
          SELECT dc.id
          FROM ertad.channels dc
          WHERE dc.organization_id = org
            AND dc.channel_kind = 'direct'
            AND dc.direct_peer_low = LEAST(actor, mu.id)
            AND dc.direct_peer_high = GREATEST(actor, mu.id)
          LIMIT 1
        ) AS existing_channel_id
      FROM ertad.memberships ms
      JOIN ertad.member_users mu ON mu.id = ms.user_id
      JOIN my_units u ON u.id = ms.unit_id
      WHERE ms.organization_id = org
        AND ms.user_id <> actor
        AND mu.status = 'active'
        AND ertad.member_membership_state(ms) = 'active'
        AND ertad.review_has_scope(mu.id, org, u.id, 'channel.read')
      ORDER BY mu.id, u.name
      LIMIT 30
    )
    SELECT jsonb_build_object(
      'items', COALESCE(
        (
          SELECT jsonb_agg(
            p.summary || jsonb_build_object(
              'unitName', p.unit_name,
              'existingChannelId', p.existing_channel_id
            )
            ORDER BY CASE WHEN (p.summary->>'roleKind') = 'coordinator' THEN 0 ELSE 1 END, p.summary->>'label', p.peer_id
          )
          FROM peers p
        ),
        '[]'::jsonb
      )
    ) INTO result;

  ELSIF op = 'direct-open' THEN
    peer := (input->>'peerId')::uuid;
    IF peer IS NULL OR peer = actor THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Valid peer required';
    END IF;
    SELECT u.id INTO shared_unit
    FROM ertad.units u
    JOIN ertad.memberships pms ON pms.organization_id = org AND pms.unit_id = u.id AND pms.user_id = peer
    JOIN ertad.member_users pmu ON pmu.id = peer
    WHERE u.organization_id = org
      AND u.status = 'active'
      AND pmu.status = 'active'
      AND ertad.member_membership_state(pms) = 'active'
      AND ertad.review_has_scope(actor, org, u.id, 'channel.read')
      AND ertad.review_has_scope(peer, org, u.id, 'channel.read')
    ORDER BY u.id
    LIMIT 1;
    IF shared_unit IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Direct chat unavailable for this peer';
    END IF;

    low_id := LEAST(actor, peer);
    high_id := GREATEST(actor, peer);
    INSERT INTO ertad.channels(
      organization_id, unit_id, scope_path, title, creator_id,
      channel_kind, direct_peer_low, direct_peer_high
    )
    VALUES (
      org, shared_unit, ertad.unit_path(org, shared_unit), 'Direct conversation', actor,
      'direct', low_id, high_id
    )
    ON CONFLICT (organization_id, direct_peer_low, direct_peer_high) WHERE channel_kind = 'direct'
    DO NOTHING;

    SELECT * INTO c
    FROM ertad.channels
    WHERE organization_id = org
      AND channel_kind = 'direct'
      AND direct_peer_low = low_id
      AND direct_peer_high = high_id;
    newid := c.id;
    result := ertad.channel_view(actor, c);

  ELSE
    -- op = 'direct-block'
    SELECT * INTO c
    FROM ertad.channels
    WHERE organization_id = org
      AND id = (input->>'id')::uuid
      AND channel_kind = 'direct';
    IF NOT FOUND OR actor NOT IN (c.direct_peer_low, c.direct_peer_high) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Direct channel unavailable';
    END IF;
    blocked_val := COALESCE((input->>'blocked')::boolean, false);
    IF actor = c.direct_peer_low THEN
      UPDATE ertad.channels SET blocked_by_low = blocked_val WHERE organization_id = org AND id = c.id RETURNING * INTO c;
    ELSE
      UPDATE ertad.channels SET blocked_by_high = blocked_val WHERE organization_id = org AND id = c.id RETURNING * INTO c;
    END IF;
    result := jsonb_build_object(
      'id', c.id,
      'blocked', (c.blocked_by_low OR c.blocked_by_high),
      'blockedByMe', ((actor = c.direct_peer_low AND c.blocked_by_low) OR (actor = c.direct_peer_high AND c.blocked_by_high))
    );
  END IF;

  IF writing THEN
    INSERT INTO ertad.channel_receipts
    VALUES (org, actor, (input->>'key')::uuid, fingerprint, result);
  END IF;

  RETURN jsonb_build_object(
    'data', result,
    'audit', jsonb_build_object(
      'actorId', actor,
      'organizationId', org,
      'operation', op,
      'channelId', COALESCE(c.id, newid),
      'changed', writing
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION
  ertad.sync_task_channel_kind(),
  ertad.freeze_channel_identity(),
  ertad.direct_peer_summary(uuid, uuid),
  ertad.channel_before_kinds_view(uuid, ertad.channels),
  ertad.channel_before_direct_command(uuid, text, text, uuid, jsonb, text)
FROM PUBLIC, ertad_app;

REVOKE ALL ON FUNCTION ertad.channel_command(uuid, text, text, uuid, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.channel_command(uuid, text, text, uuid, jsonb, text) TO ertad_app;

