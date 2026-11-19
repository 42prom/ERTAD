-- Collective Wave 3: sanitized funding evidence attachments linked to funding proposals.

CREATE TABLE ertad.collective_attachments (
  organization_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  unit_id uuid NOT NULL,
  proposal_id uuid,
  uploader_id uuid NOT NULL REFERENCES ertad.member_users(id),
  request_key uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready', 'purged')),
  media_type text NOT NULL CHECK (media_type IN ('image/png', 'application/pdf')),
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  bytes integer NOT NULL CHECK (bytes BETWEEN 1 AND 5242880),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '90 days'),
  PRIMARY KEY (organization_id, id),
  UNIQUE (organization_id, uploader_id, request_key),
  FOREIGN KEY (organization_id, unit_id)
    REFERENCES ertad.units(organization_id, id),
  FOREIGN KEY (organization_id, proposal_id)
    REFERENCES ertad.collective_proposals(organization_id, id)
);

CREATE INDEX collective_attachments_proposal_idx
  ON ertad.collective_attachments (organization_id, proposal_id)
  WHERE state = 'ready';

ALTER FUNCTION ertad.collective_view(uuid, ertad.collective_proposals)
  RENAME TO collective_before_evidence_view;

CREATE FUNCTION ertad.collective_view(actor uuid, p ertad.collective_proposals) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT ertad.collective_before_evidence_view(actor, p) || jsonb_build_object(
    'attachment',
    CASE
      WHEN p.kind IN ('funding_receipt', 'funding_expense') AND ertad.collective_visible(actor, p) THEN
        (
          SELECT jsonb_build_object('id', a.id, 'mediaType', a.media_type, 'bytes', a.bytes)
          FROM ertad.collective_attachments a
          WHERE a.organization_id = p.organization_id
            AND a.proposal_id = p.id
            AND a.state = 'ready'
            AND a.expires_at > clock_timestamp()
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT 1
        )
      ELSE NULL
    END
  )
$$;

ALTER FUNCTION ertad.collective_command(uuid, text, text, uuid, jsonb)
  RENAME TO collective_before_evidence_command;

