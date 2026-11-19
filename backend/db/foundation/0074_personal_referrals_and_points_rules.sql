-- Personal Referral Hierarchy (I5, I6, I18) & Admin-Governed Referral Contribution Rules
-- Uses the single unified ertad.contribution_rules / ertad.contribution_entries ledger.
-- Referral counts and points never grant governance power, voting weight, or broadcast authority.

ALTER TABLE ertad.contribution_rules
  DROP CONSTRAINT IF EXISTS contribution_rules_category_check;
ALTER TABLE ertad.contribution_rules
  ADD CONSTRAINT contribution_rules_category_check
  CHECK (category IN (
    'task', 'vote', 'survey', 'manual',
    'referral_join', 'referral_verified', 'referral_l2_verified'
  ));

ALTER TABLE ertad.contribution_entries
  DROP CONSTRAINT IF EXISTS contribution_entries_category_check;
ALTER TABLE ertad.contribution_entries
  ADD CONSTRAINT contribution_entries_category_check
  CHECK (category IN (
    'task', 'vote', 'survey', 'manual',
    'referral_join', 'referral_verified', 'referral_l2_verified'
  ));

ALTER TABLE ertad.contribution_entries
  DROP CONSTRAINT IF EXISTS contribution_entries_source_kind_check;
ALTER TABLE ertad.contribution_entries
  ADD CONSTRAINT contribution_entries_source_kind_check
  CHECK (source_kind IN (
    'activity', 'decision_participation', 'manual', 'reversal',
    'referral_join', 'referral_verified', 'referral_l2_verified'
  ));

