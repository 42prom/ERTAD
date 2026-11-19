-- Account Security Wave 4: interactive TOTP + recovery codes, FIDO2/WebAuthn passkeys,
-- coarse session labels, and opt-in domain notification preferences/outbox.

ALTER TABLE ertad.admin_users
  ADD COLUMN IF NOT EXISTS mfa_user_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pending_mfa_secret_encrypted text CHECK (pending_mfa_secret_encrypted IS NULL OR pending_mfa_secret_encrypted LIKE 'v2:%'),
  ADD COLUMN IF NOT EXISTS mfa_recovery_hashes text[] NOT NULL DEFAULT '{}';

ALTER TABLE ertad.admin_sessions
  ADD COLUMN IF NOT EXISTS client_label text NOT NULL DEFAULT 'Web Browser'
  CHECK (length(trim(client_label)) BETWEEN 1 AND 64);

CREATE TABLE ertad.admin_passkeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid NOT NULL REFERENCES ertad.admin_users(id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE CHECK (length(credential_id) BETWEEN 16 AND 512),
  public_key_spki text NOT NULL CHECK (length(public_key_spki) BETWEEN 64 AND 4096),
  algorithm integer NOT NULL CHECK (algorithm IN (-7, -257)),
  sign_count bigint NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  label text NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 80),
  transports text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz
);

CREATE INDEX admin_passkeys_user_idx ON ertad.admin_passkeys (admin_user_id, created_at DESC);

CREATE TABLE ertad.webauthn_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid REFERENCES ertad.admin_users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('register', 'authenticate', 'step_up')),
  challenge text NOT NULL UNIQUE CHECK (length(challenge) BETWEEN 24 AND 256),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '5 minutes'),
  consumed_at timestamptz
);

CREATE INDEX webauthn_challenges_exp_idx ON ertad.webauthn_challenges (expires_at) WHERE consumed_at IS NULL;

CREATE TABLE ertad.member_notification_preferences (
  admin_user_id uuid PRIMARY KEY REFERENCES ertad.admin_users(id) ON DELETE CASCADE,
  event_reminders boolean NOT NULL DEFAULT false,
  task_deadlines boolean NOT NULL DEFAULT false,
  approval_digests boolean NOT NULL DEFAULT false,
  channel_mentions boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE ertad.domain_notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES ertad.organizations(id) ON DELETE CASCADE,
  admin_user_id uuid NOT NULL REFERENCES ertad.admin_users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('event_reminder_48h', 'task_deadline_24h', 'pending_approval_digest', 'channel_mention')),
  reference_id uuid NOT NULL,
  summary_title text NOT NULL CHECK (length(trim(summary_title)) BETWEEN 1 AND 120),
  scheduled_for timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (admin_user_id, kind, reference_id)
);

CREATE INDEX domain_notification_outbox_user_idx
  ON ertad.domain_notification_outbox (admin_user_id, created_at DESC);

REVOKE ALL ON
  ertad.admin_passkeys,
  ertad.webauthn_challenges,
  ertad.member_notification_preferences,
  ertad.domain_notification_outbox
FROM PUBLIC, ertad_app;

