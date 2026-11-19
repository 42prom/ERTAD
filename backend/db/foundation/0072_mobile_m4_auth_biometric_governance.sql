-- M4: Mobile production auth (Google OIDC + hybrid assurance), Device Attestation,
-- eID biometric verification with TTL purge, and Admin Read vs Control two-person governance.

ALTER TABLE ertad.platform_accounts DROP CONSTRAINT platform_accounts_permissions_check;
ALTER TABLE ertad.platform_accounts ADD CONSTRAINT platform_accounts_permissions_check CHECK (
  permissions <@ ARRAY[
    'platform.read','platform.audit.read','platform.sessions.read','platform.sessions.revoke',
    'platform.integrations.read','platform.integrations.test','platform.policy.read','platform.policy.propose','platform.policy.approve',
    'platform.network.read','platform.network.propose','platform.network.approve','platform.limits.read','platform.limits.propose','platform.limits.approve',
    'platform.providers.read','platform.providers.propose','platform.providers.approve',
    'platform.accounts.read','platform.accounts.hold','platform.accounts.release','platform.accounts.propose','platform.accounts.approve',
    'platform.verification.read','platform.verification.propose','platform.verification.approve','platform.mobile_devices.control'
  ]::text[] AND array_position(permissions,NULL) IS NULL
);

