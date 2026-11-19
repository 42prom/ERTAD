-- M4-D: Multi-Channel Notification Outbox Dispatcher (Push / Telegram / WhatsApp / Viber)
-- + Runtime Google OIDC public config reader for /mobile/m4/google/bind.
-- Reuses ertad.domain_notification_outbox with per-channel lease/retry tracking.

CREATE TABLE IF NOT EXISTS ertad.notification_channel_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id uuid NOT NULL REFERENCES ertad.domain_notification_outbox(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES ertad.member_users(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('push', 'telegram', 'whatsapp', 'viber')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'skipped')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_expires_at timestamptz,
  last_error text NOT NULL DEFAULT '' CHECK (length(last_error) <= 240),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (outbox_id, channel)
);

CREATE INDEX IF NOT EXISTS notification_channel_deliveries_due_idx
  ON ertad.notification_channel_deliveries (status, next_attempt_at);

REVOKE ALL ON TABLE ertad.notification_channel_deliveries FROM PUBLIC;

CREATE OR REPLACE FUNCTION ertad.enqueue_member_notification(
  p_member_id uuid,
  p_kind text,
  p_reference_id uuid,
  p_summary_title text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_admin_user_id uuid;
  v_outbox_id uuid;
  v_enqueued integer := 0;
BEGIN
  IF p_member_id IS NULL OR p_reference_id IS NULL OR length(btrim(COALESCE(p_summary_title, ''))) = 0 THEN
    RETURN 0;
  END IF;

  SELECT aml.admin_user_id INTO v_admin_user_id
  FROM ertad.admin_member_links aml
  WHERE aml.member_user_id = p_member_id
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  INSERT INTO ertad.domain_notification_outbox (
    admin_user_id, kind, reference_id, summary_title
  ) VALUES (
    v_admin_user_id, p_kind, p_reference_id, left(btrim(p_summary_title), 120)
  )
  ON CONFLICT (admin_user_id, kind, reference_id) DO NOTHING
  RETURNING id INTO v_outbox_id;

  IF v_outbox_id IS NULL THEN
    SELECT id INTO v_outbox_id
    FROM ertad.domain_notification_outbox
    WHERE admin_user_id = v_admin_user_id AND kind = p_kind AND reference_id = p_reference_id;
  END IF;

  IF v_outbox_id IS NULL THEN
    RETURN 0;
  END IF;

  WITH inserted AS (
    INSERT INTO ertad.notification_channel_deliveries (outbox_id, member_id, channel)
    SELECT v_outbox_id, p_member_id, def.channel
    FROM (
      VALUES
        ('push', 'fcm_push'),
        ('telegram', 'telegram_bot'),
        ('whatsapp', 'whatsapp_business'),
        ('viber', 'viber_bot')
    ) AS def(channel, provider)
    JOIN ertad.member_notification_channels mc
      ON mc.member_id = p_member_id AND mc.channel = def.channel AND mc.enabled = true
    JOIN ertad.platform_integrations pi
      ON pi.provider = def.provider AND pi.enabled = true AND pi.secret_cipher IS NOT NULL
    WHERE (def.channel = 'push' OR mc.handle_cipher IS NOT NULL)
    ON CONFLICT (outbox_id, channel) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::int INTO v_enqueued FROM inserted;

  RETURN v_enqueued;
END;
$$;

CREATE OR REPLACE FUNCTION ertad.claim_notification_deliveries(
  p_limit integer DEFAULT 20
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 20), 100));
  v_items jsonb;