CREATE FUNCTION ertad.lock_own_account_session(
  sid uuid,
  token text,
  require_step_up boolean
) RETURNS TABLE(admin_user_id uuid, email text, mfa_user_verified boolean, mfa_enrolled_at timestamptz, mfa_secret_encrypted text, pending_mfa_secret_encrypted text, mfa_last_counter bigint, mfa_recovery_hashes text[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  s ertad.admin_sessions;
  a ertad.admin_users;
BEGIN
  SELECT * INTO s FROM ertad.admin_sessions WHERE id = sid AND token_hash = token FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Session unavailable';
  END IF;
  SELECT * INTO a FROM ertad.admin_users WHERE id = s.admin_user_id FOR UPDATE;
  IF NOT FOUND OR NOT a.is_active OR (a.locked_until IS NOT NULL AND a.locked_until > clock_timestamp())
     OR s.revoked_at IS NOT NULL OR s.idle_expires_at <= clock_timestamp() OR s.absolute_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Session unavailable';
  END IF;
  IF ertad.web_account_held(a.id) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Session unavailable';
  END IF;
  IF require_step_up AND (s.step_up_expires_at IS NULL OR s.step_up_expires_at <= clock_timestamp()) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0428', MESSAGE = 'Fresh authentication required';
  END IF;
  RETURN QUERY SELECT a.id, a.email::text, a.mfa_user_verified, a.mfa_enrolled_at, a.mfa_secret_encrypted, a.pending_mfa_secret_encrypted, a.mfa_last_counter, a.mfa_recovery_hashes;
END;
$$;

CREATE FUNCTION ertad.own_totp_command(
  sid uuid,
  token text,
  op text,
  payload jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  acc record;
  hashes text[];
  secret_enc text;
  counter_val bigint;
BEGIN
  IF op IS NULL OR op NOT IN ('status', 'setup_begin', 'setup_confirm', 'disable', 'regenerate_recovery') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid TOTP operation';
  END IF;
  SELECT * INTO acc FROM ertad.lock_own_account_session(sid, token, op <> 'status');

  IF op = 'status' THEN
    RETURN jsonb_build_object(
      'adminUserId', acc.admin_user_id,
      'email', acc.email,
      'enabled', acc.mfa_user_verified,
      'pendingSetup', acc.pending_mfa_secret_encrypted IS NOT NULL,
      'enrolledAt', CASE WHEN acc.mfa_user_verified THEN acc.mfa_enrolled_at ELSE NULL END,
      'recoveryRemaining', COALESCE(cardinality(acc.mfa_recovery_hashes), 0)
    );
  ELSIF op = 'setup_begin' THEN
    secret_enc := payload->>'encryptedSecret';
    IF secret_enc IS NULL OR length(secret_enc) < 16 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid secret';
    END IF;
    UPDATE ertad.admin_users
       SET pending_mfa_secret_encrypted = secret_enc,
           updated_at = clock_timestamp()
     WHERE id = acc.admin_user_id;
    RETURN jsonb_build_object('adminUserId', acc.admin_user_id, 'pendingSetup', true);
  ELSIF op = 'setup_confirm' THEN
    counter_val := (payload->>'counter')::bigint;
    IF acc.pending_mfa_secret_encrypted IS NULL OR counter_val IS NULL OR counter_val < 0 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid TOTP state';
    END IF;
    SELECT array_agg(v) INTO hashes FROM jsonb_array_elements_text(payload->'recoveryHashes') v;
    IF COALESCE(cardinality(hashes), 0) <> 8 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Recovery hashes required';
    END IF;
    UPDATE ertad.admin_users
       SET mfa_secret_encrypted = acc.pending_mfa_secret_encrypted,
           pending_mfa_secret_encrypted = NULL,
           mfa_enabled = true,
           mfa_user_verified = true,
           mfa_enrolled_at = clock_timestamp(),
           mfa_last_counter = counter_val,
           mfa_recovery_hashes = hashes,
           updated_at = clock_timestamp()
     WHERE id = acc.admin_user_id;
    RETURN jsonb_build_object(
      'adminUserId', acc.admin_user_id,
      'enabled', true,
      'recoveryRemaining', cardinality(hashes)
    );
  ELSIF op = 'disable' THEN
    UPDATE ertad.admin_users
       SET pending_mfa_secret_encrypted = NULL,
           mfa_enabled = false,
           mfa_enrolled_at = NULL,
           mfa_last_counter = -1,
           mfa_user_verified = false,
           mfa_recovery_hashes = '{}',
           updated_at = clock_timestamp()
     WHERE id = acc.admin_user_id;
    RETURN jsonb_build_object('adminUserId', acc.admin_user_id, 'enabled', false);
  ELSE
    IF NOT acc.mfa_user_verified THEN
      RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'MFA not enrolled';
    END IF;
    SELECT array_agg(v) INTO hashes FROM jsonb_array_elements_text(payload->'recoveryHashes') v;
    IF COALESCE(cardinality(hashes), 0) <> 8 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Recovery hashes required';
    END IF;
    UPDATE ertad.admin_users
       SET mfa_recovery_hashes = hashes,
           updated_at = clock_timestamp()
     WHERE id = acc.admin_user_id;
    RETURN jsonb_build_object('adminUserId', acc.admin_user_id, 'recoveryRemaining', cardinality(hashes));
  END IF;
END;
$$;

CREATE FUNCTION ertad.read_own_totp_secret(sid uuid, token text) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  acc record;
BEGIN
  SELECT * INTO acc FROM ertad.lock_own_account_session(sid, token, true);
  RETURN COALESCE(acc.pending_mfa_secret_encrypted, acc.mfa_secret_encrypted);
END;
$$;

CREATE FUNCTION ertad.consume_mfa_recovery(uid uuid, code_hash text) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  a ertad.admin_users;
  remaining text[];
BEGIN
  SELECT * INTO a FROM ertad.admin_users WHERE id = uid FOR UPDATE;
  IF NOT FOUND OR NOT a.mfa_user_verified OR NOT (code_hash = ANY(a.mfa_recovery_hashes)) THEN
    RETURN false;
  END IF;
  SELECT COALESCE(array_agg(h), '{}') INTO remaining
  FROM unnest(a.mfa_recovery_hashes) AS h
  WHERE h <> code_hash;
  UPDATE ertad.admin_users
     SET mfa_recovery_hashes = remaining,
         updated_at = clock_timestamp()
   WHERE id = uid;
  RETURN true;
END;
$$;

CREATE FUNCTION ertad.own_passkey_command(
  sid uuid,
  token text,
  op text,
  payload jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  acc record;
  cid uuid;
  pk ertad.admin_passkeys;
  existing_count integer;
  chal_text text;
  cred_id text;
  spki text;
  alg integer;
  tr text[];
  lbl text;
BEGIN
  IF op IS NULL OR op NOT IN (
    'list', 'challenge_register', 'challenge_register_read', 'register', 'rename', 'delete', 'challenge_stepup', 'consume_stepup'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid passkey operation';
  END IF;
  SELECT * INTO acc FROM ertad.lock_own_account_session(
    sid,
    token,
    op IN ('challenge_register', 'challenge_register_read', 'register', 'rename', 'delete')
  );

  DELETE FROM ertad.webauthn_challenges WHERE expires_at <= clock_timestamp() - interval '1 hour';

  IF op = 'list' THEN
    RETURN jsonb_build_object(
      'items', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', p.id,
          'label', p.label,
          'algorithm', p.algorithm,
          'transports', to_jsonb(p.transports),
          'createdAt', p.created_at,
          'lastUsedAt', p.last_used_at
        ) ORDER BY p.created_at DESC, p.id DESC)
        FROM ertad.admin_passkeys p
        WHERE p.admin_user_id = acc.admin_user_id
      ), '[]'::jsonb)
    );
  ELSIF op = 'challenge_register' THEN
    chal_text := payload->>'challenge';
    IF chal_text IS NULL OR length(chal_text) < 24 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Challenge required';
    END IF;
    SELECT count(*) INTO existing_count FROM ertad.admin_passkeys WHERE admin_user_id = acc.admin_user_id;
    IF existing_count >= 10 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Passkey limit reached';
    END IF;
    INSERT INTO ertad.webauthn_challenges (admin_user_id, purpose, challenge)
    VALUES (acc.admin_user_id, 'register', chal_text)
    RETURNING id INTO cid;
    RETURN jsonb_build_object(
      'challengeId', cid,
      'challenge', chal_text,
      'adminUserId', acc.admin_user_id,
      'email', acc.email,
      'excludeCredentialIds', COALESCE((
        SELECT jsonb_agg(p.credential_id)
        FROM ertad.admin_passkeys p
        WHERE p.admin_user_id = acc.admin_user_id
      ), '[]'::jsonb)
    );
  ELSIF op = 'challenge_register_read' THEN
    cid := (payload->>'challengeId')::uuid;
    SELECT c.challenge INTO chal_text
    FROM ertad.webauthn_challenges c
    WHERE c.id = cid
      AND c.admin_user_id = acc.admin_user_id
      AND c.purpose = 'register'
      AND c.consumed_at IS NULL
      AND c.expires_at > clock_timestamp();
    IF chal_text IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Challenge unavailable';
    END IF;
    RETURN jsonb_build_object('challenge', chal_text);
  ELSIF op = 'register' THEN
    cid := (payload->>'challengeId')::uuid;
    cred_id := payload->>'credentialId';
    spki := payload->>'publicKeySpki';
    alg := (payload->>'algorithm')::integer;
    lbl := trim(COALESCE(payload->>'label', ''));
    SELECT COALESCE(array_agg(v), '{}') INTO tr FROM jsonb_array_elements_text(COALESCE(payload->'transports', '[]'::jsonb)) v;
    IF cid IS NULL OR cred_id IS NULL OR spki IS NULL OR lbl = '' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid passkey payload';
    END IF;
    UPDATE ertad.webauthn_challenges
       SET consumed_at = clock_timestamp()
     WHERE id = cid
       AND admin_user_id = acc.admin_user_id
       AND purpose = 'register'
       AND consumed_at IS NULL
       AND expires_at > clock_timestamp();
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Challenge unavailable';
    END IF;
    INSERT INTO ertad.admin_passkeys (admin_user_id, credential_id, public_key_spki, algorithm, sign_count, label, transports)
    VALUES (
      acc.admin_user_id,
      cred_id,
      spki,
      alg,
      GREATEST(0, COALESCE((payload->>'signCount')::bigint, 0)),
      lbl,
      tr
    )
    RETURNING * INTO pk;
    RETURN jsonb_build_object(
      'adminUserId', acc.admin_user_id,
      'id', pk.id,
      'label', pk.label,
      'createdAt', pk.created_at
    );
  ELSIF op = 'rename' THEN
    lbl := trim(COALESCE(payload->>'label', ''));
    UPDATE ertad.admin_passkeys
       SET label = lbl
     WHERE id = (payload->>'passkeyId')::uuid AND admin_user_id = acc.admin_user_id
     RETURNING * INTO pk;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0404', MESSAGE = 'Passkey not found';
    END IF;
    RETURN jsonb_build_object('adminUserId', acc.admin_user_id, 'id', pk.id, 'label', pk.label);
  ELSIF op = 'delete' THEN
    DELETE FROM ertad.admin_passkeys
     WHERE id = (payload->>'passkeyId')::uuid AND admin_user_id = acc.admin_user_id
     RETURNING * INTO pk;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0404', MESSAGE = 'Passkey not found';
    END IF;
    RETURN jsonb_build_object('adminUserId', acc.admin_user_id, 'deletedId', pk.id);
  ELSIF op = 'challenge_stepup' THEN
    chal_text := payload->>'challenge';
    INSERT INTO ertad.webauthn_challenges (admin_user_id, purpose, challenge)
    VALUES (acc.admin_user_id, 'step_up', chal_text)
    RETURNING id INTO cid;
    RETURN jsonb_build_object(
      'challengeId', cid,
      'challenge', chal_text,
      'allowCredentialIds', COALESCE((
        SELECT jsonb_agg(p.credential_id)
        FROM ertad.admin_passkeys p
        WHERE p.admin_user_id = acc.admin_user_id
      ), '[]'::jsonb)
    );
  ELSE
    -- consume_stepup lookup or complete
    cid := (payload->>'challengeId')::uuid;
    cred_id := payload->>'credentialId';
    IF payload ? 'lookupOnly' AND (payload->>'lookupOnly')::boolean THEN
      SELECT * INTO pk FROM ertad.admin_passkeys WHERE credential_id = cred_id AND admin_user_id = acc.admin_user_id FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Passkey not found';
      END IF;
      RETURN jsonb_build_object(
        'publicKeySpki', pk.public_key_spki,
        'algorithm', pk.algorithm,
        'signCount', pk.sign_count,
        'challenge', (
          SELECT c.challenge FROM ertad.webauthn_challenges c
          WHERE c.id = cid AND c.admin_user_id = acc.admin_user_id AND c.purpose = 'step_up'
            AND c.consumed_at IS NULL AND c.expires_at > clock_timestamp()
        )
      );
    END IF;
    UPDATE ertad.webauthn_challenges
       SET consumed_at = clock_timestamp()
     WHERE id = cid AND admin_user_id = acc.admin_user_id AND purpose = 'step_up'
       AND consumed_at IS NULL AND expires_at > clock_timestamp();
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0409', MESSAGE = 'Challenge unavailable';
    END IF;
    UPDATE ertad.admin_passkeys
       SET sign_count = GREATEST(sign_count, COALESCE((payload->>'nextSignCount')::bigint, sign_count)),
           last_used_at = clock_timestamp()
     WHERE credential_id = cred_id AND admin_user_id = acc.admin_user_id;
    UPDATE ertad.admin_sessions
       SET step_up_expires_at = clock_timestamp() + interval '5 minutes'
     WHERE id = sid AND token_hash = token;
    RETURN jsonb_build_object('adminUserId', acc.admin_user_id, 'steppedUp', true);
  END IF;
END;
$$;

CREATE FUNCTION ertad.passkey_login_challenge(chal_text text) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  cid uuid;
BEGIN
  IF chal_text IS NULL OR length(chal_text) < 24 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid challenge';
  END IF;
  DELETE FROM ertad.webauthn_challenges WHERE expires_at <= clock_timestamp() - interval '1 hour';
  INSERT INTO ertad.webauthn_challenges (admin_user_id, purpose, challenge)
  VALUES (NULL, 'authenticate', chal_text)
  RETURNING id INTO cid;
  RETURN jsonb_build_object('challengeId', cid, 'challenge', chal_text);
END;
$$;

CREATE FUNCTION ertad.passkey_login_lookup(cid uuid, cred_id text) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  c ertad.webauthn_challenges;
  pk ertad.admin_passkeys;
  a ertad.admin_users;
BEGIN
  SELECT * INTO c FROM ertad.webauthn_challenges
   WHERE id = cid AND purpose = 'authenticate' AND consumed_at IS NULL AND expires_at > clock_timestamp();
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT * INTO pk FROM ertad.admin_passkeys WHERE credential_id = cred_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT * INTO a FROM ertad.admin_users WHERE id = pk.admin_user_id;
  IF NOT FOUND OR NOT a.is_active OR (a.locked_until IS NOT NULL AND a.locked_until > clock_timestamp())
     OR ertad.web_account_held(a.id) THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object(
    'challenge', c.challenge,
    'publicKeySpki', pk.public_key_spki,
    'algorithm', pk.algorithm,
    'signCount', pk.sign_count,
    'adminUserId', a.id,
    'email', a.email,
    'role', a.role,
    'fullName', a.full_name,
    'passwordHash', a.password_hash
  );
END;
$$;

CREATE FUNCTION ertad.passkey_login_consume(cid uuid, cred_id text, next_sign_count bigint) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  pk ertad.admin_passkeys;
BEGIN
  UPDATE ertad.webauthn_challenges
     SET consumed_at = clock_timestamp()
   WHERE id = cid AND purpose = 'authenticate' AND consumed_at IS NULL AND expires_at > clock_timestamp();
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE ertad.admin_passkeys
     SET sign_count = GREATEST(sign_count, next_sign_count),
         last_used_at = clock_timestamp()
   WHERE credential_id = cred_id
   RETURNING * INTO pk;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE ertad.admin_users
     SET last_login_at = clock_timestamp(),
         updated_at = clock_timestamp()
   WHERE id = pk.admin_user_id;
  RETURN true;
END;
$$;

CREATE FUNCTION ertad.own_notifications_command(
  sid uuid,
  token text,
  op text,
  payload jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  acc record;
  prefs ertad.member_notification_preferences;
  queued integer := 0;
BEGIN
  IF op IS NULL OR op NOT IN ('read', 'update', 'sync_outbox') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid notification operation';
  END IF;
  SELECT * INTO acc FROM ertad.lock_own_account_session(sid, token, false);

  INSERT INTO ertad.member_notification_preferences (admin_user_id)
  VALUES (acc.admin_user_id)
  ON CONFLICT (admin_user_id) DO NOTHING;

  IF op = 'update' THEN
    UPDATE ertad.member_notification_preferences
       SET event_reminders = COALESCE((payload->>'eventReminders')::boolean, event_reminders),
           task_deadlines = COALESCE((payload->>'taskDeadlines')::boolean, task_deadlines),
           approval_digests = COALESCE((payload->>'approvalDeadlines')::boolean, (payload->>'approvalDigests')::boolean, approval_digests),
           channel_mentions = COALESCE((payload->>'channelMentions')::boolean, channel_mentions),
           updated_at = clock_timestamp()
     WHERE admin_user_id = acc.admin_user_id;
  END IF;

  SELECT * INTO prefs
  FROM ertad.member_notification_preferences
  WHERE admin_user_id = acc.admin_user_id;

  IF op = 'sync_outbox' THEN
    IF prefs.event_reminders THEN
      WITH inserted AS (
        INSERT INTO ertad.domain_notification_outbox (organization_id, admin_user_id, kind, reference_id, summary_title)
        SELECT DISTINCT m.organization_id, acc.admin_user_id, 'event_reminder_48h', e.id, 'Upcoming event within 48h'
        FROM ertad.member_users mu
        JOIN ertad.memberships m ON m.user_id = mu.id AND m.status = 'active' AND m.valid_from <= clock_timestamp() AND m.valid_until > clock_timestamp()
        JOIN ertad.mobilization_events e ON e.organization_id = m.organization_id AND e.status = 'open'
          AND e.starts_at > clock_timestamp() AND e.starts_at <= clock_timestamp() + interval '48 hours'
        WHERE mu.web_account_id = acc.admin_user_id
        ON CONFLICT (admin_user_id, kind, reference_id) DO NOTHING
        RETURNING 1
      )
      SELECT queued + count(*) INTO queued FROM inserted;
    END IF;

    IF prefs.task_deadlines THEN
      WITH inserted AS (
        INSERT INTO ertad.domain_notification_outbox (organization_id, admin_user_id, kind, reference_id, summary_title)
        SELECT DISTINCT m.organization_id, acc.admin_user_id, 'task_deadline_24h', w.id, 'Task deadline within 24h'
        FROM ertad.member_users mu
        JOIN ertad.memberships m ON m.user_id = mu.id AND m.status = 'active' AND m.valid_from <= clock_timestamp() AND m.valid_until > clock_timestamp()
        JOIN ertad.work_items w ON w.organization_id = m.organization_id AND w.status = 'open'
          AND w.deadline > clock_timestamp() AND w.deadline <= clock_timestamp() + interval '24 hours'
        WHERE mu.web_account_id = acc.admin_user_id
        ON CONFLICT (admin_user_id, kind, reference_id) DO NOTHING
        RETURNING 1
      )
      SELECT queued + count(*) INTO queued FROM inserted;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'adminUserId', acc.admin_user_id,
    'preferences', jsonb_build_object(
      'eventReminders', prefs.event_reminders,
      'taskDeadlines', prefs.task_deadlines,
      'approvalDigests', prefs.approval_digests,
      'channelMentions', prefs.channel_mentions,
      'updatedAt', prefs.updated_at
    ),
    'newlyQueued', queued,
    'recentQueued', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', o.id,
        'kind', o.kind,
        'title', o.summary_title,
        'scheduledFor', o.scheduled_for,
        'deliveredAt', o.delivered_at
      ) ORDER BY o.created_at DESC, o.id DESC)
      FROM (
        SELECT id, kind, summary_title, scheduled_for, delivered_at, created_at
        FROM ertad.domain_notification_outbox
        WHERE admin_user_id = acc.admin_user_id
        ORDER BY created_at DESC, id DESC
        LIMIT 15
      ) o
    ), '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION ertad.lock_own_account_session(uuid, text, boolean) FROM PUBLIC, ertad_app;
REVOKE ALL ON FUNCTION
  ertad.own_totp_command(uuid, text, text, jsonb),
  ertad.read_own_totp_secret(uuid, text),
  ertad.consume_mfa_recovery(uuid, text),
  ertad.own_passkey_command(uuid, text, text, jsonb),
  ertad.passkey_login_challenge(text),
  ertad.passkey_login_lookup(uuid, text),
  ertad.passkey_login_consume(uuid, text, bigint),
  ertad.own_notifications_command(uuid, text, text, jsonb)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  ertad.own_totp_command(uuid, text, text, jsonb),
  ertad.read_own_totp_secret(uuid, text),
  ertad.consume_mfa_recovery(uuid, text),
  ertad.own_passkey_command(uuid, text, text, jsonb),
  ertad.passkey_login_challenge(text),
  ertad.passkey_login_lookup(uuid, text),
  ertad.passkey_login_consume(uuid, text, bigint),
  ertad.own_notifications_command(uuid, text, text, jsonb)
TO ertad_app;
