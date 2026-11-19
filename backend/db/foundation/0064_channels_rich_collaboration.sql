-- Rich scoped channel collaboration: reactions, pinned messages, message search,
-- visible participant mentions, and normalized private S3 attachments.

CREATE TABLE ertad.channel_reactions (
  organization_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  message_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES ertad.member_users(id),
  emoji text NOT NULL CHECK (emoji IN ('like', 'confirm', 'heart', 'eyes', 'celebrate')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, channel_id, message_id, user_id, emoji),
  FOREIGN KEY (organization_id, channel_id, message_id)
    REFERENCES ertad.channel_messages(organization_id, channel_id, id)
);

ALTER TABLE ertad.channels ADD COLUMN pinned_message_id uuid;
ALTER TABLE ertad.channels
  ADD FOREIGN KEY (organization_id, id, pinned_message_id)
  REFERENCES ertad.channel_messages(organization_id, channel_id, id);

CREATE TABLE ertad.channel_attachments (
  organization_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  message_id uuid,
  uploader_id uuid NOT NULL REFERENCES ertad.member_users(id),
  request_key uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready', 'purged')),
  media_type text NOT NULL CHECK (media_type IN ('image/png', 'application/pdf')),
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  bytes integer NOT NULL CHECK (bytes BETWEEN 1 AND 5242880),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '90 days'),
  PRIMARY KEY (organization_id, channel_id, id),
  UNIQUE (organization_id, channel_id, uploader_id, request_key),
  FOREIGN KEY (organization_id, channel_id)
    REFERENCES ertad.channels(organization_id, id),
  FOREIGN KEY (organization_id, channel_id, message_id)
    REFERENCES ertad.channel_messages(organization_id, channel_id, id)
);

CREATE INDEX channel_attachments_msg_idx
  ON ertad.channel_attachments (organization_id, channel_id, message_id)
  WHERE state = 'ready';

ALTER FUNCTION ertad.channel_view(uuid, ertad.channels) RENAME TO channel_before_rich_view;
CREATE FUNCTION ertad.channel_view(actor uuid, c ertad.channels) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT ertad.channel_before_rich_view(actor, c) || jsonb_build_object(
    'pinnedMessage', (
      SELECT jsonb_build_object('id', pm.id, 'seq', pm.seq, 'body', pm.body)
      FROM ertad.channel_messages pm
      WHERE pm.organization_id = c.organization_id
        AND pm.channel_id = c.id
        AND pm.id = c.pinned_message_id
        AND NOT pm.removed
    )
  )
$$;

CREATE FUNCTION ertad.channel_message_reactions(actor uuid, org uuid, ch uuid, msg uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object('emoji', r.emoji, 'count', r.cnt, 'mine', r.mine)
      ORDER BY r.emoji
    ),
    '[]'::jsonb
  )
  FROM (
    SELECT emoji, count(*)::int AS cnt, bool_or(user_id = actor) AS mine
    FROM ertad.channel_reactions
    WHERE organization_id = org AND channel_id = ch AND message_id = msg
    GROUP BY emoji
  ) r
$$;

