-- M4-C: Technical Admin Integrations (Google OIDC, FCM Push, Telegram, WhatsApp, Viber)
-- with Two-Person Governance (Propose -> Approve), AES-256-GCM Encrypted Credentials,
-- and Privacy-Safe Member Opt-In Notification Channels.

CREATE TABLE IF NOT EXISTS ertad.platform_integrations (
  provider text PRIMARY KEY CHECK (
    provider IN ('google_oidc', 'fcm_push', 'telegram_bot', 'whatsapp_business', 'viber_bot')
  ),
  enabled boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  public_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_cipher text,
  updated_by uuid REFERENCES ertad.admin_users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO ertad.platform_integrations (provider, enabled, version, public_config)
VALUES
  ('google_oidc', false, 1, '{"androidClientId":"","iosClientId":""}'::jsonb),
  ('fcm_push', false, 1, '{"projectId":""}'::jsonb),
  ('telegram_bot', false, 1, '{"botUsername":""}'::jsonb),
  ('whatsapp_business', false, 1, '{"phoneNumberId":""}'::jsonb),
  ('viber_bot', false, 1, '{"senderName":"ERTAD"}'::jsonb)
ON CONFLICT (provider) DO NOTHING;

CREATE TABLE IF NOT EXISTS ertad.platform_integration_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE,
  provider text NOT NULL REFERENCES ertad.platform_integrations(provider) ON DELETE CASCADE,
  expected_version integer NOT NULL CHECK (expected_version > 0),
  enabled boolean NOT NULL,
  public_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_cipher text,
  clear_secret boolean NOT NULL DEFAULT false,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  proposer_id uuid NOT NULL REFERENCES ertad.admin_users(id) ON DELETE RESTRICT,
  reviewer_id uuid REFERENCES ertad.admin_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reviewed_at timestamptz,
  CHECK (reviewer_id IS NULL OR reviewer_id <> proposer_id)
);

CREATE INDEX IF NOT EXISTS platform_integration_proposals_status_idx
  ON ertad.platform_integration_proposals (status, created_at DESC);

CREATE TABLE IF NOT EXISTS ertad.member_notification_channels (
  member_id uuid NOT NULL REFERENCES ertad.member_users(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('push', 'telegram', 'whatsapp', 'viber')),
  enabled boolean NOT NULL DEFAULT false,
  handle_cipher text,
  handle_hint text NOT NULL DEFAULT '' CHECK (length(handle_hint) <= 64),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (member_id, channel)
);

REVOKE ALL ON TABLE
  ertad.platform_integrations,
  ertad.platform_integration_proposals,
  ertad.member_notification_channels
FROM PUBLIC;

CREATE OR REPLACE FUNCTION ertad.platform_integration_command(
  sid uuid,
  token text,
  op text,
  input jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid;
  prov text;
  cur ertad.platform_integrations%ROWTYPE;
  prop ertad.platform_integration_proposals%ROWTYPE;
  req_id uuid;
  exp_ver integer;
  act text;
BEGIN
  IF op IS NULL OR op NOT IN ('read', 'propose', 'review') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid platform integration command';
  END IF;

  IF op = 'read' THEN
    actor := ertad.verification_platform_actor(sid, token, 'platform.verification.read', false);
    RETURN jsonb_build_object(
      'providers', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'provider', i.provider,
            'enabled', i.enabled,
            'version', i.version,
            'publicConfig', i.public_config,
            'hasSecret', (i.secret_cipher IS NOT NULL),
            'updatedAt', i.updated_at
          ) ORDER BY i.provider
        )
        FROM ertad.platform_integrations i
      ), '[]'::jsonb),
      'proposals', COALESCE((
        SELECT jsonb_agg(item ORDER BY created_at DESC)
        FROM (
          SELECT
            p.created_at,
            jsonb_build_object(
              'id', p.id,
              'provider', p.provider,
              'expectedVersion', p.expected_version,
              'enabled', p.enabled,
              'publicConfig', p.public_config,
              'hasSecretUpdate', (p.secret_cipher IS NOT NULL),
              'clearSecret', p.clear_secret,
              'reason', p.reason,
              'status', p.status,
              'proposerId', p.proposer_id,
              'reviewerId', p.reviewer_id,
              'createdAt', p.created_at,
              'reviewedAt', p.reviewed_at
            ) AS item
          FROM ertad.platform_integration_proposals p
          ORDER BY p.created_at DESC
          LIMIT 30
        ) sub
      ), '[]'::jsonb)
    );
  END IF;

  IF op = 'propose' THEN
    actor := ertad.verification_platform_actor(sid, token, 'platform.verification.propose', true);
    prov := input->>'provider';
    req_id := (input->>'requestId')::uuid;
    exp_ver := (input->>'expectedVersion')::integer;

    SELECT * INTO cur FROM ertad.platform_integrations WHERE provider = prov FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Unknown integration provider';
    END IF;
    IF cur.version <> exp_ver THEN
      RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Integration version changed';
    END IF;

    INSERT INTO ertad.platform_integration_proposals (
      request_id, provider, expected_version, enabled, public_config,
      secret_cipher, clear_secret, reason, proposer_id
    ) VALUES (
      req_id,
      prov,
      exp_ver,
      COALESCE((input->>'enabled')::boolean, false),
      COALESCE(input->'publicConfig', '{}'::jsonb),
      NULLIF(btrim(COALESCE(input->>'secretCipher', '')), ''),
      COALESCE((input->>'clearSecret')::boolean, false),
      btrim(COALESCE(input->>'reason', '')),
      actor
    )
    ON CONFLICT (request_id) DO NOTHING
    RETURNING * INTO prop;

    IF NOT FOUND THEN
      SELECT * INTO prop FROM ertad.platform_integration_proposals WHERE request_id = req_id;
    END IF;

    RETURN jsonb_build_object(
      'proposalId', prop.id,
      'provider', prop.provider,
      'status', prop.status
    );
  END IF;

  IF op = 'review' THEN
    actor := ertad.verification_platform_actor(sid, token, 'platform.verification.approve', true);
    act := input->>'action';
    IF act NOT IN ('approve', 'reject') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid review action';
    END IF;

    SELECT * INTO prop
    FROM ertad.platform_integration_proposals
    WHERE id = (input->>'proposalId')::uuid
    FOR UPDATE;

    IF NOT FOUND OR prop.status <> 'pending' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Proposal not pending';
    END IF;
    IF prop.proposer_id = actor THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
    END IF;

    IF act = 'approve' THEN
      SELECT * INTO cur FROM ertad.platform_integrations WHERE provider = prop.provider FOR UPDATE;
      IF cur.version <> prop.expected_version THEN
        RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Integration version changed';
      END IF;

      UPDATE ertad.platform_integrations
      SET enabled = prop.enabled,
          version = cur.version + 1,
          public_config = prop.public_config,
          secret_cipher = CASE
            WHEN prop.clear_secret THEN NULL
            WHEN prop.secret_cipher IS NOT NULL THEN prop.secret_cipher
            ELSE ertad.platform_integrations.secret_cipher
          END,
          updated_by = actor,
          updated_at = clock_timestamp()
      WHERE provider = prop.provider;
    END IF;

    UPDATE ertad.platform_integration_proposals
    SET status = CASE WHEN act = 'approve' THEN 'approved' ELSE 'rejected' END,
        reviewer_id = actor,
        reviewed_at = clock_timestamp()
    WHERE id = prop.id
    RETURNING * INTO prop;

    RETURN jsonb_build_object(
      'proposalId', prop.id,
      'provider', prop.provider,
      'status', prop.status
    );
  END IF;

  RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Unhandled command';
