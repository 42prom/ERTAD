-- Migration 0082: Flagship Messaging & Private Rooms
-- 1. Deterministic 6-character alphanumeric member code (LDLDLD pattern, e.g. K4M9P2)
-- 2. Enriched thread/search items with authorCode, authorLabel, and replyPreview (author + snippet + attachment flag)
-- 3. Multi-member private chats (ertad.channel_direct_participants), code/name search in direct-peers,
--    multi-select direct-open (1 or 2+ peers), and direct-add to add participants to an existing private chat.

CREATE OR REPLACE FUNCTION ertad.member_anon_code(org uuid, member uuid) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  WITH h AS (
    SELECT pg_catalog.decode(
      pg_catalog.md5(COALESCE(org::text, '') || ':' || COALESCE(member::text, '') || ':ertad-chat-code-v1'),
      'hex'
    ) AS b
  ),
  chars AS (
    SELECT 'ABCDEFGHJKLMNPQRSTUVWXYZ'::text AS letters,
           '23456789'::text AS digits
  )
  SELECT
    pg_catalog.substr(c.letters, (pg_catalog.get_byte(h.b, 0) % 24) + 1, 1) ||
    pg_catalog.substr(c.digits,  (pg_catalog.get_byte(h.b, 1) % 8)  + 1, 1) ||
    pg_catalog.substr(c.letters, (pg_catalog.get_byte(h.b, 2) % 24) + 1, 1) ||
    pg_catalog.substr(c.digits,  (pg_catalog.get_byte(h.b, 3) % 8)  + 1, 1) ||
    pg_catalog.substr(c.letters, (pg_catalog.get_byte(h.b, 4) % 24) + 1, 1) ||
    pg_catalog.substr(c.digits,  (pg_catalog.get_byte(h.b, 5) % 8)  + 1, 1)
  FROM h, chars c
$$;