CREATE FUNCTION ertad.channel_message_attachment(org uuid, ch uuid, msg uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT (
    SELECT jsonb_build_object('id', a.id, 'mediaType', a.media_type, 'bytes', a.bytes)
    FROM ertad.channel_attachments a
    WHERE a.organization_id = org
      AND a.channel_id = ch
      AND a.message_id = msg
      AND a.state = 'ready'
      AND a.expires_at > clock_timestamp()
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT 1
  )
$$;

ALTER FUNCTION ertad.channel_command(uuid, text, text, uuid, jsonb, text)
  RENAME TO channel_before_rich_command;

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
#variable_conflict use_column
DECLARE
  actor uuid;
  c ertad.channels;
  m ertad.channel_messages;
  a ertad.channel_attachments;
  receipt ertad.channel_receipts;
  result jsonb;
  data jsonb;
  target_msg uuid;
  emoji_val text;
  term text;
  existing_count integer;
  reacted_now boolean;
BEGIN
  IF op NOT IN (
    'work', 'work-create', 'contexts', 'units', 'list', 'thread', 'create', 'post',
    'read', 'mute', 'archive', 'remove', 'report', 'reports', 'resolve',
    'restrictions', 'restriction', 'restrict', 'appeal', 'review-appeal',
    'react', 'pin', 'search', 'participants',
    'attachment_reserve', 'attachment_ready', 'attachment_download'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid channel operation';
  END IF;

  IF op NOT IN (
    'thread', 'post', 'remove', 'resolve', 'react', 'pin', 'search', 'participants',
    'attachment_reserve', 'attachment_ready', 'attachment_download'
  ) THEN
    RETURN ertad.channel_before_rich_command(sid, token, op, org, input, fingerprint);
  END IF;

  IF op = 'thread' THEN
    result := ertad.channel_before_rich_command(sid, token, 'thread', org, input, fingerprint);
    actor := ertad.review_identity(sid, token, false);
    SELECT * INTO c FROM ertad.channels WHERE organization_id = org AND id = (input->>'id')::uuid;
    result := jsonb_set(
      result,
      '{data,items}',
      (
        SELECT COALESCE(
          jsonb_agg(
            item || jsonb_build_object(
              'reactions', ertad.channel_message_reactions(actor, org, c.id, (item->>'id')::uuid),
              'attachment', CASE WHEN (item->>'removed')::boolean THEN NULL
                ELSE ertad.channel_message_attachment(org, c.id, (item->>'id')::uuid) END
            )
            ORDER BY (item->>'seq')::integer
          ),
          '[]'::jsonb
        )
        FROM jsonb_array_elements(result->'data'->'items') AS item
      )
    );
    RETURN result;
  END IF;

  IF op = 'post' THEN
    actor := ertad.review_identity(sid, token, false);
    IF input ? 'attachmentId' AND input->>'attachmentId' IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1
        FROM ertad.channel_attachments att
        WHERE att.organization_id = org
          AND att.channel_id = (input->>'id')::uuid
          AND att.id = (input->>'attachmentId')::uuid
          AND att.uploader_id = actor
          AND att.state = 'ready'
          AND (att.message_id IS NULL OR EXISTS (
            SELECT 1 FROM ertad.channel_receipts r WHERE r.organization_id = org AND r.actor_id = actor AND r.key = (input->>'key')::uuid
          ))
      ) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Attachment unavailable';
      END IF;
    END IF;
    result := ertad.channel_before_rich_command(
      sid, token, 'post', org, input - 'attachmentId', fingerprint
    );
    IF COALESCE((result->'audit'->>'changed')::boolean, false)
       AND input ? 'attachmentId' AND input->>'attachmentId' IS NOT NULL THEN
      UPDATE ertad.channel_attachments
      SET message_id = (result->'data'->>'messageId')::uuid
      WHERE organization_id = org
        AND channel_id = (input->>'id')::uuid
        AND id = (input->>'attachmentId')::uuid
        AND uploader_id = actor
        AND state = 'ready'
        AND message_id IS NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Attachment unavailable';
      END IF;
    END IF;
    RETURN result;
  END IF;

  IF op IN ('remove', 'resolve') THEN
    result := ertad.channel_before_rich_command(sid, token, op, org, input, fingerprint);
    UPDATE ertad.channels ch
    SET pinned_message_id = NULL
    WHERE ch.organization_id = org
      AND ch.id = (input->>'id')::uuid
      AND ch.pinned_message_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM ertad.channel_messages pm
        WHERE pm.organization_id = org AND pm.channel_id = ch.id AND pm.id = ch.pinned_message_id AND pm.removed
      );
    RETURN result;
  END IF;

  -- Rich collaboration commands: search, participants, react, pin, attachment_*.
  actor := ertad.review_identity(sid, token, false);
  IF op IN ('react', 'pin', 'attachment_reserve', 'attachment_ready') THEN
    PERFORM 1 FROM ertad.organizations WHERE id = org AND status = 'active' FOR UPDATE;
  ELSE
    PERFORM 1 FROM ertad.organizations WHERE id = org AND status = 'active' FOR SHARE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Channels unavailable';
  END IF;
  PERFORM pg_advisory_xact_lock(752991884322001::bigint);
  PERFORM ertad.review_identity(sid, token, false);

  SELECT * INTO c FROM ertad.channels WHERE organization_id = org AND id = (input->>'id')::uuid;
  IF NOT FOUND OR NOT ertad.channel_allowed(actor, c, 'channel.read') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Channel unavailable';
  END IF;

  IF op = 'search' THEN
    term := trim(COALESCE(input->>'search', ''));
    IF length(term) NOT BETWEEN 1 AND 80 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Search term required';
    END IF;
    WITH hits AS (
      SELECT *
      FROM ertad.channel_messages x
      WHERE organization_id = org
        AND channel_id = c.id
        AND NOT x.removed
        AND position(lower(term) IN lower(x.body)) > 0
      ORDER BY x.seq DESC
      LIMIT 25
    )
    SELECT jsonb_build_object(
      'channel', ertad.channel_view(actor, c),
      'items', COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'id', x.id,
            'seq', x.seq,
            'body', x.body,
            'removed', x.removed,
            'mine', x.author_id = actor,
            'authorTag', (SELECT min(seq) FROM ertad.channel_messages WHERE organization_id = org AND channel_id = c.id AND author_id = x.author_id),
            'replySeq', (SELECT seq FROM ertad.channel_messages WHERE organization_id = org AND channel_id = c.id AND id = x.reply_id),
            'createdAt', x.created_at,
            'reactions', ertad.channel_message_reactions(actor, org, c.id, x.id),
            'attachment', ertad.channel_message_attachment(org, c.id, x.id)
          )
          ORDER BY x.seq
        ),
        '[]'::jsonb
      ),
      'hasOlder', false
    ) INTO data
    FROM hits x;
    RETURN jsonb_build_object(
      'data', data,
      'audit', jsonb_build_object('actorId', actor, 'organizationId', org, 'channelId', c.id, 'operation', op, 'changed', false)
    );
  END IF;

  IF op = 'participants' THEN
    SELECT jsonb_build_object(
      'items', COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'id', p.id,
            'tag', p.tag,
            'displayName', p.display_name
          )
          ORDER BY COALESCE(p.tag, 2147483647), p.id
        ),
        '[]'::jsonb
      )
    ) INTO data
    FROM (
      SELECT u.id,
        (SELECT min(seq) FROM ertad.channel_messages m WHERE m.organization_id = org AND m.channel_id = c.id AND m.author_id = u.id) AS tag,
        CASE WHEN ertad.member_unit_visible(actor, org, c.unit_id) THEN l.display_name ELSE NULL END AS display_name
      FROM ertad.member_users u
      LEFT JOIN ertad.organization_member_labels l
        ON l.organization_id = org AND l.member_id = u.id
      WHERE u.status = 'active'
        AND ertad.channel_allowed(u.id, c, 'channel.read')
      ORDER BY u.id
      LIMIT 30
    ) p;
    RETURN jsonb_build_object(
      'data', data,
      'audit', jsonb_build_object('actorId', actor, 'organizationId', org, 'channelId', c.id, 'operation', op, 'changed', false)
    );
  END IF;

  IF op = 'attachment_download' THEN
    SELECT * INTO a
    FROM ertad.channel_attachments
    WHERE organization_id = org
      AND channel_id = c.id
      AND id = (input->>'attachmentId')::uuid
      AND state = 'ready'
      AND expires_at > clock_timestamp();
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Attachment unavailable';
    END IF;
    RETURN jsonb_build_object(
      'data', jsonb_build_object('id', a.id, 'mediaType', a.media_type, 'digest', a.digest, 'bytes', a.bytes),
      'audit', jsonb_build_object('actorId', actor, 'organizationId', org, 'channelId', c.id, 'attachmentId', a.id, 'operation', op, 'changed', false)
    );
  END IF;

  -- Remaining rich ops require idempotent receipt.
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
      'audit', jsonb_build_object('actorId', actor, 'organizationId', org, 'channelId', c.id, 'operation', op, 'changed', false)
    );
  END IF;

  IF op = 'react' THEN
    IF c.archived OR ertad.channel_restricted(actor, c) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Channel reaction unavailable';
    END IF;
    emoji_val := COALESCE(input->>'emoji', '');
    IF emoji_val NOT IN ('like', 'confirm', 'heart', 'eyes', 'celebrate') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Unsupported reaction';
    END IF;
    SELECT * INTO m
    FROM ertad.channel_messages
    WHERE organization_id = org AND channel_id = c.id AND id = (input->>'messageId')::uuid AND NOT removed;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Message unavailable';
    END IF;
    DELETE FROM ertad.channel_reactions
    WHERE organization_id = org AND channel_id = c.id AND message_id = m.id AND user_id = actor AND emoji = emoji_val;
    IF FOUND THEN
      reacted_now := false;
    ELSE
      INSERT INTO ertad.channel_reactions(organization_id, channel_id, message_id, user_id, emoji)
      VALUES (org, c.id, m.id, actor, emoji_val);
      reacted_now := true;
    END IF;
    data := jsonb_build_object('id', c.id, 'messageId', m.id, 'emoji', emoji_val, 'reacted', reacted_now);
  ELSIF op = 'pin' THEN
    IF c.archived OR NOT (ertad.channel_allowed(actor, c, 'channel.moderate') OR ertad.channel_allowed(actor, c, 'channel.manage')) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Pin moderation authority required';
    END IF;
    target_msg := (input->>'messageId')::uuid;
    IF target_msg IS NOT NULL THEN
      SELECT * INTO m
      FROM ertad.channel_messages
      WHERE organization_id = org AND channel_id = c.id AND id = target_msg AND NOT removed;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Message unavailable';
      END IF;
    END IF;
    UPDATE ertad.channels SET pinned_message_id = target_msg WHERE organization_id = org AND id = c.id;
    data := jsonb_build_object('id', c.id, 'pinnedMessageId', target_msg);
  ELSIF op = 'attachment_reserve' THEN
    IF c.archived OR NOT ertad.channel_allowed(actor, c, 'channel.post') OR ertad.channel_restricted(actor, c) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Upload unavailable';
    END IF;
    SELECT * INTO a
    FROM ertad.channel_attachments
    WHERE organization_id = org AND channel_id = c.id AND uploader_id = actor AND request_key = (input->>'key')::uuid;
    IF FOUND THEN
      IF a.source_digest IS DISTINCT FROM input->>'sourceDigest' OR a.media_type IS DISTINCT FROM input->>'mediaType' OR a.state = 'purged' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Attachment retry conflict';
      END IF;
    ELSE
      SELECT count(*)::integer INTO existing_count
      FROM ertad.channel_attachments
      WHERE organization_id = org AND channel_id = c.id AND uploader_id = actor AND message_id IS NULL;
      IF existing_count >= 30 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Unattached file limit reached';
      END IF;
      INSERT INTO ertad.channel_attachments(
        organization_id, channel_id, uploader_id, request_key, state, media_type, source_digest, digest, bytes
      )
      VALUES (
        org, c.id, actor, (input->>'key')::uuid, 'pending',
        input->>'mediaType', input->>'sourceDigest', input->>'sourceDigest', (input->>'bytes')::integer
      )
      RETURNING * INTO a;
    END IF;
    data := jsonb_build_object('id', a.id, 'state', a.state);
    RETURN jsonb_build_object(
      'data', data,
      'audit', jsonb_build_object('actorId', actor, 'organizationId', org, 'channelId', c.id, 'attachmentId', a.id, 'operation', op, 'changed', true)
    );
  ELSE
    -- attachment_ready
    IF c.archived OR NOT ertad.channel_allowed(actor, c, 'channel.post') OR ertad.channel_restricted(actor, c) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Upload unavailable';
    END IF;
    UPDATE ertad.channel_attachments
    SET state = 'ready',
        digest = input->>'digest',
        bytes = (input->>'bytes')::integer,
        expires_at = created_at + interval '90 days'
    WHERE organization_id = org AND channel_id = c.id AND id = (input->>'attachmentId')::uuid AND uploader_id = actor AND state = 'pending'
    RETURNING * INTO a;
    IF NOT FOUND THEN
      SELECT * INTO a
      FROM ertad.channel_attachments
      WHERE organization_id = org AND channel_id = c.id AND id = (input->>'attachmentId')::uuid AND uploader_id = actor AND state = 'ready';
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Upload authority expired';
      END IF;
    END IF;
    data := jsonb_build_object('id', a.id, 'mediaType', a.media_type, 'bytes', a.bytes);
  END IF;

  INSERT INTO ertad.channel_receipts VALUES (org, actor, (input->>'key')::uuid, fingerprint, data);
  RETURN jsonb_build_object(
    'data', data,
    'audit', jsonb_build_object('actorId', actor, 'organizationId', org, 'channelId', c.id, 'operation', op, 'changed', true)
  );
END;
$$;

REVOKE ALL ON ertad.channel_reactions, ertad.channel_attachments FROM PUBLIC, ertad_app;
REVOKE ALL ON FUNCTION ertad.channel_before_rich_view(uuid, ertad.channels),
  ertad.channel_before_rich_command(uuid, text, text, uuid, jsonb, text),
  ertad.channel_view(uuid, ertad.channels),
  ertad.channel_message_reactions(uuid, uuid, uuid, uuid),
  ertad.channel_message_attachment(uuid, uuid, uuid) FROM PUBLIC, ertad_app;
REVOKE ALL ON FUNCTION ertad.channel_command(uuid, text, text, uuid, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.channel_command(uuid, text, text, uuid, jsonb, text) TO ertad_app;