END;
$$;

CREATE OR REPLACE FUNCTION ertad.mobile_notification_channels_command(
  sid uuid,
  token text,
  op text,
  input jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid;
  ch text;
  en boolean;
  h_cipher text;
  h_hint text;
BEGIN
  IF op IS NULL OR op NOT IN ('get', 'set') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid notification channel command';
  END IF;

  actor := ertad.review_identity(sid, token, false);

  IF op = 'set' THEN
    ch := input->>'channel';
    IF ch IS NULL OR ch NOT IN ('push', 'telegram', 'whatsapp', 'viber') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid channel';
    END IF;
    en := COALESCE((input->>'enabled')::boolean, false);
    h_cipher := NULLIF(btrim(COALESCE(input->>'handleCipher', '')), '');
    h_hint := left(btrim(COALESCE(input->>'handleHint', '')), 64);

    INSERT INTO ertad.member_notification_channels (member_id, channel, enabled, handle_cipher, handle_hint, updated_at)
    VALUES (actor, ch, en, h_cipher, h_hint, clock_timestamp())
    ON CONFLICT (member_id, channel) DO UPDATE
      SET enabled = EXCLUDED.enabled,
          handle_cipher = COALESCE(EXCLUDED.handle_cipher, ertad.member_notification_channels.handle_cipher),
          handle_hint = CASE
            WHEN EXCLUDED.handle_hint <> '' THEN EXCLUDED.handle_hint
            ELSE ertad.member_notification_channels.handle_hint
          END,
          updated_at = clock_timestamp();
  END IF;

  RETURN jsonb_build_object(
    'channels', (
      SELECT jsonb_agg(
        jsonb_build_object(
          'channel', def.channel,
          'platformEnabled', COALESCE(pi.enabled, false),
          'enabled', COALESCE(mc.enabled, false),
          'handleHint', COALESCE(mc.handle_hint, ''),
          'updatedAt', mc.updated_at
        ) ORDER BY def.ord
      )
      FROM (
        VALUES
          (1, 'push', 'fcm_push'),
          (2, 'telegram', 'telegram_bot'),
          (3, 'whatsapp', 'whatsapp_business'),
          (4, 'viber', 'viber_bot')
      ) AS def(ord, channel, provider)
      LEFT JOIN ertad.platform_integrations pi ON pi.provider = def.provider
      LEFT JOIN ertad.member_notification_channels mc
        ON mc.member_id = actor AND mc.channel = def.channel
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION
  ertad.platform_integration_command(uuid, text, text, jsonb),
  ertad.mobile_notification_channels_command(uuid, text, text, jsonb)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  ertad.platform_integration_command(uuid, text, text, jsonb),
  ertad.mobile_notification_channels_command(uuid, text, text, jsonb)
TO ertad_app;