CREATE OR REPLACE FUNCTION ertad.direct_peer_summary(org uuid, peer uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT (
    SELECT jsonb_build_object(
      'memberId', u.id,
      'memberCode', ertad.member_anon_code(org, u.id),
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
        ) THEN 'ჯგუფის კოორდინატორი #' || ertad.member_anon_code(org, u.id)
        ELSE 'წევრი #' || ertad.member_anon_code(org, u.id)
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

CREATE OR REPLACE FUNCTION ertad.channel_message_sender_label(org uuid, author uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT (
    SELECT CASE
      WHEN COALESCE(ps.disclosure_mode, 'private_hidden') = 'shared_context_opt_in'
           AND NULLIF(pg_catalog.btrim(l.display_name), '') IS NOT NULL
        THEN pg_catalog.btrim(l.display_name) || ' · #' || ertad.member_anon_code(org, u.id)
      WHEN EXISTS (
        SELECT 1
        FROM ertad.units un
        WHERE un.organization_id = org
          AND un.status = 'active'
          AND ertad.review_has_scope(u.id, org, un.id, 'channel.manage')
      ) THEN 'კოორდინატორი #' || ertad.member_anon_code(org, u.id)
      ELSE 'წევრი #' || ertad.member_anon_code(org, u.id)
    END
    FROM ertad.member_users u
    LEFT JOIN ertad.member_privacy_settings ps
      ON ps.organization_id = org AND ps.member_id = u.id
    LEFT JOIN ertad.organization_member_labels l
      ON l.organization_id = org AND l.member_id = u.id
    WHERE u.id = author
  )
$$;

CREATE TABLE IF NOT EXISTS ertad.channel_direct_participants (
  organization_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  member_id uuid NOT NULL REFERENCES ertad.member_users(id) ON DELETE CASCADE,
  added_by uuid NOT NULL REFERENCES ertad.member_users(id),
  joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, channel_id, member_id),
  FOREIGN KEY (organization_id, channel_id)
    REFERENCES ertad.channels(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS channel_direct_participants_member_idx
  ON ertad.channel_direct_participants (organization_id, member_id, channel_id);

ALTER TABLE ertad.channels DROP CONSTRAINT IF EXISTS channels_kind_direct_chk;
ALTER TABLE ertad.channels
  ADD CONSTRAINT channels_kind_direct_chk CHECK (
    (channel_kind = 'direct'
      AND work_id IS NULL
      AND (
        (direct_peer_low IS NOT NULL AND direct_peer_high IS NOT NULL AND direct_peer_low < direct_peer_high)
        OR (direct_peer_low IS NULL AND direct_peer_high IS NULL AND NOT blocked_by_low AND NOT blocked_by_high)
      ))
    OR
    (channel_kind <> 'direct'
      AND direct_peer_low IS NULL
      AND direct_peer_high IS NULL
      AND NOT blocked_by_low
      AND NOT blocked_by_high)
  );

DROP INDEX IF EXISTS ertad.channel_direct_pair_unique;
CREATE UNIQUE INDEX channel_direct_pair_unique
  ON ertad.channels (organization_id, direct_peer_low, direct_peer_high)
  WHERE channel_kind = 'direct' AND direct_peer_low IS NOT NULL AND direct_peer_high IS NOT NULL;

INSERT INTO ertad.channel_direct_participants (organization_id, channel_id, member_id, added_by, joined_at)
SELECT c.organization_id, c.id, c.direct_peer_low, c.creator_id, c.created_at
FROM ertad.channels c
WHERE c.channel_kind = 'direct' AND c.direct_peer_low IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO ertad.channel_direct_participants (organization_id, channel_id, member_id, added_by, joined_at)
SELECT c.organization_id, c.id, c.direct_peer_high, c.creator_id, c.created_at
FROM ertad.channels c
WHERE c.channel_kind = 'direct' AND c.direct_peer_high IS NOT NULL
ON CONFLICT DO NOTHING;

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
  RENAME TO channel_before_flagship_view;

CREATE FUNCTION ertad.channel_view(actor uuid, c ertad.channels) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE
  base jsonb;
  peers_arr jsonb;
  peer_count integer;
  computed_title text;
  last_msg jsonb;
BEGIN
  base := ertad.channel_before_flagship_view(actor, c);

  SELECT (
    SELECT jsonb_build_object(
      'seq', m.seq,
      'body', CASE
        WHEN m.body = '[Photo]' AND ertad.channel_message_attachment(c.organization_id, c.id, m.id) IS NOT NULL
          THEN '📷 ფოტო'
        ELSE m.body
      END,
      'mine', m.author_id = actor,
      'createdAt', m.created_at,
      'hasAttachment', (ertad.channel_message_attachment(c.organization_id, c.id, m.id) IS NOT NULL)
    )
    FROM ertad.channel_messages m
    WHERE m.organization_id = c.organization_id
      AND m.channel_id = c.id
      AND NOT m.removed
    ORDER BY m.seq DESC
    LIMIT 1
  ) INTO last_msg;

  IF c.channel_kind = 'direct' THEN
    WITH raw_peers AS (
      SELECT DISTINCT pid
      FROM (
        SELECT c.direct_peer_low AS pid WHERE c.direct_peer_low IS NOT NULL AND c.direct_peer_low <> actor
        UNION
        SELECT c.direct_peer_high AS pid WHERE c.direct_peer_high IS NOT NULL AND c.direct_peer_high <> actor
        UNION
        SELECT dp.member_id AS pid
        FROM ertad.channel_direct_participants dp
        WHERE dp.organization_id = c.organization_id
          AND dp.channel_id = c.id
          AND dp.member_id <> actor
      ) u
    )
    SELECT COALESCE(
      jsonb_agg(
        ertad.direct_peer_summary(c.organization_id, rp.pid)
        ORDER BY rp.pid
      ),
      '[]'::jsonb
    )
    INTO peers_arr
    FROM raw_peers rp;

    peer_count := jsonb_array_length(peers_arr);
    IF peer_count <= 1 THEN
      computed_title := COALESCE((peers_arr->0)->>'label', 'პირადი ჩათი');
    ELSIF NULLIF(pg_catalog.btrim(c.title), '') IS NOT NULL AND c.title <> 'Direct conversation' THEN
      computed_title := pg_catalog.btrim(c.title);
    ELSE
      SELECT pg_catalog.left(
        pg_catalog.string_agg(elem->>'label', ', '),
        120
      )
      INTO computed_title
      FROM jsonb_array_elements(peers_arr) AS elem;
      computed_title := COALESCE(computed_title, 'პირადი ჯგუფი');
    END IF;

    RETURN base || jsonb_build_object(
      'kind', 'direct',
      'title', computed_title,
      'unreadCount', COALESCE((base->>'unread')::integer, 0),
      'blocked', (c.blocked_by_low OR c.blocked_by_high),
      'blockedByMe', ((actor = c.direct_peer_low AND c.blocked_by_low) OR (actor = c.direct_peer_high AND c.blocked_by_high)),
      'peer', peers_arr->0,
      'participants', peers_arr,
      'participantCount', peer_count + 1,
      'isMultiDirect', (peer_count > 1),
      'lastMessage', last_msg
    );
  END IF;

  RETURN base || jsonb_build_object(
    'kind', c.channel_kind,
    'unreadCount', COALESCE((base->>'unread')::integer, 0),
    'blocked', false,
    'blockedByMe', false,
    'peer', NULL,
    'participants', '[]'::jsonb,
    'participantCount', 0,
    'isMultiDirect', false,
    'lastMessage', last_msg
  );
END;
$$;

CREATE OR REPLACE FUNCTION ertad.channel_enrich_thread_items(
  actor uuid,
  org uuid,
  ch_id uuid,
  items jsonb
) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT COALESCE(
    jsonb_agg(
      item || jsonb_build_object(
        'authorCode', COALESCE(ertad.member_anon_code(org, m.author_id), ''),
        'authorLabel', COALESCE(ertad.channel_message_sender_label(org, m.author_id), ''),
        'replyPreview', CASE
          WHEN rm.id IS NULL THEN NULL
          ELSE jsonb_build_object(
            'id', rm.id,
            'seq', rm.seq,
            'removed', rm.removed,
            'mine', rm.author_id = actor,
            'authorCode', COALESCE(ertad.member_anon_code(org, rm.author_id), ''),
            'authorLabel', COALESCE(ertad.channel_message_sender_label(org, rm.author_id), ''),
            'body', CASE
              WHEN rm.removed THEN ''
              WHEN rm.body = '[Photo]' THEN ''
              ELSE pg_catalog.left(rm.body, 140)
            END,
            'hasAttachment', CASE
              WHEN rm.removed THEN false
              ELSE (ertad.channel_message_attachment(org, ch_id, rm.id) IS NOT NULL)
            END
          )
        END
      )
      ORDER BY (item->>'seq')::integer
    ),
    '[]'::jsonb
  )
  FROM jsonb_array_elements(COALESCE(items, '[]'::jsonb)) AS item
  LEFT JOIN ertad.channel_messages m
    ON m.organization_id = org
   AND m.channel_id = ch_id
   AND m.id = (item->>'id')::uuid
  LEFT JOIN ertad.channel_messages rm
    ON rm.organization_id = org
   AND rm.channel_id = ch_id
   AND rm.id = m.reply_id
$$;

ALTER FUNCTION ertad.channel_command(uuid, text, text, uuid, jsonb, text)
  RENAME TO channel_before_flagship_command;

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
  peer_list uuid[];
  low_id uuid;
  high_id uuid;
  shared_unit uuid;
  search_term text;
  custom_title text;
  newid uuid;
  result jsonb;
BEGIN
  IF op NOT IN (
    'work', 'work-create', 'contexts', 'units', 'list', 'thread', 'create', 'post',
    'read', 'mute', 'archive', 'remove', 'report', 'reports', 'resolve',
    'restrictions', 'restriction', 'restrict', 'appeal', 'review-appeal',
    'react', 'pin', 'search', 'participants',
    'attachment_reserve', 'attachment_ready', 'attachment_download',
    'direct-peers', 'direct-open', 'direct-add', 'direct-block'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid channel operation';
  END IF;

  IF op IN ('thread', 'search') THEN
    result := ertad.channel_before_flagship_command(sid, token, op, org, input, fingerprint);
    actor := ertad.review_identity(sid, token, false);
    result := jsonb_set(
      result,
      '{data,items}',
      ertad.channel_enrich_thread_items(
        actor,
        org,
        (input->>'id')::uuid,
        result->'data'->'items'
      )
    );
    result := jsonb_set(
      result,
      '{data,channel}',
      ertad.channel_view(
        actor,
        (SELECT ch FROM ertad.channels ch WHERE ch.organization_id = org AND ch.id = (input->>'id')::uuid)
      )
    );
    RETURN result;
  END IF;

  IF op NOT IN ('direct-peers', 'direct-open', 'direct-add') THEN
    RETURN ertad.channel_before_flagship_command(sid, token, op, org, input, fingerprint);
  END IF;

  actor := ertad.review_identity(sid, token, false);
  IF op IN ('direct-open', 'direct-add') THEN
    PERFORM 1 FROM ertad.organizations WHERE id = org AND status = 'active' FOR UPDATE;
  ELSE
    PERFORM 1 FROM ertad.organizations WHERE id = org AND status = 'active' FOR SHARE;
  END IF;
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

  IF op = 'direct-peers' THEN
    search_term := pg_catalog.lower(
      pg_catalog.btrim(
        pg_catalog.regexp_replace(COALESCE(input->>'search', ''), '^#+', '')
      )
    );

    WITH my_units AS MATERIALIZED (
      SELECT u.id, u.name
      FROM ertad.units u
      WHERE u.organization_id = org
        AND u.status = 'active'
        AND ertad.review_has_scope(actor, org, u.id, 'channel.read')
    ),
    eligible_units AS MATERIALIZED (
      SELECT u.id, u.name,
             EXISTS (SELECT 1 FROM my_units mu WHERE mu.id = u.id) AS shared_with_me
      FROM ertad.units u
      WHERE u.organization_id = org
        AND u.status = 'active'
    ),
    candidates AS (
      SELECT DISTINCT ON (mu.id)
        mu.id AS peer_id,
        eu.name AS unit_name,
        eu.shared_with_me,
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
      JOIN eligible_units eu ON eu.id = ms.unit_id
      WHERE ms.organization_id = org
        AND ms.user_id <> actor
        AND mu.status = 'active'
        AND ertad.member_membership_state(ms) = 'active'
        AND ertad.review_has_scope(mu.id, org, eu.id, 'channel.read')
        AND (eu.shared_with_me OR search_term <> '')
      ORDER BY mu.id, eu.shared_with_me DESC, eu.name
    ),
    matched AS (
      SELECT *
      FROM candidates cnd
      WHERE search_term = ''
         OR pg_catalog.strpos(pg_catalog.lower(COALESCE(cnd.summary->>'memberCode', '')), search_term) > 0
         OR pg_catalog.strpos(pg_catalog.lower(COALESCE(cnd.summary->>'label', '')), search_term) > 0
         OR pg_catalog.strpos(pg_catalog.lower(COALESCE(cnd.unit_name, '')), search_term) > 0
      ORDER BY
        cnd.shared_with_me DESC,
        CASE WHEN (cnd.summary->>'roleKind') = 'coordinator' THEN 0 ELSE 1 END,
        cnd.summary->>'label',
        cnd.peer_id
      LIMIT 40
    )
    SELECT jsonb_build_object(
      'selfCode', ertad.member_anon_code(org, actor),
      'items', COALESCE(
        (
          SELECT jsonb_agg(
            m.summary || jsonb_build_object(
              'unitName', m.unit_name,
              'existingChannelId', m.existing_channel_id
            )
            ORDER BY
              m.shared_with_me DESC,
              CASE WHEN (m.summary->>'roleKind') = 'coordinator' THEN 0 ELSE 1 END,
              m.summary->>'label',
              m.peer_id
          )
          FROM matched m
        ),
        '[]'::jsonb
      )
    ) INTO result;

    RETURN jsonb_build_object(
      'data', result,
      'audit', jsonb_build_object(
        'actorId', actor,
        'organizationId', org,
        'operation', op,
        'channelId', NULL,
        'changed', false
      )
    );
  END IF;

  -- Writing operations: direct-open and direct-add
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

  -- Extract distinct peer UUIDs from input.peerId and/or input.peerIds
  SELECT COALESCE(array_agg(DISTINCT p_uid ORDER BY p_uid), ARRAY[]::uuid[])
  INTO peer_list
  FROM (
    SELECT (input->>'peerId')::uuid AS p_uid
    WHERE input ? 'peerId' AND NULLIF(pg_catalog.btrim(input->>'peerId'), '') IS NOT NULL
    UNION
    SELECT (elem#>>'{}')::uuid AS p_uid
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(input->'peerIds') = 'array' THEN input->'peerIds' ELSE '[]'::jsonb END
    ) AS elem
  ) raw_p
  WHERE p_uid IS NOT NULL AND p_uid <> actor;

  IF COALESCE(cardinality(peer_list), 0) NOT BETWEEN 1 AND 12 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Valid peer required';
  END IF;

  -- Validate every selected peer is an active member in org with channel.read in at least one active unit
  FOREACH peer IN ARRAY peer_list LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM ertad.units u
      JOIN ertad.memberships pms ON pms.organization_id = org AND pms.unit_id = u.id AND pms.user_id = peer
      JOIN ertad.member_users pmu ON pmu.id = peer
      WHERE u.organization_id = org
        AND u.status = 'active'
        AND pmu.status = 'active'
        AND ertad.member_membership_state(pms) = 'active'
        AND ertad.review_has_scope(peer, org, u.id, 'channel.read')
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Direct chat unavailable for this peer';
    END IF;
  END LOOP;

  IF op = 'direct-open' THEN
    SELECT u.id INTO shared_unit
    FROM ertad.units u
    WHERE u.organization_id = org
      AND u.status = 'active'
      AND ertad.review_has_scope(actor, org, u.id, 'channel.read')
    ORDER BY
      EXISTS (
        SELECT 1
        FROM ertad.memberships pms
        WHERE pms.organization_id = org
          AND pms.unit_id = u.id
          AND pms.user_id = peer_list[1]
          AND ertad.member_membership_state(pms) = 'active'
      ) DESC,
      u.id
    LIMIT 1;

    IF shared_unit IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Direct chat unavailable for this peer';
    END IF;

    IF cardinality(peer_list) = 1 THEN
      peer := peer_list[1];
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
      ON CONFLICT (organization_id, direct_peer_low, direct_peer_high)
      WHERE channel_kind = 'direct' AND direct_peer_low IS NOT NULL AND direct_peer_high IS NOT NULL
      DO NOTHING;

      SELECT * INTO c
      FROM ertad.channels
      WHERE organization_id = org
        AND channel_kind = 'direct'
        AND direct_peer_low = low_id
        AND direct_peer_high = high_id;

      INSERT INTO ertad.channel_direct_participants (organization_id, channel_id, member_id, added_by)
      VALUES (org, c.id, actor, actor), (org, c.id, peer, actor)
      ON CONFLICT DO NOTHING;
    ELSE
      custom_title := NULLIF(pg_catalog.btrim(COALESCE(input->>'title', '')), '');
      IF custom_title IS NOT NULL AND pg_catalog.length(custom_title) NOT BETWEEN 3 AND 120 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid title';
      END IF;

      INSERT INTO ertad.channels(
        organization_id, unit_id, scope_path, title, creator_id,
        channel_kind, direct_peer_low, direct_peer_high
      )
      VALUES (
        org,
        shared_unit,
        ertad.unit_path(org, shared_unit),
        COALESCE(custom_title, 'Direct conversation'),
        actor,
        'direct',
        NULL,
        NULL
      )
      RETURNING * INTO c;

      INSERT INTO ertad.channel_direct_participants (organization_id, channel_id, member_id, added_by)
      VALUES (org, c.id, actor, actor)
      ON CONFLICT DO NOTHING;

      FOREACH peer IN ARRAY peer_list LOOP
        INSERT INTO ertad.channel_direct_participants (organization_id, channel_id, member_id, added_by)
        VALUES (org, c.id, peer, actor)
        ON CONFLICT DO NOTHING;
      END LOOP;
    END IF;

    newid := c.id;
    result := ertad.channel_view(actor, c);

  ELSE
    -- op = 'direct-add'
    SELECT * INTO c
    FROM ertad.channels
    WHERE organization_id = org
      AND id = (input->>'id')::uuid
      AND channel_kind = 'direct';

    IF NOT FOUND OR NOT ertad.channel_scope_allowed(actor, c, 'channel.post') THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Direct channel unavailable';
    END IF;

    IF c.direct_peer_low IS NOT NULL AND c.direct_peer_high IS NOT NULL THEN
      INSERT INTO ertad.channel_direct_participants (organization_id, channel_id, member_id, added_by)
      VALUES
        (org, c.id, c.direct_peer_low, c.creator_id),
        (org, c.id, c.direct_peer_high, c.creator_id)
      ON CONFLICT DO NOTHING;
    END IF;

    INSERT INTO ertad.channel_direct_participants (organization_id, channel_id, member_id, added_by)
    VALUES (org, c.id, actor, actor)
    ON CONFLICT DO NOTHING;

    FOREACH peer IN ARRAY peer_list LOOP
      INSERT INTO ertad.channel_direct_participants (organization_id, channel_id, member_id, added_by)
      VALUES (org, c.id, peer, actor)
      ON CONFLICT DO NOTHING;
    END LOOP;

    newid := c.id;
    result := ertad.channel_view(actor, c);
  END IF;

  INSERT INTO ertad.channel_receipts
  VALUES (org, actor, (input->>'key')::uuid, fingerprint, result);

  RETURN jsonb_build_object(
    'data', result,
    'audit', jsonb_build_object(
      'actorId', actor,
      'organizationId', org,
      'operation', op,
      'channelId', COALESCE(c.id, newid),
      'changed', true
    )
  );
END;
$$;

REVOKE ALL ON TABLE ertad.channel_direct_participants FROM PUBLIC, ertad_app;

REVOKE ALL ON FUNCTION
  ertad.member_anon_code(uuid, uuid),
  ertad.direct_peer_summary(uuid, uuid),
  ertad.channel_message_sender_label(uuid, uuid),
  ertad.channel_enrich_thread_items(uuid, uuid, uuid, jsonb),
  ertad.channel_before_flagship_view(uuid, ertad.channels),
  ertad.channel_before_flagship_command(uuid, text, text, uuid, jsonb, text)
FROM PUBLIC, ertad_app;

REVOKE ALL ON FUNCTION ertad.channel_command(uuid, text, text, uuid, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.channel_command(uuid, text, text, uuid, jsonb, text) TO ertad_app;