BEGIN
  WITH due AS (
    SELECT d.id
    FROM ertad.notification_channel_deliveries d
    WHERE (
      (d.status = 'queued' AND d.next_attempt_at <= clock_timestamp())
      OR (d.status = 'sending' AND d.lease_expires_at IS NOT NULL AND d.lease_expires_at <= clock_timestamp())
    )
    ORDER BY d.next_attempt_at ASC
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    UPDATE ertad.notification_channel_deliveries d
    SET status = 'sending',
        attempts = d.attempts + 1,
        lease_expires_at = clock_timestamp() + interval '2 minutes'
    FROM due
    WHERE d.id = due.id
    RETURNING d.*
  )
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'deliveryId', c.id,
      'outboxId', c.outbox_id,
      'channel', c.channel,
      'attempts', c.attempts,
      'kind', o.kind,
      'title', o.summary_title,
      'handleCipher', mc.handle_cipher,
      'publicConfig', pi.public_config,
      'secretCipher', pi.secret_cipher
    )
  ), '[]'::jsonb)
  INTO v_items
  FROM claimed c
  JOIN ertad.domain_notification_outbox o ON o.id = c.outbox_id
  LEFT JOIN ertad.member_notification_channels mc
    ON mc.member_id = c.member_id AND mc.channel = c.channel
  LEFT JOIN ertad.platform_integrations pi
    ON pi.provider = CASE c.channel
      WHEN 'push' THEN 'fcm_push'
      WHEN 'telegram' THEN 'telegram_bot'
      WHEN 'whatsapp' THEN 'whatsapp_business'
      WHEN 'viber' THEN 'viber_bot'
    END;

  RETURN v_items;
END;
$$;

CREATE OR REPLACE FUNCTION ertad.complete_notification_delivery(
  p_delivery_id uuid,
  p_outcome text,
  p_error text DEFAULT '',
  p_retry_seconds integer DEFAULT 60
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_row ertad.notification_channel_deliveries%ROWTYPE;
BEGIN
  IF p_outcome NOT IN ('sent', 'retry', 'failed', 'skipped') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid delivery outcome';
  END IF;

  SELECT * INTO v_row
  FROM ertad.notification_channel_deliveries
  WHERE id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF p_outcome = 'sent' THEN
    UPDATE ertad.notification_channel_deliveries
    SET status = 'sent',
        sent_at = clock_timestamp(),
        lease_expires_at = NULL,
        last_error = ''
    WHERE id = p_delivery_id;

    IF NOT EXISTS (
      SELECT 1 FROM ertad.notification_channel_deliveries
      WHERE outbox_id = v_row.outbox_id AND status IN ('queued', 'sending')
    ) THEN
      UPDATE ertad.domain_notification_outbox
      SET delivered_at = COALESCE(delivered_at, clock_timestamp())
      WHERE id = v_row.outbox_id;
    END IF;
  ELSIF p_outcome = 'retry' AND v_row.attempts < 5 THEN
    UPDATE ertad.notification_channel_deliveries
    SET status = 'queued',
        next_attempt_at = clock_timestamp() + make_interval(secs => GREATEST(10, LEAST(COALESCE(p_retry_seconds, 60), 3600))),
        lease_expires_at = NULL,
        last_error = left(COALESCE(p_error, ''), 240)
    WHERE id = p_delivery_id;
  ELSE
    UPDATE ertad.notification_channel_deliveries
    SET status = CASE WHEN p_outcome = 'skipped' THEN 'skipped' ELSE 'failed' END,
        lease_expires_at = NULL,
        last_error = left(COALESCE(p_error, ''), 240)
    WHERE id = p_delivery_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION ertad.get_google_oidc_runtime_config()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT COALESCE(
    (
      SELECT jsonb_build_object(
        'enabled', pi.enabled,
        'publicConfig', pi.public_config
      )
      FROM ertad.platform_integrations pi
      WHERE pi.provider = 'google_oidc'
    ),
    jsonb_build_object('enabled', false, 'publicConfig', '{}'::jsonb)
  )
$$;

REVOKE ALL ON FUNCTION
  ertad.enqueue_member_notification(uuid, text, uuid, text),
  ertad.claim_notification_deliveries(integer),
  ertad.complete_notification_delivery(uuid, text, text, integer),
  ertad.get_google_oidc_runtime_config()
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  ertad.enqueue_member_notification(uuid, text, uuid, text),
  ertad.claim_notification_deliveries(integer),
  ertad.complete_notification_delivery(uuid, text, text, integer),
  ertad.get_google_oidc_runtime_config()
TO ertad_app;
