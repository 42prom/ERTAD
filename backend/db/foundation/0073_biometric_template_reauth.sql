-- M4-B: Encrypted biometric template storage for first-party re-authentication
-- (no raw selfie/document media persisted; raw session media stays strictly TTL-purged).

ALTER TABLE ertad.member_identity_proofs
  ADD COLUMN IF NOT EXISTS biometric_template_cipher text,
  ADD COLUMN IF NOT EXISTS biometric_template_digest text
    CHECK (biometric_template_digest IS NULL OR biometric_template_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN IF NOT EXISTS biometric_template_version integer NOT NULL DEFAULT 1;

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
      'templateVersion', proof.biometric_template_version
    );
  END IF;

  -- op = 'complete_biometric'
  dev_id := NULLIF(input->>'deviceId', '');
  IF pol.require_device_attestation THEN
    IF dev_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Device attestation required';
    END IF;
    SELECT * INTO binding
    FROM ertad.mobile_device_bindings
    WHERE member_id = actor AND device_id = dev_id AND status = 'active' AND attestation_verdict IN ('strong', 'basic');
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Active device attestation required';
    END IF;
  END IF;

  sod_ok := COALESCE((input->>'sodCscaVerified')::boolean, false);
  live_score := (input->>'livenessScore')::numeric(4,3);
  match_score := (input->>'faceMatchScore')::numeric(4,3);
  country_val := upper(trim(COALESCE(input->>'citizenshipCountry', '')));
  uniq_hash := input->>'personUniquenessHash';
  tmpl_cipher := NULLIF(input->>'biometricTemplateCipher', '');
  tmpl_digest := NULLIF(input->>'biometricTemplateDigest', '');

  IF pol.require_nfc AND NOT sod_ok THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'NFC SOD/CSCA verification required';
  END IF;
  IF pol.require_georgian_citizen AND country_val NOT IN ('GE', 'GEO') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Georgian citizenship verification required';
  END IF;
  IF live_score < pol.liveness_min_score OR match_score < pol.face_match_min_score THEN
    INSERT INTO ertad.biometric_verification_sessions (
      member_id, device_binding_id, status, sod_csca_verified, liveness_score, face_match_score, expires_at
    ) VALUES (
      actor, binding.id, 'failed', sod_ok, live_score, match_score,
      clock_timestamp() + make_interval(secs => pol.biometric_ttl_seconds)
    );
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
  ) RETURNING id INTO bsess_id;

  INSERT INTO ertad.member_identity_proofs (
    member_id, person_uniqueness_hash, assurance_level, citizenship_country,
    sod_csca_verified, liveness_score, face_match_score,
    biometric_template_cipher, biometric_template_digest,
    verified_at, updated_at
  ) VALUES (
    actor, uniq_hash, 'biometric_verified', country_val,
    sod_ok, live_score, match_score,
    tmpl_cipher, tmpl_digest,
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
        verified_at = clock_timestamp(),
        updated_at = clock_timestamp()
  RETURNING * INTO proof;

  RETURN jsonb_build_object(
    'sessionId', bsess_id,
    'assuranceLevel', proof.assurance_level,
    'hasStoredTemplate', (proof.biometric_template_cipher IS NOT NULL),
    'verifiedAt', proof.verified_at,
    'biometricTtlSeconds', pol.biometric_ttl_seconds
  );
END;
$$;