CREATE FUNCTION ertad.collective_command(
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
  p ertad.collective_proposals;
  a ertad.collective_attachments;
  res jsonb;
  target_unit uuid;
  att_id uuid;
  existing_count integer;
BEGIN
  IF op NOT IN ('attachment_reserve', 'attachment_ready', 'attachment_download') THEN
    IF op = 'propose' AND (input ? 'attachmentId') AND input->>'attachmentId' IS NOT NULL THEN
      actor := ertad.review_identity(sid, token, false);
      IF input->>'kind' NOT IN ('funding_receipt', 'funding_expense') THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Attachments only supported on funding receipts and expenses';
      END IF;
      att_id := (input->>'attachmentId')::uuid;
      SELECT * INTO a
      FROM ertad.collective_attachments
      WHERE organization_id = org
        AND id = att_id
        AND uploader_id = actor
        AND unit_id = (input->>'unitId')::uuid
        AND state = 'ready';
      IF NOT FOUND OR (a.proposal_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM ertad.collective_receipts r
        WHERE r.organization_id = org AND r.actor_id = actor AND r.key = (input->>'key')::uuid
      )) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Funding attachment unavailable';
      END IF;
      res := ertad.collective_before_evidence_command(sid, token, op, org, input - 'attachmentId');
      IF COALESCE((res->'audit'->>'changed')::boolean, false) THEN
        UPDATE ertad.collective_attachments
        SET proposal_id = (res->'data'->>'id')::uuid
        WHERE organization_id = org
          AND id = att_id
          AND uploader_id = actor
          AND state = 'ready'
          AND proposal_id IS NULL;
        IF NOT FOUND THEN
          RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Funding attachment unavailable';
        END IF;
      END IF;
      RETURN res;
    END IF;
    RETURN ertad.collective_before_evidence_command(sid, token, op, org, input);
  END IF;

  actor := ertad.review_identity(sid, token, false);
  IF op IN ('attachment_reserve', 'attachment_ready') THEN
    PERFORM 1 FROM ertad.organizations WHERE id = org AND status = 'active' FOR UPDATE;
  ELSE
    PERFORM 1 FROM ertad.organizations WHERE id = org AND status = 'active' FOR SHARE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
  END IF;
  PERFORM pg_advisory_xact_lock(752991884322001::bigint);
  PERFORM ertad.review_identity(sid, token, false);

  IF op = 'attachment_download' THEN
    SELECT * INTO a
    FROM ertad.collective_attachments
    WHERE organization_id = org
      AND id = (input->>'attachmentId')::uuid
      AND state = 'ready'
      AND expires_at > clock_timestamp();
    IF NOT FOUND OR a.proposal_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Attachment unavailable';
    END IF;
    SELECT * INTO p FROM ertad.collective_proposals WHERE organization_id = org AND id = a.proposal_id;
    IF NOT FOUND OR NOT ertad.collective_visible(actor, p) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Attachment unavailable';
    END IF;
    RETURN jsonb_build_object(
      'data', jsonb_build_object('id', a.id, 'mediaType', a.media_type, 'digest', a.digest, 'bytes', a.bytes),
      'audit', jsonb_build_object('actorId', actor, 'organizationId', org, 'proposalId', p.id, 'attachmentId', a.id, 'operation', op, 'changed', false)
    );
  END IF;

  target_unit := (input->>'unitId')::uuid;
  IF NOT ertad.collective_actor(actor, org, target_unit, 'funding_expense', false) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Funding upload authority required';
  END IF;

  IF op = 'attachment_reserve' THEN
    SELECT * INTO a
    FROM ertad.collective_attachments
    WHERE organization_id = org AND uploader_id = actor AND request_key = (input->>'key')::uuid;
    IF FOUND THEN
      IF a.unit_id <> target_unit
         OR a.source_digest IS DISTINCT FROM input->>'sourceDigest'
         OR a.media_type IS DISTINCT FROM input->>'mediaType'
         OR a.state = 'purged' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Attachment retry conflict';
      END IF;
    ELSE
      SELECT count(*)::integer INTO existing_count
      FROM ertad.collective_attachments
      WHERE organization_id = org AND uploader_id = actor AND proposal_id IS NULL;
      IF existing_count >= 25 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Unattached funding file limit reached';
      END IF;
      INSERT INTO ertad.collective_attachments(
        organization_id, unit_id, uploader_id, request_key, state, media_type, source_digest, digest, bytes
      )
      VALUES (
        org, target_unit, actor, (input->>'key')::uuid, 'pending',
        input->>'mediaType', input->>'sourceDigest', input->>'sourceDigest', (input->>'bytes')::integer
      )
      RETURNING * INTO a;
    END IF;
    RETURN jsonb_build_object(
      'data', jsonb_build_object('id', a.id, 'state', a.state),
      'audit', jsonb_build_object('actorId', actor, 'organizationId', org, 'unitId', target_unit, 'attachmentId', a.id, 'operation', op, 'changed', true)
    );
  END IF;

  -- attachment_ready
  UPDATE ertad.collective_attachments
  SET state = 'ready',
      digest = input->>'digest',
      bytes = (input->>'bytes')::integer,
      expires_at = created_at + interval '90 days'
  WHERE organization_id = org
    AND id = (input->>'attachmentId')::uuid
    AND unit_id = target_unit
    AND uploader_id = actor
    AND state = 'pending'
  RETURNING * INTO a;
  IF NOT FOUND THEN
    SELECT * INTO a
    FROM ertad.collective_attachments
    WHERE organization_id = org
      AND id = (input->>'attachmentId')::uuid
      AND unit_id = target_unit
      AND uploader_id = actor
      AND state = 'ready';
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Upload authority expired';
    END IF;
  END IF;
  RETURN jsonb_build_object(
    'data', jsonb_build_object('id', a.id, 'mediaType', a.media_type, 'bytes', a.bytes),
    'audit', jsonb_build_object('actorId', actor, 'organizationId', org, 'unitId', target_unit, 'attachmentId', a.id, 'operation', op, 'changed', true)
  );
END;
$$;

REVOKE ALL ON ertad.collective_attachments FROM PUBLIC, ertad_app;
REVOKE ALL ON FUNCTION ertad.collective_before_evidence_view(uuid, ertad.collective_proposals),
  ertad.collective_before_evidence_command(uuid, text, text, uuid, jsonb),
  ertad.collective_view(uuid, ertad.collective_proposals) FROM PUBLIC, ertad_app;
REVOKE ALL ON FUNCTION ertad.collective_command(uuid, text, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.collective_command(uuid, text, text, uuid, jsonb) TO ertad_app;

