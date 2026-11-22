-- M4 Permanent Biometric Verification, Selfie-Only New-Device Re-Authentication, and Profile History
-- 1. Primary eID biometric verification does not expire (member_identity_proofs.expires_at = NULL).
-- 2. New device / app reinstall detects unrecognized deviceId via status?deviceId=... and triggers
--    selfie-only biometric re-authentication against the stored encrypted template (no eID re-scan).
-- 3. Member profile returns device bindings, verification history, and identity-linked activity stats.

ALTER TABLE ertad.biometric_verification_sessions
  ADD COLUMN IF NOT EXISTS session_kind text NOT NULL DEFAULT 'enrollment'
  CHECK (session_kind IN ('enrollment', 'reauth'));

UPDATE ertad.member_identity_proofs
SET expires_at = NULL
WHERE assurance_level = 'biometric_verified'
  AND expires_at IS NOT NULL;

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
  app_id_val text;
  key_hash_val text;
  live_score numeric(4,3);
  match_score numeric(4,3);
  sod_ok boolean;
  country_val text;
  uniq_hash text;
  tmpl_cipher text;
  tmpl_digest text;
  port_cipher text;
  bsess_id uuid;
  active_device_count integer := 0;
  device_trusted boolean := true;
  needs_selfie_reauth boolean := false;