CREATE TABLE IF NOT EXISTS ertad.member_referral_codes (
  member_id uuid PRIMARY KEY REFERENCES ertad.member_users(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE CHECK (code ~ '^ERTAD-P-[A-Z0-9]{4}-[A-Z0-9]{4}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS ertad.member_referrals (
  invitee_id uuid PRIMARY KEY REFERENCES ertad.member_users(id) ON DELETE CASCADE,
  referrer_id uuid NOT NULL REFERENCES ertad.member_users(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES ertad.organizations(id) ON DELETE CASCADE,
  unit_id uuid NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  verified_at timestamptz,
  CHECK (invitee_id <> referrer_id),
  FOREIGN KEY (organization_id, unit_id) REFERENCES ertad.units(organization_id, id)
);

CREATE INDEX IF NOT EXISTS member_referrals_referrer_idx
  ON ertad.member_referrals (referrer_id, joined_at DESC);
CREATE INDEX IF NOT EXISTS member_referrals_org_referrer_idx
  ON ertad.member_referrals (organization_id, referrer_id);

REVOKE ALL ON TABLE ertad.member_referral_codes, ertad.member_referrals FROM PUBLIC;

CREATE OR REPLACE FUNCTION ertad.ensure_member_referral_code(p_member uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  existing_code text;
  hex_part text;
  candidate text;
BEGIN
  SELECT code INTO existing_code
  FROM ertad.member_referral_codes
  WHERE member_id = p_member;
  IF FOUND THEN
    RETURN existing_code;
  END IF;

  hex_part := upper(substr(md5(p_member::text || ':ertad-personal-ref-v1'), 1, 8));
  candidate := 'ERTAD-P-' || substr(hex_part, 1, 4) || '-' || substr(hex_part, 5, 4);

  INSERT INTO ertad.member_referral_codes (member_id, code)
  VALUES (p_member, candidate)
  ON CONFLICT (member_id) DO NOTHING;

  SELECT code INTO existing_code
  FROM ertad.member_referral_codes
  WHERE member_id = p_member;
  RETURN existing_code;
END;
$$;

CREATE OR REPLACE FUNCTION ertad.referral_issue_reward(
  p_org uuid,
  p_unit uuid,
  p_recipient uuid,
  p_category text,
  p_source_member uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  rule_id uuid;
BEGIN
  IF p_org IS NULL OR p_unit IS NULL OR p_recipient IS NULL OR p_source_member IS NULL THEN
    RETURN;
  END IF;
  rule_id := ertad.contribution_current(p_org, p_category);
  IF rule_id IS NULL THEN
    RETURN;
  END IF;
  PERFORM ertad.contribution_issue(
    p_org,
    p_unit,
    p_recipient,
    rule_id,
    p_category,
    p_source_member,
    NULL,
    NULL,
    ''
  );
END;
$$;

CREATE OR REPLACE FUNCTION ertad.referral_member_label(
  p_org uuid,
  p_member uuid
) RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT COALESCE(
    NULLIF(ertad.direct_peer_summary(p_org, p_member)->>'label', ''),
    '#' || upper(substr(replace(p_member::text, '-', ''), 1, 4))
  )
$$;

CREATE OR REPLACE FUNCTION ertad.mobile_referral_command(
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
  org_id uuid;
  target_unit uuid;
  my_code text;
  code_input text;
  ref_member uuid;
  l2_member uuid;
  cycle_found boolean;
  actor_verified boolean;
  direct_count integer := 0;
  direct_verified integer := 0;
  net_total integer := 0;
  net_verified integer := 0;
  pts_earned bigint := 0;
  invited_by_json jsonb := NULL;
  invitees_json jsonb := '[]'::jsonb;
  rules_json jsonb;
BEGIN
  IF op IS NULL OR op NOT IN ('summary', 'redeem') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid referral command';
  END IF;

  actor := ertad.review_identity(sid, token, false);
  org_id := (input->>'organizationId')::uuid;
  IF org_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'organizationId required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM ertad.units u
    WHERE u.organization_id = org_id
      AND ertad.review_has_scope(actor, org_id, u.id, 'unit.read')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Organization access required';
  END IF;

  my_code := ertad.ensure_member_referral_code(actor);

  IF op = 'redeem' THEN
    code_input := upper(btrim(COALESCE(input->>'code', '')));
    IF code_input !~ '^ERTAD-P-[A-Z0-9]{4}-[A-Z0-9]{4}$' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid referral code format';
    END IF;

    SELECT member_id INTO ref_member
    FROM ertad.member_referral_codes
    WHERE code = code_input;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Referral code not found';
    END IF;

    IF ref_member = actor THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Self-referral is not allowed';
    END IF;

    IF EXISTS (SELECT 1 FROM ertad.member_referrals WHERE invitee_id = actor) THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'Referrer already linked';
    END IF;

    -- Prevent referral hierarchy cycles
    WITH RECURSIVE ancestors AS (
      SELECT r.referrer_id, 1 AS depth
      FROM ertad.member_referrals r
      WHERE r.invitee_id = ref_member
      UNION ALL
      SELECT r2.referrer_id, a.depth + 1
      FROM ertad.member_referrals r2
      JOIN ancestors a ON a.referrer_id = r2.invitee_id
      WHERE a.depth < 12
    )
    SELECT EXISTS (SELECT 1 FROM ancestors WHERE referrer_id = actor) INTO cycle_found;
    IF cycle_found THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Referral cycle is not allowed';
    END IF;

    SELECT COALESCE(
      (input->>'unitId')::uuid,
      (SELECT u.id FROM ertad.units u WHERE u.organization_id = org_id AND u.parent_id IS NULL AND u.status = 'active' LIMIT 1)
    ) INTO target_unit;

    SELECT EXISTS (
      SELECT 1 FROM ertad.member_identity_proofs p
      WHERE p.member_id = actor AND p.assurance_level = 'biometric_verified'
    ) INTO actor_verified;

    INSERT INTO ertad.member_referrals (invitee_id, referrer_id, organization_id, unit_id, verified_at)
    VALUES (actor, ref_member, org_id, target_unit, CASE WHEN actor_verified THEN clock_timestamp() ELSE NULL END);

    PERFORM ertad.referral_issue_reward(org_id, target_unit, ref_member, 'referral_join', actor);

    IF actor_verified THEN
      PERFORM ertad.referral_issue_reward(org_id, target_unit, ref_member, 'referral_verified', actor);
      SELECT referrer_id INTO l2_member FROM ertad.member_referrals WHERE invitee_id = ref_member;
      IF FOUND THEN
        PERFORM ertad.referral_issue_reward(org_id, target_unit, l2_member, 'referral_l2_verified', actor);
      END IF;
    END IF;
  END IF;

  -- Build full personal summary
  SELECT jsonb_build_object(
    'displayLabel', ertad.referral_member_label(org_id, r.referrer_id),
    'code', ertad.ensure_member_referral_code(r.referrer_id),
    'joinedAt', r.joined_at,
    'verified', EXISTS (
      SELECT 1 FROM ertad.member_identity_proofs p
      WHERE p.member_id = r.referrer_id AND p.assurance_level = 'biometric_verified'
    )
  ) INTO invited_by_json
  FROM ertad.member_referrals r
  WHERE r.invitee_id = actor;

  SELECT
    count(*)::int,
    count(*) FILTER (WHERE r.verified_at IS NOT NULL)::int
  INTO direct_count, direct_verified
  FROM ertad.member_referrals r
  WHERE r.referrer_id = actor;

  WITH RECURSIVE downline AS (
    SELECT r.invitee_id, r.verified_at, 1 AS depth
    FROM ertad.member_referrals r
    WHERE r.referrer_id = actor
    UNION ALL
    SELECT r2.invitee_id, r2.verified_at, d.depth + 1
    FROM ertad.member_referrals r2
    JOIN downline d ON d.invitee_id = r2.referrer_id
    WHERE d.depth < 10
  )
  SELECT
    count(*)::int,
    count(*) FILTER (WHERE verified_at IS NOT NULL)::int
  INTO net_total, net_verified
  FROM downline;

  SELECT COALESCE(sum(e.points), 0)
  INTO pts_earned
  FROM ertad.contribution_entries e
  WHERE e.organization_id = org_id
    AND e.user_id = actor
    AND e.category IN ('referral_join', 'referral_verified', 'referral_l2_verified');

  SELECT COALESCE(jsonb_agg(item ORDER BY joined_at DESC), '[]'::jsonb)
  INTO invitees_json
  FROM (
    SELECT
      r.joined_at,
      jsonb_build_object(
        'displayLabel', ertad.referral_member_label(org_id, r.invitee_id),
        'verified', (r.verified_at IS NOT NULL),
        'joinedAt', r.joined_at,
        'verifiedAt', r.verified_at
      ) AS item
    FROM ertad.member_referrals r
    WHERE r.referrer_id = actor
    ORDER BY r.joined_at DESC
    LIMIT 50
  ) sub;

  SELECT jsonb_build_object(
    'referralJoin', COALESCE((
      SELECT jsonb_build_object('enabled', r.enabled, 'amount', r.amount)
      FROM ertad.contribution_rules r
      WHERE r.organization_id = org_id AND r.category = 'referral_join' AND r.template_id IS NULL
      ORDER BY r.version DESC LIMIT 1
    ), jsonb_build_object('enabled', false, 'amount', 0)),
    'referralVerified', COALESCE((
      SELECT jsonb_build_object('enabled', r.enabled, 'amount', r.amount)
      FROM ertad.contribution_rules r
      WHERE r.organization_id = org_id AND r.category = 'referral_verified' AND r.template_id IS NULL
      ORDER BY r.version DESC LIMIT 1
    ), jsonb_build_object('enabled', false, 'amount', 0)),
    'referralL2Verified', COALESCE((
      SELECT jsonb_build_object('enabled', r.enabled, 'amount', r.amount)
      FROM ertad.contribution_rules r
      WHERE r.organization_id = org_id AND r.category = 'referral_l2_verified' AND r.template_id IS NULL
      ORDER BY r.version DESC LIMIT 1
    ), jsonb_build_object('enabled', false, 'amount', 0))
  ) INTO rules_json;

  RETURN jsonb_build_object(
    'personalCode', my_code,
    'invitedBy', invited_by_json,
    'directCount', direct_count,
    'directVerifiedCount', direct_verified,
    'networkTotalCount', net_total,
    'networkVerifiedCount', net_verified,
    'pointsEarned', pts_earned,
    'rules', rules_json,
    'directInvitees', invitees_json
  );
END;
$$;

-- Trigger referral verification reward automatically when complete_biometric succeeds
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
      'templateVersion', proof.biometric_template_version,
      'verifiedAt', proof.verified_at
    );
  END IF;

  IF op = 'complete_biometric' THEN
    PERFORM ertad.purge_expired_biometric_sessions();

    IF pol.require_device_attestation THEN
      dev_id := input->>'deviceId';
      SELECT * INTO binding
      FROM ertad.mobile_device_bindings
      WHERE member_id = actor AND device_id = dev_id AND status = 'active';
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Active device attestation required';
      END IF;
    END IF;

    sod_ok := COALESCE((input->>'sodCscaVerified')::boolean, false);
    country_val := upper(COALESCE(input->>'citizenshipCountry', ''));
    live_score := (input->>'livenessScore')::numeric(4,3);
    match_score := (input->>'faceMatchScore')::numeric(4,3);
    uniq_hash := input->>'personUniquenessHash';
    tmpl_cipher := NULLIF(btrim(COALESCE(input->>'biometricTemplateCipher', '')), '');
    tmpl_digest := NULLIF(btrim(COALESCE(input->>'biometricTemplateDigest', '')), '');

    IF pol.require_nfc AND NOT sod_ok THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Valid eID NFC SOD/CSCA signature required';
    END IF;
    IF pol.require_georgian_citizen AND country_val <> 'GE' THEN
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

    -- Auto-credit personal referral verification rewards (L1 & optional admin-enabled L2)
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
      'verifiedAt', proof.verified_at
    );
  END IF;

  RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Unhandled M4 command';
END;
$$;

REVOKE ALL ON FUNCTION
  ertad.ensure_member_referral_code(uuid),
  ertad.referral_issue_reward(uuid, uuid, uuid, text, uuid),
  ertad.referral_member_label(uuid, uuid),
  ertad.mobile_referral_command(uuid, text, text, jsonb),
  ertad.mobile_m4_command(uuid, text, text, jsonb)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION ertad.mobile_referral_command(uuid, text, text, jsonb) TO ertad_app;
GRANT EXECUTE ON FUNCTION ertad.mobile_m4_command(uuid, text, text, jsonb) TO ertad_app;
