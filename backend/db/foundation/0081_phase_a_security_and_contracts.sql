-- Phase A Security, Privacy & Contract Repairs:
-- 1. Enforce strict web vs mobile session class separation (I11).
-- 2. Restore 0033 platform_integration_command and isolate M4 external integrations command.
-- 3. Restore device attestation verdict & ISO-3 'GEO' citizenship checks in mobile_m4_command.
-- 4. Fix enqueue_member_notification member/organization resolution and unit-scope outbox sync (I9).
-- 5. Clamp passkey step-up expiry to session absolute_expires_at.
-- 6. Prevent single-voter anonymous ballot de-anonymization when participation = 1.

ALTER TABLE ertad.admin_sessions
  ADD COLUMN IF NOT EXISTS session_kind text NOT NULL DEFAULT 'web'
  CHECK (session_kind IN ('web', 'mobile'));

CREATE OR REPLACE FUNCTION ertad.platform_external_integration_command(
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
  account uuid;
  capabilities text[];
  result text := input->>'status';
  target text := input->>'target';
BEGIN
  IF op IS NULL OR op NOT IN ('integrations', 'integrationCheck') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid integration command';
  END IF;
  PERFORM ertad.platform_console_command(sid, token, 'overview', '{}');
  SELECT admin_user_id INTO account FROM ertad.admin_sessions WHERE id = sid;
  SELECT permissions INTO capabilities FROM ertad.platform_accounts WHERE admin_user_id = account;
  IF NOT ('platform.integrations.read' = ANY(capabilities))
     OR (op = 'integrationCheck' AND NOT ('platform.integrations.test' = ANY(capabilities))) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
  END IF;
  IF op = 'integrationCheck'
     AND (target IS NULL OR target NOT IN ('postgres', 'redis', 'storage')
          OR result IS NULL OR result NOT IN ('requested', 'ready', 'unavailable', 'not_configured')) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid diagnostic';
  END IF;
  RETURN jsonb_build_object(
    'data', jsonb_build_object('checkedAt', clock_timestamp()),
    'audit', jsonb_strip_nulls(jsonb_build_object('adminUserId', account, 'operation', op, 'target', target, 'status', result))
  );
END;
$$;

REVOKE ALL ON FUNCTION
  ertad.platform_external_integration_command(uuid, text, text, jsonb),
  ertad.platform_integration_command(uuid, text, text, jsonb)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  ertad.platform_external_integration_command(uuid, text, text, jsonb),
  ertad.platform_integration_command(uuid, text, text, jsonb)
TO ertad_app;

CREATE OR REPLACE FUNCTION ertad.mobile_m4_command(
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
  pol ertad.verification_infrastructure_policies%ROWTYPE;
  proof ertad.member_identity_proofs%ROWTYPE;
  chal ertad.mobile_attestation_challenges%ROWTYPE;
  binding ertad.mobile_device_bindings%ROWTYPE;
  ref_row ertad.member_referrals%ROWTYPE;
  l2_member uuid;
  nonce_val text;
  dev_id text;
  plat text;
  verdict_val text;
  counter_val bigint;
  live_score numeric(4,3);
  match_score numeric(4,3);
  sod_ok boolean;
  country_val text;
  uniq_hash text;
  tmpl_cipher text;
  tmpl_digest text;
  port_cipher text;
  bsess_id uuid;
BEGIN
  IF op IS NULL OR op NOT IN ('status', 'issue_challenge', 'verify_attestation', 'bind_google', 'complete_biometric', 'verify_reauth') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid M4 mobile command';
  END IF;

  actor := ertad.review_identity(sid, token, false);
  SELECT * INTO pol FROM ertad.verification_infrastructure_policies WHERE id = 1;

  IF op = 'status' THEN
    PERFORM ertad.purge_expired_biometric_sessions();
    SELECT * INTO proof FROM ertad.member_identity_proofs WHERE member_id = actor;
    RETURN jsonb_build_object(
      'authProfile', pol.auth_profile,
      'requireDeviceAttestation', pol.require_device_attestation,
      'requireNfc', pol.require_nfc,
      'requireGeorgianCitizen', pol.require_georgian_citizen,
      'assuranceLevel', COALESCE(proof.assurance_level, 'google_scoped'),
      'sodCscaVerified', COALESCE(proof.sod_csca_verified, false),
      'hasStoredTemplate', (proof.biometric_template_cipher IS NOT NULL),
      'hasPortrait', (proof.portrait_cipher IS NOT NULL),
      'verifiedAt', proof.verified_at,
      'biometricTtlSeconds', pol.biometric_ttl_seconds
    );
  END IF;

  IF op = 'issue_challenge' THEN
    nonce_val := input->>'nonce';
    plat := input->>'platform';
    INSERT INTO ertad.mobile_attestation_challenges (nonce, member_id, platform, expires_at)
    VALUES (nonce_val, actor, plat, clock_timestamp() + interval '5 minutes');
    RETURN jsonb_build_object('nonce', nonce_val, 'expiresInSeconds', 300);
  END IF;

  IF op = 'verify_attestation' THEN
    nonce_val := input->>'nonce';
    dev_id := input->>'deviceId';
    plat := input->>'platform';
    verdict_val := input->>'verdict';
    counter_val := COALESCE((input->>'counter')::bigint, 0);

    SELECT * INTO chal
    FROM ertad.mobile_attestation_challenges
    WHERE nonce = nonce_val AND member_id = actor AND platform = plat
    FOR UPDATE;

    IF NOT FOUND OR chal.consumed_at IS NOT NULL OR chal.expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Attestation challenge invalid or expired';
    END IF;

    UPDATE ertad.mobile_attestation_challenges
    SET consumed_at = clock_timestamp()
    WHERE nonce = nonce_val;

    SELECT * INTO binding
    FROM ertad.mobile_device_bindings
    WHERE member_id = actor AND device_id = dev_id
    FOR UPDATE;

    IF FOUND AND binding.status <> 'active' THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Device binding is held or revoked';
    END IF;

    IF FOUND AND counter_val < binding.attestation_counter THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Stale attestation counter';
    END IF;

    INSERT INTO ertad.mobile_device_bindings (
      member_id, device_id, platform, app_id, key_id_hash, attestation_verdict, attestation_counter, last_attested_at
    ) VALUES (
      actor, dev_id, plat, input->>'appId', input->>'keyIdHash', verdict_val, counter_val, clock_timestamp()
    )
    ON CONFLICT (member_id, device_id) DO UPDATE
      SET app_id = EXCLUDED.app_id,
          key_id_hash = EXCLUDED.key_id_hash,
          attestation_verdict = EXCLUDED.attestation_verdict,
          attestation_counter = EXCLUDED.attestation_counter,
          last_attested_at = clock_timestamp()
    RETURNING * INTO binding;

    RETURN jsonb_build_object('bindingId', binding.id, 'status', binding.status, 'verdict', binding.attestation_verdict);
  END IF;

  IF op = 'bind_google' THEN
    INSERT INTO ertad.member_identity_proofs (member_id, google_sub_hash, assurance_level, updated_at)
    VALUES (actor, input->>'googleSubHash', 'google_scoped', clock_timestamp())
    ON CONFLICT (member_id) DO UPDATE
      SET google_sub_hash = COALESCE(ertad.member_identity_proofs.google_sub_hash, EXCLUDED.google_sub_hash),
          updated_at = clock_timestamp()
    RETURNING * INTO proof;
    RETURN jsonb_build_object('assuranceLevel', proof.assurance_level);
  END IF;

  IF op = 'verify_reauth' THEN
    SELECT * INTO proof FROM ertad.member_identity_proofs WHERE member_id = actor;
    IF NOT FOUND OR proof.assurance_level <> 'biometric_verified' OR proof.biometric_template_cipher IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Stored biometric template required';
    END IF;

    live_score := (input->>'livenessScore')::numeric(4,3);
    match_score := (input->>'faceMatchScore')::numeric(4,3);
    IF live_score < pol.liveness_min_score OR match_score < pol.face_match_min_score THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Biometric re-authentication threshold not met';
    END IF;

    UPDATE ertad.member_identity_proofs
    SET updated_at = clock_timestamp()
    WHERE member_id = actor;

    RETURN jsonb_build_object(
      'reauthenticated', true,
      'assuranceLevel', proof.assurance_level,
      'templateVersion', proof.biometric_template_version,
      'verifiedAt', proof.verified_at
    );
  END IF;

  IF op = 'complete_biometric' THEN
    PERFORM ertad.purge_expired_biometric_sessions();

    IF pol.require_device_attestation THEN
      dev_id := NULLIF(input->>'deviceId', '');
      IF dev_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Active device attestation required';
      END IF;
      SELECT * INTO binding
      FROM ertad.mobile_device_bindings
      WHERE member_id = actor AND device_id = dev_id AND status = 'active' AND attestation_verdict IN ('strong', 'basic');
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Active device attestation required';
      END IF;
    END IF;

    sod_ok := COALESCE((input->>'sodCscaVerified')::boolean, false);
    country_val := upper(trim(COALESCE(input->>'citizenshipCountry', '')));
    live_score := (input->>'livenessScore')::numeric(4,3);
    match_score := (input->>'faceMatchScore')::numeric(4,3);
    uniq_hash := input->>'personUniquenessHash';
    tmpl_cipher := NULLIF(btrim(COALESCE(input->>'biometricTemplateCipher', '')), '');
    tmpl_digest := NULLIF(btrim(COALESCE(input->>'biometricTemplateDigest', '')), '');
    port_cipher := NULLIF(btrim(COALESCE(input->>'portraitCipher', '')), '');

    IF pol.require_nfc AND NOT sod_ok THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Valid eID NFC SOD/CSCA signature required';
    END IF;
    IF pol.require_georgian_citizen AND country_val NOT IN ('GE', 'GEO') THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Georgian citizenship required by verification policy';
    END IF;
    IF live_score < pol.liveness_min_score OR match_score < pol.face_match_min_score THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Biometric threshold not met';
    END IF;

    IF EXISTS (
      SELECT 1 FROM ertad.member_identity_proofs
      WHERE person_uniqueness_hash = uniq_hash AND member_id <> actor
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'Duplicate person uniqueness proof';
    END IF;

    INSERT INTO ertad.biometric_verification_sessions (
      member_id, device_binding_id, status, sod_csca_verified, liveness_score, face_match_score, expires_at
    ) VALUES (
      actor, binding.id, 'passed', sod_ok, live_score, match_score,
      clock_timestamp() + make_interval(secs => pol.biometric_ttl_seconds)
    )
    RETURNING id INTO bsess_id;

    INSERT INTO ertad.member_identity_proofs (
      member_id, person_uniqueness_hash, assurance_level, citizenship_country,
      sod_csca_verified, liveness_score, face_match_score,
      biometric_template_cipher, biometric_template_digest, portrait_cipher,
      verified_at, updated_at
    ) VALUES (
      actor, uniq_hash, 'biometric_verified', country_val,
      sod_ok, live_score, match_score,
      tmpl_cipher, tmpl_digest, port_cipher,
      clock_timestamp(), clock_timestamp()
    )
    ON CONFLICT (member_id) DO UPDATE
      SET person_uniqueness_hash = EXCLUDED.person_uniqueness_hash,
          assurance_level = 'biometric_verified',
          citizenship_country = EXCLUDED.citizenship_country,
          sod_csca_verified = EXCLUDED.sod_csca_verified,
          liveness_score = EXCLUDED.liveness_score,
          face_match_score = EXCLUDED.face_match_score,
          biometric_template_cipher = COALESCE(EXCLUDED.biometric_template_cipher, ertad.member_identity_proofs.biometric_template_cipher),
          biometric_template_digest = COALESCE(EXCLUDED.biometric_template_digest, ertad.member_identity_proofs.biometric_template_digest),
          biometric_template_version = ertad.member_identity_proofs.biometric_template_version + CASE WHEN EXCLUDED.biometric_template_cipher IS NOT NULL THEN 1 ELSE 0 END,
          portrait_cipher = COALESCE(EXCLUDED.portrait_cipher, ertad.member_identity_proofs.portrait_cipher),
          verified_at = clock_timestamp(),
          updated_at = clock_timestamp()
    RETURNING * INTO proof;

    UPDATE ertad.member_referrals
    SET verified_at = clock_timestamp()
    WHERE invitee_id = actor AND verified_at IS NULL
    RETURNING * INTO ref_row;

    IF FOUND THEN
      PERFORM ertad.referral_issue_reward(ref_row.organization_id, ref_row.unit_id, ref_row.referrer_id, 'referral_verified', actor);
      SELECT referrer_id INTO l2_member
      FROM ertad.member_referrals
      WHERE invitee_id = ref_row.referrer_id;
      IF FOUND THEN
        PERFORM ertad.referral_issue_reward(ref_row.organization_id, ref_row.unit_id, l2_member, 'referral_l2_verified', actor);
      END IF;
    END IF;

    RETURN jsonb_build_object(
      'sessionId', bsess_id,
      'assuranceLevel', proof.assurance_level,
      'hasStoredTemplate', (proof.biometric_template_cipher IS NOT NULL),
      'hasPortrait', (proof.portrait_cipher IS NOT NULL),
      'verifiedAt', proof.verified_at
    );
  END IF;

  RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Unhandled M4 command';
END;
$$;

REVOKE ALL ON FUNCTION ertad.mobile_m4_command(uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.mobile_m4_command(uuid, text, text, jsonb) TO ertad_app;

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
  v_org_id uuid;
  v_outbox_id uuid;
  v_enqueued integer := 0;
BEGIN
  IF p_member_id IS NULL OR p_reference_id IS NULL OR length(btrim(COALESCE(p_summary_title, ''))) = 0 THEN
    RETURN 0;
  END IF;

  SELECT mu.web_account_id INTO v_admin_user_id
  FROM ertad.member_users mu
  WHERE mu.id = p_member_id AND mu.status = 'active';
  IF NOT FOUND OR v_admin_user_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT m.organization_id INTO v_org_id
  FROM ertad.memberships m
  JOIN ertad.organizations o ON o.id = m.organization_id AND o.status = 'active'
  WHERE m.user_id = p_member_id
    AND m.status = 'active'
    AND m.valid_from <= clock_timestamp()
    AND (m.valid_until IS NULL OR m.valid_until > clock_timestamp())
  ORDER BY m.valid_from DESC
  LIMIT 1;
  IF NOT FOUND OR v_org_id IS NULL THEN
    RETURN 0;
  END IF;

  INSERT INTO ertad.domain_notification_outbox (
    organization_id, admin_user_id, kind, reference_id, summary_title
  ) VALUES (
    v_org_id, v_admin_user_id, p_kind, p_reference_id, left(btrim(p_summary_title), 120)
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

REVOKE ALL ON FUNCTION ertad.enqueue_member_notification(uuid, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.enqueue_member_notification(uuid, text, uuid, text) TO ertad_app;

CREATE OR REPLACE FUNCTION ertad.own_notifications_command(
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
        JOIN ertad.memberships m ON m.user_id = mu.id AND m.status = 'active'
          AND m.valid_from <= clock_timestamp() AND (m.valid_until IS NULL OR m.valid_until > clock_timestamp())
        JOIN ertad.organizations o ON o.id = m.organization_id AND o.status = 'active'
        JOIN ertad.positions p ON p.organization_id = m.organization_id AND p.id = m.position_id AND p.status = 'active'
        JOIN ertad.mobilization_events e ON e.organization_id = m.organization_id AND e.status = 'open'
          AND e.starts_at > clock_timestamp() AND e.starts_at <= clock_timestamp() + interval '48 hours'
        WHERE mu.web_account_id = acc.admin_user_id
          AND mu.status = 'active'
          AND ertad.event_visible(mu.id, e)
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
        JOIN ertad.memberships m ON m.user_id = mu.id AND m.status = 'active'
          AND m.valid_from <= clock_timestamp() AND (m.valid_until IS NULL OR m.valid_until > clock_timestamp())
        JOIN ertad.organizations o ON o.id = m.organization_id AND o.status = 'active'
        JOIN ertad.positions p ON p.organization_id = m.organization_id AND p.id = m.position_id AND p.status = 'active'
        JOIN ertad.work_items w ON w.organization_id = m.organization_id AND w.status = 'open'
          AND w.deadline > clock_timestamp() AND w.deadline <= clock_timestamp() + interval '24 hours'
        WHERE mu.web_account_id = acc.admin_user_id
          AND mu.status = 'active'
          AND ertad.work_visible(mu.id, w)
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

REVOKE ALL ON FUNCTION ertad.own_notifications_command(uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.own_notifications_command(uuid, text, text, jsonb) TO ertad_app;

CREATE OR REPLACE FUNCTION ertad.own_passkey_command(
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
       SET step_up_expires_at = LEAST(absolute_expires_at, clock_timestamp() + interval '5 minutes')
     WHERE id = sid AND token_hash = token;
    RETURN jsonb_build_object('adminUserId', acc.admin_user_id, 'steppedUp', true);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION ertad.own_passkey_command(uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.own_passkey_command(uuid, text, text, jsonb) TO ertad_app;

CREATE OR REPLACE FUNCTION ertad.decision_before_receipt_view(actor uuid, d ertad.decisions) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE finished boolean; scheduled boolean; eligible boolean; voted boolean; total integer; counts jsonb; result jsonb;
  participation integer; yes_count integer; no_count integer; outcome text; quorum_required integer; floor_min integer;
BEGIN
  finished := d.status='closed' OR (d.status='open' AND d.closes_at<=clock_timestamp());
  scheduled := NOT finished AND d.status='open' AND d.opens_at IS NOT NULL AND d.opens_at>clock_timestamp();
  floor_min := COALESCE(d.anonymous_min_electorate, ertad.anonymous_min_electorate());
  eligible := EXISTS(SELECT 1 FROM ertad.decision_electorate e WHERE e.organization_id=d.organization_id AND e.decision_id=d.id AND e.user_id=actor
    AND ertad.decision_eligible_audience(actor,d.organization_id,d.unit_id,d.included_unit_ids,d.excluded_unit_ids,e.membership_id));
  IF d.privacy='anonymous' THEN
    voted := EXISTS(SELECT 1 FROM ertad.decision_anonymous_participation WHERE organization_id=d.organization_id AND decision_id=d.id AND user_id=actor);
  ELSIF d.kind='survey' THEN
    voted := EXISTS(SELECT 1 FROM ertad.decision_survey_responses WHERE organization_id=d.organization_id AND decision_id=d.id AND user_id=actor);
  ELSE
    voted := EXISTS(SELECT 1 FROM ertad.decision_named_votes v WHERE v.organization_id=d.organization_id AND v.decision_id=d.id AND v.user_id=actor);
  END IF;
  SELECT count(*) INTO total FROM ertad.decision_electorate WHERE organization_id=d.organization_id AND decision_id=d.id;
  quorum_required := CASE WHEN total=0 THEN 0 ELSE ceil(total * d.quorum / 100.0)::integer END;
  result := jsonb_build_object(
    'id',d.id,'unitId',d.unit_id,'unitName',(SELECT name FROM ertad.units WHERE organization_id=d.organization_id AND id=d.unit_id),
    'includedUnitIds',COALESCE(d.included_unit_ids,ARRAY[d.unit_id]),
    'excludedUnitIds',d.excluded_unit_ids,
    'kind',d.kind,'threshold',d.threshold,'questions',d.questions,'title',d.title,'description',d.description,'options',d.options,
    'privacy',d.privacy,'anonymousMinElectorate',floor_min,'governanceMode',d.governance_mode,'referendumLabels',d.referendum_labels,
    'version',d.version,'quorum',d.quorum,'quorumRequired',quorum_required,'opensAt',d.opens_at,'closesAt',d.closes_at,
    'status',CASE WHEN finished THEN 'closed' WHEN scheduled THEN 'scheduled' ELSE d.status END,
    'electorate',total,'voted',voted,
    'canManage',ertad.review_has_scope(actor,d.organization_id,d.unit_id,'decision.manage'),
    'canPublish',ertad.review_has_scope(actor,d.organization_id,d.unit_id,'decision.publish'),
    'canVote',eligible AND NOT voted AND d.status='open' AND NOT scheduled AND NOT finished AND d.scope_path=ertad.unit_path(d.organization_id,d.unit_id)
  );
  IF d.kind='election' THEN
    result := result||jsonb_build_object('nominations',COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id',n.id,'label',n.candidate_label,'status',n.status,'reason',n.reason,'createdAt',n.created_at,'withdrawnAt',n.withdrawn_at) ORDER BY n.created_at, n.id)
      FROM ertad.decision_nominations n WHERE n.organization_id=d.organization_id AND n.decision_id=d.id
    ),'[]'::jsonb));
  END IF;
  result := result||jsonb_build_object('contributionOffer',(
    SELECT jsonb_build_object('amount',r.amount,'memberMonthCap',r.member_month_cap,'ruleVersion',r.version)
    FROM ertad.contribution_rules r WHERE r.organization_id=d.organization_id AND r.id=d.contribution_rule_id AND r.enabled
  ));
  IF finished THEN
    IF d.privacy='anonymous' THEN
      SELECT count(*) INTO participation FROM ertad.decision_anonymous_participation WHERE organization_id=d.organization_id AND decision_id=d.id;
      IF total < floor_min OR participation = 1 THEN
        RETURN result||jsonb_build_object('resultsSuppressed',true);
      END IF;
    END IF;
    IF d.kind='survey' THEN
      IF d.privacy <> 'anonymous' THEN
        SELECT count(*) INTO participation FROM ertad.decision_survey_responses WHERE organization_id=d.organization_id AND decision_id=d.id;
      END IF;
      RETURN result||jsonb_build_object('surveyResults',ertad.decision_survey_results(actor,d),'participation',participation,'quorumMet',participation*100>=total*d.quorum);
    END IF;
    IF d.privacy='anonymous' THEN
      SELECT jsonb_agg(jsonb_build_object('label',o.label,'votes',(SELECT count(*) FROM ertad.decision_anonymous_ballots b
        WHERE b.organization_id=d.organization_id AND b.decision_id=d.id AND b.choice=o.n-1)) ORDER BY o.n)
      INTO counts FROM unnest(d.options) WITH ORDINALITY o(label,n);
    ELSE
      SELECT jsonb_agg(jsonb_build_object('label',o.label,'votes',(SELECT count(*) FROM ertad.decision_named_votes v
        WHERE v.organization_id=d.organization_id AND v.decision_id=d.id AND v.choice=o.n-1)) ORDER BY o.n)
      INTO counts FROM unnest(d.options) WITH ORDINALITY o(label,n);
      SELECT count(*) INTO participation FROM ertad.decision_named_votes WHERE organization_id=d.organization_id AND decision_id=d.id;
    END IF;
    result := result||jsonb_build_object('results',counts,'participation',participation,'quorumMet',participation*100>=total*d.quorum);
    IF d.kind='referendum' THEN
      yes_count := (counts->0->>'votes')::integer; no_count := (counts->1->>'votes')::integer;
      outcome := CASE WHEN participation*100<total*d.quorum THEN 'inquorate'
        WHEN yes_count+no_count=0 THEN 'no_decision' WHEN yes_count=no_count THEN 'tie'
        WHEN yes_count>no_count AND yes_count*100 >= (yes_count+no_count)*d.threshold THEN 'accepted' ELSE 'rejected' END;
      result := result||jsonb_build_object('outcome',outcome);
    END IF;
  END IF;
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION ertad.decision_before_receipt_view(uuid, ertad.decisions) FROM PUBLIC, ertad_app;