CREATE TABLE ertad.verification_infrastructure_policies (
  id integer PRIMARY KEY CHECK (id = 1),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  auth_profile text NOT NULL DEFAULT 'google_hybrid'
    CHECK (auth_profile IN ('google_hybrid', 'document_and_face')),
  require_device_attestation boolean NOT NULL DEFAULT true,
  require_nfc boolean NOT NULL DEFAULT true,
  require_georgian_citizen boolean NOT NULL DEFAULT true,
  liveness_provider text NOT NULL DEFAULT '3d_face_detector'
    CHECK (liveness_provider IN ('3d_face_detector', 'facetec', 'iproov', 'aws-rekognition', 'faceplusplus', 'doublescript', 'provider')),
  face_match_provider text NOT NULL DEFAULT 'custom_biometric_matcher'
    CHECK (face_match_provider IN ('custom_biometric_matcher', 'aws-rekognition', 'faceplusplus', 'doublescript', 'provider')),
  liveness_min_score numeric(4,3) NOT NULL DEFAULT 0.850 CHECK (liveness_min_score >= 0.500 AND liveness_min_score <= 0.990),
  face_match_min_score numeric(4,3) NOT NULL DEFAULT 0.800 CHECK (face_match_min_score >= 0.500 AND face_match_min_score <= 0.990),
  retry_limit integer NOT NULL DEFAULT 3 CHECK (retry_limit >= 1 AND retry_limit <= 10),
  biometric_ttl_seconds integer NOT NULL DEFAULT 900 CHECK (biometric_ttl_seconds >= 60 AND biometric_ttl_seconds <= 86400),
  credential_cipher text,
  credential_digest text CHECK (credential_digest IS NULL OR credential_digest ~ '^[a-f0-9]{64}$'),
  updated_by uuid REFERENCES ertad.platform_accounts(admin_user_id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO ertad.verification_infrastructure_policies (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
REVOKE ALL ON ertad.verification_infrastructure_policies FROM PUBLIC, ertad_app;

CREATE TABLE ertad.verification_infrastructure_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposer_id uuid NOT NULL REFERENCES ertad.platform_accounts(admin_user_id),
  request_id uuid NOT NULL,
  expected_version integer NOT NULL CHECK (expected_version >= 1),
  auth_profile text NOT NULL CHECK (auth_profile IN ('google_hybrid', 'document_and_face')),
  require_device_attestation boolean NOT NULL,
  require_nfc boolean NOT NULL,
  require_georgian_citizen boolean NOT NULL,
  liveness_provider text NOT NULL
    CHECK (liveness_provider IN ('3d_face_detector', 'facetec', 'iproov', 'aws-rekognition', 'faceplusplus', 'doublescript', 'provider')),
  face_match_provider text NOT NULL
    CHECK (face_match_provider IN ('custom_biometric_matcher', 'aws-rekognition', 'faceplusplus', 'doublescript', 'provider')),
  liveness_min_score numeric(4,3) NOT NULL CHECK (liveness_min_score >= 0.500 AND liveness_min_score <= 0.990),
  face_match_min_score numeric(4,3) NOT NULL CHECK (face_match_min_score >= 0.500 AND face_match_min_score <= 0.990),
  retry_limit integer NOT NULL CHECK (retry_limit >= 1 AND retry_limit <= 10),
  biometric_ttl_seconds integer NOT NULL CHECK (biometric_ttl_seconds >= 60 AND biometric_ttl_seconds <= 86400),
  credential_cipher text,
  credential_digest text CHECK (credential_digest IS NULL OR credential_digest ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK (reason IN ('security_tightening', 'provider_change', 'recovery')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  reviewer_id uuid REFERENCES ertad.platform_accounts(admin_user_id),
  review_request_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reviewed_at timestamptz,
  UNIQUE (proposer_id, request_id),
  CHECK (
    (status = 'pending' AND reviewer_id IS NULL AND reviewed_at IS NULL)
    OR (status = 'withdrawn' AND reviewer_id = proposer_id AND reviewed_at IS NOT NULL)
    OR (status IN ('approved', 'rejected') AND reviewer_id IS NOT NULL AND reviewer_id <> proposer_id AND reviewed_at IS NOT NULL)
  )
);

CREATE INDEX verification_proposals_pending_idx
  ON ertad.verification_infrastructure_proposals (created_at DESC, id)
  WHERE status = 'pending';
REVOKE ALL ON ertad.verification_infrastructure_proposals FROM PUBLIC, ertad_app;

CREATE TABLE ertad.mobile_attestation_challenges (
  nonce text PRIMARY KEY CHECK (length(nonce) BETWEEN 32 AND 128),
  member_id uuid NOT NULL REFERENCES ertad.member_users(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('android', 'ios')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON ertad.mobile_attestation_challenges FROM PUBLIC, ertad_app;

CREATE TABLE ertad.mobile_device_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES ertad.member_users(id) ON DELETE CASCADE,
  device_id text NOT NULL CHECK (length(device_id) BETWEEN 8 AND 128),
  platform text NOT NULL CHECK (platform IN ('android', 'ios')),
  app_id text NOT NULL CHECK (length(app_id) BETWEEN 3 AND 160),
  key_id_hash text NOT NULL CHECK (key_id_hash ~ '^[a-f0-9]{64}$'),
  attestation_verdict text NOT NULL CHECK (attestation_verdict IN ('strong', 'basic', 'unverified')),
  attestation_counter bigint NOT NULL DEFAULT 0 CHECK (attestation_counter >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'held', 'revoked')),
  hold_reason text CHECK (hold_reason IS NULL OR hold_reason IN ('suspected_compromise', 'replay_detected', 'operator_request')),
  held_by uuid REFERENCES ertad.platform_accounts(admin_user_id),
  held_at timestamptz,
  last_attested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (member_id, device_id)
);
CREATE INDEX mobile_device_bindings_status_idx ON ertad.mobile_device_bindings (status, last_attested_at DESC);
REVOKE ALL ON ertad.mobile_device_bindings FROM PUBLIC, ertad_app;

CREATE TABLE ertad.member_identity_proofs (
  member_id uuid PRIMARY KEY REFERENCES ertad.member_users(id) ON DELETE CASCADE,
  person_uniqueness_hash text UNIQUE CHECK (person_uniqueness_hash IS NULL OR person_uniqueness_hash ~ '^[a-f0-9]{64}$'),
  google_sub_hash text UNIQUE CHECK (google_sub_hash IS NULL OR google_sub_hash ~ '^[a-f0-9]{64}$'),
  assurance_level text NOT NULL DEFAULT 'google_scoped'
    CHECK (assurance_level IN ('google_scoped', 'document_verified', 'biometric_verified')),
  citizenship_country text CHECK (citizenship_country IS NULL OR citizenship_country ~ '^[A-Z]{2,3}$'),
  sod_csca_verified boolean NOT NULL DEFAULT false,
  liveness_score numeric(4,3),
  face_match_score numeric(4,3),
  verified_at timestamptz,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON ertad.member_identity_proofs FROM PUBLIC, ertad_app;

CREATE TABLE ertad.biometric_verification_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES ertad.member_users(id) ON DELETE CASCADE,
  device_binding_id uuid REFERENCES ertad.mobile_device_bindings(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'passed', 'failed', 'expired', 'purged')),
  sod_csca_verified boolean NOT NULL DEFAULT false,
  liveness_score numeric(4,3),
  face_match_score numeric(4,3),
  expires_at timestamptz NOT NULL,
  purged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX biometric_sessions_ttl_idx
  ON ertad.biometric_verification_sessions (expires_at)
  WHERE purged_at IS NULL;
REVOKE ALL ON ertad.biometric_verification_sessions FROM PUBLIC, ertad_app;

CREATE FUNCTION ertad.purge_expired_biometric_sessions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  purged_count integer := 0;
BEGIN
  UPDATE ertad.biometric_verification_sessions
  SET status = 'purged',
      purged_at = clock_timestamp(),
      liveness_score = NULL,
      face_match_score = NULL
  WHERE purged_at IS NULL
    AND expires_at <= clock_timestamp();
  GET DIAGNOSTICS purged_count = ROW_COUNT;
  RETURN purged_count;
END;
$$;
REVOKE ALL ON FUNCTION ertad.purge_expired_biometric_sessions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.purge_expired_biometric_sessions() TO ertad_app;

CREATE FUNCTION ertad.verification_platform_actor(
  sid uuid,
  token text,
  required_cap text,
  require_step_up boolean DEFAULT false
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid;
  capabilities text[];
  s ertad.admin_sessions;
BEGIN
  PERFORM ertad.platform_console_command(sid, token, 'overview', '{}');
  SELECT * INTO s FROM ertad.admin_sessions WHERE id = sid AND token_hash = token;
  actor := s.admin_user_id;
  SELECT permissions INTO capabilities FROM ertad.platform_accounts WHERE admin_user_id = actor;
  IF NOT COALESCE(required_cap = ANY(capabilities), false) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
  END IF;
  IF require_step_up AND (s.step_up_expires_at IS NULL OR s.step_up_expires_at <= clock_timestamp()) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0428', MESSAGE = 'Fresh authentication required';
  END IF;
  RETURN actor;
END;
$$;
REVOKE ALL ON FUNCTION ertad.verification_platform_actor(uuid, text, text, boolean) FROM PUBLIC, ertad_app;

CREATE FUNCTION ertad.verification_policy_command(
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
  req_id uuid;
  prop_id uuid;
  act text;
  pol ertad.verification_infrastructure_policies%ROWTYPE;
  prop ertad.verification_infrastructure_proposals%ROWTYPE;
  pending_rows jsonb;
  purged_now integer := 0;
  pending_ttl integer := 0;
BEGIN
  IF op IS NULL OR op NOT IN ('get', 'propose', 'review') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid verification policy command';
  END IF;

  IF op = 'get' THEN
    actor := ertad.verification_platform_actor(sid, token, 'platform.verification.read', false);
    purged_now := ertad.purge_expired_biometric_sessions();

    SELECT * INTO pol FROM ertad.verification_infrastructure_policies WHERE id = 1;
    SELECT count(*)::integer INTO pending_ttl
    FROM ertad.biometric_verification_sessions
    WHERE purged_at IS NULL AND expires_at > clock_timestamp();

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', p.id,
      'proposerId', p.proposer_id,
      'expectedVersion', p.expected_version,
      'authProfile', p.auth_profile,
      'requireDeviceAttestation', p.require_device_attestation,
      'requireNfc', p.require_nfc,
      'requireGeorgianCitizen', p.require_georgian_citizen,
      'livenessProvider', p.liveness_provider,
      'faceMatchProvider', p.face_match_provider,
      'livenessMinScore', p.liveness_min_score,
      'faceMatchMinScore', p.face_match_min_score,
      'retryLimit', p.retry_limit,
      'biometricTtlSeconds', p.biometric_ttl_seconds,
      'hasCredential', (p.credential_cipher IS NOT NULL),
      'reason', p.reason,
      'status', p.status,
      'createdAt', p.created_at
    ) ORDER BY p.created_at DESC), '[]'::jsonb)
    INTO pending_rows
    FROM ertad.verification_infrastructure_proposals p
    WHERE p.status = 'pending';

    RETURN jsonb_build_object(
      'policy', jsonb_build_object(
        'version', pol.version,
        'authProfile', pol.auth_profile,
        'requireDeviceAttestation', pol.require_device_attestation,
        'requireNfc', pol.require_nfc,
        'requireGeorgianCitizen', pol.require_georgian_citizen,
        'livenessProvider', pol.liveness_provider,
        'faceMatchProvider', pol.face_match_provider,
        'livenessMinScore', pol.liveness_min_score,
        'faceMatchMinScore', pol.face_match_min_score,
        'retryLimit', pol.retry_limit,
        'biometricTtlSeconds', pol.biometric_ttl_seconds,
        'hasCredential', (pol.credential_cipher IS NOT NULL),
        'updatedAt', pol.updated_at
      ),
      'pendingProposals', pending_rows,
      'ttlHealth', jsonb_build_object(
        'activeBiometricSessions', pending_ttl,
        'purgedOnRead', purged_now
      )
    );
  END IF;

  PERFORM pg_advisory_xact_lock(752991884322072::bigint);

  IF op = 'propose' THEN
    actor := ertad.verification_platform_actor(sid, token, 'platform.verification.propose', true);
    req_id := (input->>'requestId')::uuid;
    SELECT * INTO pol FROM ertad.verification_infrastructure_policies WHERE id = 1 FOR SHARE;

    IF (input->>'expectedVersion')::integer <> pol.version THEN
      RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'Verification policy version conflict';
    END IF;

    INSERT INTO ertad.verification_infrastructure_proposals (
      proposer_id, request_id, expected_version, auth_profile, require_device_attestation,
      require_nfc, require_georgian_citizen, liveness_provider, face_match_provider,
      liveness_min_score, face_match_min_score, retry_limit, biometric_ttl_seconds,
      credential_cipher, credential_digest, reason
    ) VALUES (
      actor, req_id, (input->>'expectedVersion')::integer,
      input->>'authProfile', (input->>'requireDeviceAttestation')::boolean,
      (input->>'requireNfc')::boolean, (input->>'requireGeorgianCitizen')::boolean,
      input->>'livenessProvider', input->>'faceMatchProvider',
      (input->>'livenessMinScore')::numeric(4,3), (input->>'faceMatchMinScore')::numeric(4,3),
      (input->>'retryLimit')::integer, (input->>'biometricTtlSeconds')::integer,
      NULLIF(input->>'credentialCipher', ''), NULLIF(input->>'credentialDigest', ''),
      input->>'reason'
    )
    ON CONFLICT (proposer_id, request_id) DO UPDATE
      SET reason = ertad.verification_infrastructure_proposals.reason
    RETURNING * INTO prop;

    RETURN jsonb_build_object('proposalId', prop.id, 'status', prop.status);
  END IF;

  -- op = 'review'
  req_id := (input->>'requestId')::uuid;
  prop_id := (input->>'proposalId')::uuid;
  act := input->>'action';
  IF act NOT IN ('approve', 'reject', 'withdraw') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid review action';
  END IF;

  IF act = 'withdraw' THEN
    actor := ertad.verification_platform_actor(sid, token, 'platform.verification.propose', true);
  ELSE
    actor := ertad.verification_platform_actor(sid, token, 'platform.verification.approve', true);
  END IF;

  SELECT * INTO prop FROM ertad.verification_infrastructure_proposals WHERE id = prop_id FOR UPDATE;
  IF NOT FOUND OR prop.status <> 'pending' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Verification proposal not pending';
  END IF;

  IF act = 'withdraw' AND prop.proposer_id <> actor THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Only proposer can withdraw';
  END IF;
  IF act IN ('approve', 'reject') AND prop.proposer_id = actor THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Independent reviewer required';
  END IF;

  UPDATE ertad.verification_infrastructure_proposals
  SET status = CASE WHEN act = 'approve' THEN 'approved' WHEN act = 'reject' THEN 'rejected' ELSE 'withdrawn' END,
      reviewer_id = actor,
      review_request_id = req_id,
      reviewed_at = clock_timestamp()
  WHERE id = prop_id;

  IF act = 'approve' THEN
    SELECT * INTO pol FROM ertad.verification_infrastructure_policies WHERE id = 1 FOR UPDATE;
    IF pol.version <> prop.expected_version THEN
      RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'Verification policy version conflict';
    END IF;

    UPDATE ertad.verification_infrastructure_policies
    SET version = version + 1,
        auth_profile = prop.auth_profile,
        require_device_attestation = prop.require_device_attestation,
        require_nfc = prop.require_nfc,
        require_georgian_citizen = prop.require_georgian_citizen,
        liveness_provider = prop.liveness_provider,
        face_match_provider = prop.face_match_provider,
        liveness_min_score = prop.liveness_min_score,
        face_match_min_score = prop.face_match_min_score,
        retry_limit = prop.retry_limit,
        biometric_ttl_seconds = prop.biometric_ttl_seconds,
        credential_cipher = COALESCE(prop.credential_cipher, credential_cipher),
        credential_digest = COALESCE(prop.credential_digest, credential_digest),
        updated_by = actor,
        updated_at = clock_timestamp()
    WHERE id = 1;
  END IF;

  RETURN jsonb_build_object('proposalId', prop_id, 'action', act);
END;
$$;
REVOKE ALL ON FUNCTION ertad.verification_policy_command(uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.verification_policy_command(uuid, text, text, jsonb) TO ertad_app;

CREATE FUNCTION ertad.mobile_device_control_command(
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
  binding_id uuid;
  reason_val text;
  rows_json jsonb;
  counts_json jsonb;
BEGIN
  IF op IS NULL OR op NOT IN ('list', 'hold', 'release', 'revoke', 'purge_biometrics') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid device control command';
  END IF;

  IF op = 'list' THEN
    actor := ertad.verification_platform_actor(sid, token, 'platform.verification.read', false);
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', b.id,
      'platform', b.platform,
      'appId', b.app_id,
      'verdict', b.attestation_verdict,
      'counter', b.attestation_counter,
      'status', b.status,
      'holdReason', b.hold_reason,
      'lastAttestedAt', b.last_attested_at,
      'createdAt', b.created_at
    ) ORDER BY b.last_attested_at DESC), '[]'::jsonb)
    INTO rows_json
    FROM (
      SELECT id, platform, app_id, attestation_verdict, attestation_counter, status, hold_reason, last_attested_at, created_at
      FROM ertad.mobile_device_bindings
      ORDER BY last_attested_at DESC
      LIMIT 100
    ) b;

    SELECT jsonb_build_object(
      'activeDevices', count(*) FILTER (WHERE status = 'active'),
      'heldDevices', count(*) FILTER (WHERE status = 'held'),
      'revokedDevices', count(*) FILTER (WHERE status = 'revoked')
    ) INTO counts_json
    FROM ertad.mobile_device_bindings;

    RETURN jsonb_build_object('devices', rows_json, 'summary', counts_json);
  END IF;

  IF op = 'purge_biometrics' THEN
    actor := ertad.verification_platform_actor(sid, token, 'platform.mobile_devices.control', true);
    RETURN jsonb_build_object('purgedCount', ertad.purge_expired_biometric_sessions());
  END IF;

  actor := ertad.verification_platform_actor(sid, token, 'platform.mobile_devices.control', true);
  binding_id := (input->>'bindingId')::uuid;
  reason_val := COALESCE(NULLIF(input->>'reason', ''), 'operator_request');

  UPDATE ertad.mobile_device_bindings
  SET status = CASE WHEN op = 'hold' THEN 'held' WHEN op = 'release' THEN 'active' ELSE 'revoked' END,
      hold_reason = CASE WHEN op = 'release' THEN NULL ELSE reason_val END,
      held_by = CASE WHEN op = 'release' THEN NULL ELSE actor END,
      held_at = CASE WHEN op = 'release' THEN NULL ELSE clock_timestamp() END
  WHERE id = binding_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Device binding not found';
  END IF;

  RETURN jsonb_build_object('bindingId', binding_id, 'op', op);
END;
$$;
REVOKE ALL ON FUNCTION ertad.mobile_device_control_command(uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.mobile_device_control_command(uuid, text, text, jsonb) TO ertad_app;

CREATE FUNCTION ertad.mobile_m4_command(
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
  bsess_id uuid;
BEGIN
  IF op IS NULL OR op NOT IN ('status', 'issue_challenge', 'verify_attestation', 'bind_google', 'complete_biometric') THEN
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
    sod_csca_verified, liveness_score, face_match_score, verified_at, updated_at
  ) VALUES (
    actor, uniq_hash, 'biometric_verified', country_val,
    sod_ok, live_score, match_score, clock_timestamp(), clock_timestamp()
  )
  ON CONFLICT (member_id) DO UPDATE
    SET person_uniqueness_hash = EXCLUDED.person_uniqueness_hash,
        assurance_level = 'biometric_verified',
        citizenship_country = EXCLUDED.citizenship_country,
        sod_csca_verified = EXCLUDED.sod_csca_verified,
        liveness_score = EXCLUDED.liveness_score,
        face_match_score = EXCLUDED.face_match_score,
        verified_at = clock_timestamp(),
        updated_at = clock_timestamp()
  RETURNING * INTO proof;

  RETURN jsonb_build_object(
    'sessionId', bsess_id,
    'assuranceLevel', proof.assurance_level,
    'verifiedAt', proof.verified_at,
    'biometricTtlSeconds', pol.biometric_ttl_seconds
  );
END;
$$;
REVOKE ALL ON FUNCTION ertad.mobile_m4_command(uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.mobile_m4_command(uuid, text, text, jsonb) TO ertad_app;