BEGIN
  IF op IS NULL OR op NOT IN ('status', 'issue_challenge', 'verify_attestation', 'bind_google', 'complete_biometric', 'verify_reauth') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid M4 mobile command';
  END IF;

  actor := ertad.review_identity(sid, token, false);
  SELECT * INTO pol FROM ertad.verification_infrastructure_policies WHERE id = 1;

  IF op = 'status' THEN
    PERFORM ertad.purge_expired_biometric_sessions();
    SELECT * INTO proof FROM ertad.member_identity_proofs WHERE member_id = actor;
    dev_id := NULLIF(pg_catalog.btrim(COALESCE(input->>'deviceId', '')), '');
    SELECT count(*)::integer INTO active_device_count
    FROM ertad.mobile_device_bindings
    WHERE member_id = actor AND status = 'active';

    IF dev_id IS NULL THEN
      device_trusted := true;
    ELSIF EXISTS (
      SELECT 1
      FROM ertad.mobile_device_bindings
      WHERE member_id = actor AND device_id = dev_id AND status = 'active'
    ) THEN
      device_trusted := true;
    ELSIF active_device_count = 0 AND proof.assurance_level = 'biometric_verified' THEN
      device_trusted := true;
    ELSE
      device_trusted := false;
    END IF;

    needs_selfie_reauth := (
      proof.assurance_level = 'biometric_verified'
      AND proof.biometric_template_cipher IS NOT NULL
      AND NOT device_trusted
    );

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
      'biometricTtlSeconds', pol.biometric_ttl_seconds,
      'deviceTrusted', device_trusted,
      'needsSelfieReauth', needs_selfie_reauth,
      'activeDeviceCount', active_device_count,
      'permanentVerification', (proof.assurance_level = 'biometric_verified')
    );
  END IF;

  IF op = 'issue_challenge' THEN
    nonce_val := input->>'nonce';
    plat := input->>'platform';
    INSERT INTO ertad.mobile_attestation_challenges (nonce, member_id, platform, expires_at)
    VALUES (nonce_val, actor, plat, pg_catalog.clock_timestamp() + interval '5 minutes');
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

    IF NOT FOUND OR chal.consumed_at IS NOT NULL OR chal.expires_at <= pg_catalog.clock_timestamp() THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Attestation challenge invalid or expired';
    END IF;

    UPDATE ertad.mobile_attestation_challenges
    SET consumed_at = pg_catalog.clock_timestamp()
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
      actor, dev_id, plat, input->>'appId', input->>'keyIdHash', verdict_val, counter_val, pg_catalog.clock_timestamp()
    )
    ON CONFLICT (member_id, device_id) DO UPDATE
      SET app_id = EXCLUDED.app_id,
          key_id_hash = EXCLUDED.key_id_hash,
          attestation_verdict = EXCLUDED.attestation_verdict,
          attestation_counter = EXCLUDED.attestation_counter,
          last_attested_at = pg_catalog.clock_timestamp()
    RETURNING * INTO binding;

    RETURN jsonb_build_object('bindingId', binding.id, 'status', binding.status, 'verdict', binding.attestation_verdict);
  END IF;

  IF op = 'bind_google' THEN
    INSERT INTO ertad.member_identity_proofs (member_id, google_sub_hash, assurance_level, updated_at)
    VALUES (actor, input->>'googleSubHash', 'google_scoped', pg_catalog.clock_timestamp())
    ON CONFLICT (member_id) DO UPDATE
      SET google_sub_hash = COALESCE(ertad.member_identity_proofs.google_sub_hash, EXCLUDED.google_sub_hash),
          updated_at = pg_catalog.clock_timestamp()
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

    dev_id := NULLIF(pg_catalog.btrim(COALESCE(input->>'deviceId', '')), '');
    IF dev_id IS NOT NULL THEN
      plat := CASE WHEN COALESCE(input->>'platform', '') IN ('android', 'ios') THEN input->>'platform' ELSE 'android' END;
      app_id_val := COALESCE(NULLIF(pg_catalog.btrim(COALESCE(input->>'appId', '')), ''), 'ge.ertad.mobile');
      key_hash_val := NULLIF(pg_catalog.btrim(COALESCE(input->>'keyIdHash', '')), '');
      IF key_hash_val IS NULL OR key_hash_val !~ '^[a-f0-9]{64}$' THEN
        key_hash_val := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(dev_id, 'UTF8')), 'hex');
      END IF;
      verdict_val := CASE WHEN COALESCE(input->>'verdict', '') IN ('strong', 'basic', 'unverified') THEN input->>'verdict' ELSE 'strong' END;
      counter_val := GREATEST(0, COALESCE((input->>'counter')::bigint, 0));

      SELECT * INTO binding
      FROM ertad.mobile_device_bindings
      WHERE member_id = actor AND device_id = dev_id
      FOR UPDATE;

      IF FOUND AND binding.status <> 'active' THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Device binding is held or revoked';
      END IF;

      INSERT INTO ertad.mobile_device_bindings (
        member_id, device_id, platform, app_id, key_id_hash, attestation_verdict, attestation_counter, last_attested_at
      ) VALUES (
        actor, dev_id, plat, app_id_val, key_hash_val, verdict_val, counter_val, pg_catalog.clock_timestamp()
      )
      ON CONFLICT (member_id, device_id) DO UPDATE
        SET platform = EXCLUDED.platform,
            app_id = EXCLUDED.app_id,
            key_id_hash = EXCLUDED.key_id_hash,
            attestation_verdict = EXCLUDED.attestation_verdict,
            attestation_counter = GREATEST(ertad.mobile_device_bindings.attestation_counter, EXCLUDED.attestation_counter),
            last_attested_at = pg_catalog.clock_timestamp()
      RETURNING * INTO binding;
    END IF;

    INSERT INTO ertad.biometric_verification_sessions (
      member_id, device_binding_id, status, session_kind, sod_csca_verified,
      liveness_score, face_match_score, expires_at
    ) VALUES (
      actor, binding.id, 'passed', 'reauth', proof.sod_csca_verified,
      live_score, match_score,
      pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => GREATEST(60, pol.biometric_ttl_seconds))
    )
    RETURNING id INTO bsess_id;

    UPDATE ertad.member_identity_proofs
    SET updated_at = pg_catalog.clock_timestamp(),
        expires_at = NULL
    WHERE member_id = actor;

    UPDATE ertad.admin_sessions
    SET step_up_expires_at = LEAST(absolute_expires_at, pg_catalog.clock_timestamp() + interval '15 minutes')
    WHERE id = sid AND revoked_at IS NULL;

    RETURN jsonb_build_object(
      'reauthenticated', true,
      'sessionId', bsess_id,
      'assuranceLevel', proof.assurance_level,
      'templateVersion', proof.biometric_template_version,
      'verifiedAt', proof.verified_at,
      'deviceTrusted', true
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
    country_val := pg_catalog.upper(pg_catalog.btrim(COALESCE(input->>'citizenshipCountry', '')));
    live_score := (input->>'livenessScore')::numeric(4,3);
    match_score := (input->>'faceMatchScore')::numeric(4,3);
    uniq_hash := input->>'personUniquenessHash';
    tmpl_cipher := NULLIF(pg_catalog.btrim(COALESCE(input->>'biometricTemplateCipher', '')), '');
    tmpl_digest := NULLIF(pg_catalog.btrim(COALESCE(input->>'biometricTemplateDigest', '')), '');
    port_cipher := NULLIF(pg_catalog.btrim(COALESCE(input->>'portraitCipher', '')), '');

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
      member_id, device_binding_id, status, session_kind, sod_csca_verified,
      liveness_score, face_match_score, expires_at
    ) VALUES (
      actor, binding.id, 'passed', 'enrollment', sod_ok, live_score, match_score,
      pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => GREATEST(60, pol.biometric_ttl_seconds))
    )
    RETURNING id INTO bsess_id;

    INSERT INTO ertad.member_identity_proofs (
      member_id, person_uniqueness_hash, assurance_level, citizenship_country,
      sod_csca_verified, liveness_score, face_match_score,
      biometric_template_cipher, biometric_template_digest, portrait_cipher,
      verified_at, expires_at, updated_at
    ) VALUES (
      actor, uniq_hash, 'biometric_verified', country_val,
      sod_ok, live_score, match_score,
      tmpl_cipher, tmpl_digest, port_cipher,
      pg_catalog.clock_timestamp(), NULL, pg_catalog.clock_timestamp()
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
          verified_at = pg_catalog.clock_timestamp(),
          expires_at = NULL,
          updated_at = pg_catalog.clock_timestamp()
    RETURNING * INTO proof;

    UPDATE ertad.admin_sessions
    SET step_up_expires_at = LEAST(absolute_expires_at, pg_catalog.clock_timestamp() + interval '15 minutes')
    WHERE id = sid AND revoked_at IS NULL;

    UPDATE ertad.member_referrals
    SET verified_at = pg_catalog.clock_timestamp()
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

CREATE OR REPLACE FUNCTION ertad.mobile_profile_command(
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
  proof ertad.member_identity_proofs%ROWTYPE;
  contact ertad.member_contact_profiles%ROWTYPE;
  clear_phone boolean;
  p_cipher text;
  p_hint text;
  devices_arr jsonb;
  history_arr jsonb;
  stats_obj jsonb;
BEGIN
  IF op IS NULL OR op NOT IN ('get', 'set_phone') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid profile command';
  END IF;

  actor := ertad.review_identity(sid, token, false);

  IF op = 'set_phone' THEN
    clear_phone := COALESCE((input->>'clear')::boolean, false);
    IF clear_phone THEN
      INSERT INTO ertad.member_contact_profiles (member_id, phone_cipher, phone_hint, updated_at)
      VALUES (actor, NULL, '', pg_catalog.clock_timestamp())
      ON CONFLICT (member_id) DO UPDATE
        SET phone_cipher = NULL,
            phone_hint = '',
            updated_at = pg_catalog.clock_timestamp();
    ELSE
      p_cipher := NULLIF(pg_catalog.btrim(COALESCE(input->>'phoneCipher', '')), '');
      p_hint := pg_catalog.left(pg_catalog.btrim(COALESCE(input->>'phoneHint', '')), 40);
      IF p_cipher IS NULL OR p_hint = '' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Encrypted phone payload required';
      END IF;
      INSERT INTO ertad.member_contact_profiles (member_id, phone_cipher, phone_hint, updated_at)
      VALUES (actor, p_cipher, p_hint, pg_catalog.clock_timestamp())
      ON CONFLICT (member_id) DO UPDATE
        SET phone_cipher = EXCLUDED.phone_cipher,
            phone_hint = EXCLUDED.phone_hint,
            updated_at = pg_catalog.clock_timestamp();
    END IF;
  END IF;

  SELECT * INTO proof FROM ertad.member_identity_proofs WHERE member_id = actor;
  SELECT * INTO contact FROM ertad.member_contact_profiles WHERE member_id = actor;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', d.id,
        'deviceIdShort', pg_catalog.right(d.device_id, 8),
        'platform', d.platform,
        'status', d.status,
        'verdict', d.attestation_verdict,
        'createdAt', d.created_at,
        'lastAttestedAt', d.last_attested_at
      )
      ORDER BY d.last_attested_at DESC
    ),
    '[]'::jsonb
  )
  INTO devices_arr
  FROM (
    SELECT id, device_id, platform, status, attestation_verdict, created_at, last_attested_at
    FROM ertad.mobile_device_bindings
    WHERE member_id = actor
    ORDER BY last_attested_at DESC
    LIMIT 10
  ) d;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', s.id,
        'kind', s.session_kind,
        'status', s.status,
        'sodCscaVerified', s.sod_csca_verified,
        'createdAt', s.created_at
      )
      ORDER BY s.created_at DESC
    ),
    '[]'::jsonb
  )
  INTO history_arr
  FROM (
    SELECT id, session_kind, status, sod_csca_verified, created_at
    FROM ertad.biometric_verification_sessions
    WHERE member_id = actor
      AND status IN ('passed', 'purged')
    ORDER BY created_at DESC
    LIMIT 15
  ) s;

  stats_obj := jsonb_build_object(
    'pointsBalance', COALESCE((SELECT sum(points)::integer FROM ertad.contribution_entries WHERE user_id = actor), 0),
    'tasksCompleted', (SELECT count(*)::integer FROM ertad.work_assignments WHERE user_id = actor AND status = 'verified'),
    'votesCast', (
      (SELECT count(*)::integer FROM ertad.decision_named_votes WHERE user_id = actor)
      + (SELECT count(*)::integer FROM ertad.decision_anonymous_participation WHERE user_id = actor)
      + (SELECT count(*)::integer FROM ertad.decision_survey_responses WHERE user_id = actor)
    ),
    'referralsCount', (SELECT count(*)::integer FROM ertad.member_referrals WHERE referrer_id = actor)
  );

  RETURN jsonb_build_object(
    'assuranceLevel', COALESCE(proof.assurance_level, 'google_scoped'),
    'permanentVerification', (proof.assurance_level = 'biometric_verified'),
    'sodCscaVerified', COALESCE(proof.sod_csca_verified, false),
    'citizenshipCountry', COALESCE(proof.citizenship_country, ''),
    'hasStoredTemplate', (proof.biometric_template_cipher IS NOT NULL),
    'googleLinked', (proof.google_sub_hash IS NOT NULL),
    'verifiedAt', proof.verified_at,
    'hasPhone', (contact.phone_cipher IS NOT NULL),
    'phoneHint', COALESCE(contact.phone_hint, ''),
    'phoneUpdatedAt', contact.updated_at,
    'devices', devices_arr,
    'verificationHistory', history_arr,
    'identityStats', stats_obj
  );
END;
$$;

REVOKE ALL ON FUNCTION ertad.mobile_profile_command(uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.mobile_profile_command(uuid, text, text, jsonb) TO ertad_app;
