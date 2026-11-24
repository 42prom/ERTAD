-- Migration 0087: Full Encrypted Identity Claims & Unmasked Council Directory View
-- Stores optional encrypted document/personal claims & selfie on ertad.member_verification_documents
-- and exposes encrypted ciphers to authorized scoped directory readers (decrypted server-side in members.ts).

ALTER TABLE ertad.member_verification_documents
  ADD COLUMN IF NOT EXISTS document_number_cipher text,
  ADD COLUMN IF NOT EXISTS personal_number_cipher text,
  ADD COLUMN IF NOT EXISTS legal_name_cipher text,
  ADD COLUMN IF NOT EXISTS date_of_birth_cipher text,
  ADD COLUMN IF NOT EXISTS selfie_cipher text;

CREATE OR REPLACE FUNCTION ertad.mobile_m4_store_doc_claims(
  sid uuid,
  token text,
  input jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid;
  latest_doc_id uuid;
BEGIN
  actor := ertad.review_identity(sid, token, false);
  SELECT id INTO latest_doc_id
  FROM ertad.member_verification_documents
  WHERE member_id = actor
  ORDER BY created_at DESC
  LIMIT 1;

  IF latest_doc_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE ertad.member_verification_documents
  SET document_number_cipher = COALESCE(NULLIF(pg_catalog.btrim(COALESCE(input->>'documentNumberCipher', '')), ''), document_number_cipher),
      personal_number_cipher = COALESCE(NULLIF(pg_catalog.btrim(COALESCE(input->>'personalNumberCipher', '')), ''), personal_number_cipher),
      legal_name_cipher = COALESCE(NULLIF(pg_catalog.btrim(COALESCE(input->>'legalNameCipher', '')), ''), legal_name_cipher),
      date_of_birth_cipher = COALESCE(NULLIF(pg_catalog.btrim(COALESCE(input->>'dateOfBirthCipher', '')), ''), date_of_birth_cipher),
      selfie_cipher = COALESCE(NULLIF(pg_catalog.btrim(COALESCE(input->>'selfieCipher', '')), ''), selfie_cipher)
  WHERE id = latest_doc_id;
END;
$$;

REVOKE ALL ON FUNCTION ertad.mobile_m4_store_doc_claims(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.mobile_m4_store_doc_claims(uuid, text, jsonb) TO ertad_app;

CREATE OR REPLACE FUNCTION ertad.member_directory_verification_summary(
  sid uuid,
  token text,
  org_id uuid,
  target_member_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid;
  proof ertad.member_identity_proofs%ROWTYPE;
  docs_arr jsonb;
  log_arr jsonb;
  doc_count integer := 0;
  dev_count integer := 0;
  google_count integer := 0;
BEGIN
  actor := ertad.review_identity(sid, token, false);
  IF target_member_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM ertad.member_memberships(actor, org_id, target_member_id, NULL)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
  END IF;

  SELECT * INTO proof FROM ertad.member_identity_proofs WHERE member_id = target_member_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT count(*)::integer INTO doc_count
  FROM ertad.member_verification_documents
  WHERE member_id = target_member_id;

  SELECT count(*)::integer INTO dev_count
  FROM ertad.mobile_device_bindings
  WHERE member_id = target_member_id AND status = 'active';

  SELECT count(*)::integer INTO google_count
  FROM ertad.member_google_accounts
  WHERE member_id = target_member_id;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', d.id,
        'documentKind', d.document_kind,
        'documentFingerprint', d.document_fingerprint,
        'issuingCountry', COALESCE(d.issuing_country, ''),
        'sodCscaVerified', d.sod_csca_verified,
        'livenessScore', d.liveness_score,
        'faceMatchScore', d.face_match_score,
        'portraitCipher', d.portrait_cipher,
        'selfieCipher', d.selfie_cipher,
        'documentNumberCipher', d.document_number_cipher,
        'personalNumberCipher', d.personal_number_cipher,
        'legalNameCipher', d.legal_name_cipher,
        'dateOfBirthCipher', d.date_of_birth_cipher,
        'createdAt', d.created_at
      )
      ORDER BY d.created_at DESC
    ),
    '[]'::jsonb
  )
  INTO docs_arr
  FROM (
    SELECT
      id, document_kind, document_fingerprint, issuing_country,
      sod_csca_verified, liveness_score, face_match_score,
      portrait_cipher, selfie_cipher, document_number_cipher,
      personal_number_cipher, legal_name_cipher, date_of_birth_cipher,
      created_at
    FROM ertad.member_verification_documents
    WHERE member_id = target_member_id
    ORDER BY created_at DESC
    LIMIT 10
  ) d;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', s.id,
        'sessionKind', s.session_kind,
        'status', s.status,
        'sodCscaVerified', s.sod_csca_verified,
        'livenessScore', s.liveness_score,
        'faceMatchScore', s.face_match_score,
        'createdAt', s.created_at
      )
      ORDER BY s.created_at DESC
    ),
    '[]'::jsonb
  )
  INTO log_arr
  FROM (
    SELECT id, session_kind, status, sod_csca_verified, liveness_score, face_match_score, created_at
    FROM ertad.biometric_verification_sessions
    WHERE member_id = target_member_id
      AND status <> 'purged'
    ORDER BY created_at DESC
    LIMIT 15
  ) s;

  RETURN jsonb_build_object(
    'assuranceLevel', COALESCE(proof.assurance_level, 'google_scoped'),
    'citizenshipCountry', COALESCE(proof.citizenship_country, ''),
    'sodCscaVerified', COALESCE(proof.sod_csca_verified, false),
    'livenessScore', proof.liveness_score,
    'faceMatchScore', proof.face_match_score,
    'verifiedAt', proof.verified_at,
    'portraitCipher', proof.portrait_cipher,
    'documentCount', doc_count,
    'activeDeviceCount', dev_count,
    'linkedGoogleCount', CASE WHEN google_count > 0 THEN google_count WHEN proof.google_sub_hash IS NOT NULL THEN 1 ELSE 0 END,
    'documents', docs_arr,
    'verificationLog', log_arr
  );
END;
$$;

REVOKE ALL ON FUNCTION ertad.member_directory_verification_summary(uuid, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.member_directory_verification_summary(uuid, text, uuid, uuid) TO ertad_app;

CREATE OR REPLACE FUNCTION ertad.member_directory_profile_360(
  sid uuid,
  token text,
  org_id uuid,
  target_member_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid;
  anon_code text := '';
  contact ertad.member_contact_profiles%ROWTYPE;
  web_email text := '';
  has_web boolean := false;
  google_arr jsonb := '[]'::jsonb;
  devices_arr jsonb := '[]'::jsonb;
  activity_arr jsonb := '[]'::jsonb;
BEGIN
  actor := ertad.review_identity(sid, token, false);
  IF target_member_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM ertad.member_memberships(actor, org_id, target_member_id, NULL)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Access denied';
  END IF;

  anon_code := ertad.member_anon_code(org_id, target_member_id);

  SELECT
    (mu.web_account_id IS NOT NULL),
    COALESCE(au.email, '')
  INTO has_web, web_email
  FROM ertad.member_users mu
  LEFT JOIN ertad.admin_users au ON au.id = mu.web_account_id
  WHERE mu.id = target_member_id;

  SELECT * INTO contact
  FROM ertad.member_contact_profiles
  WHERE member_id = target_member_id;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', a.id,
        'emailHint', a.email_hint,
        'isPrimary', a.is_primary,
        'linkedAt', a.linked_at
      )
      ORDER BY a.is_primary DESC, a.linked_at ASC
    ),
    '[]'::jsonb
  )
  INTO google_arr
  FROM ertad.member_google_accounts a
  WHERE a.member_id = target_member_id;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', d.id,
        'deviceId', d.device_id,
        'platform', d.platform,
        'appId', d.app_id,
        'verdict', d.attestation_verdict,
        'status', d.status,
        'lastAttestedAt', d.last_attested_at,
        'createdAt', d.created_at
      )
      ORDER BY d.created_at DESC
    ),
    '[]'::jsonb
  )
  INTO devices_arr
  FROM (
    SELECT id, device_id, platform, app_id, attestation_verdict, status, last_attested_at, created_at
    FROM ertad.mobile_device_bindings
    WHERE member_id = target_member_id
    ORDER BY created_at DESC
    LIMIT 10
  ) d;

  WITH combined AS (
    SELECT
      'ver:' || s.id::text AS id,
      'verification'::text AS category,
      CASE
        WHEN s.session_kind = 'reauth' THEN 'selfie_reauth'
        ELSE 'eid_verification'
      END AS action,
      s.status::text AS status,
      CASE
        WHEN s.face_match_score IS NOT NULL THEN
          'face=' || round((s.face_match_score * 100)::numeric)::text || '%' ||
          CASE WHEN s.liveness_score IS NOT NULL THEN ' · liveness=' || round((s.liveness_score * 100)::numeric)::text || '%' ELSE '' END
        ELSE ''
      END AS summary,
      s.created_at AS occurred_at
    FROM ertad.biometric_verification_sessions s
    WHERE s.member_id = target_member_id
      AND s.status <> 'purged'

    UNION ALL

    SELECT
      'work:' || we.work_id::text || ':' || we.version::text AS id,
      'work'::text AS category,
      we.action::text AS action,
      'recorded'::text AS status,
      COALESCE(wi.title, '') || CASE WHEN we.note <> '' THEN ' — ' || left(we.note, 120) ELSE '' END AS summary,
      we.created_at AS occurred_at
    FROM ertad.work_events we
    JOIN ertad.work_items wi
      ON wi.organization_id = we.organization_id AND wi.id = we.work_id
    WHERE we.organization_id = org_id
      AND (we.actor_id = target_member_id OR we.subject_id = target_member_id)

    UNION ALL

    SELECT
      'pts:' || ce.id::text AS id,
      'points'::text AS category,
      ce.kind || ':' || ce.category AS action,
      CASE WHEN ce.points >= 0 THEN '+' || ce.points::text ELSE ce.points::text END AS status,
      COALESCE(NULLIF(left(ce.reason, 120), ''), ce.category) AS summary,
      ce.earned_on::timestamptz AS occurred_at
    FROM ertad.contribution_entries ce
    WHERE ce.organization_id = org_id
      AND ce.user_id = target_member_id

    UNION ALL

    SELECT
      'aud:' || al.id::text AS id,
      'audit'::text AS category,
      al.event_type::text AS action,
      'logged'::text AS status,
      COALESCE(al.payload::jsonb->>'reason', al.payload::jsonb->>'operation', al.event_type) AS summary,
      al.created_at::timestamptz AS occurred_at
    FROM ertad.audit_log al
    WHERE (al.payload::jsonb->>'targetMemberId' = target_member_id::text
           OR al.payload::jsonb->>'memberId' = target_member_id::text)
      AND (al.payload::jsonb->>'organizationId' IS NULL OR al.payload::jsonb->>'organizationId' = org_id::text)
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', c.id,
        'category', c.category,
        'action', c.action,
        'status', c.status,
        'summary', c.summary,
        'occurredAt', c.occurred_at
      )
      ORDER BY c.occurred_at DESC
    ),
    '[]'::jsonb
  )
  INTO activity_arr
  FROM (
    SELECT * FROM combined
    ORDER BY occurred_at DESC
    LIMIT 40
  ) c;

  RETURN jsonb_build_object(
    'anonCode', COALESCE(anon_code, ''),
    'hasWebAccount', COALESCE(has_web, false),
    'webEmail', COALESCE(web_email, ''),
    'hasPhone', (contact.phone_cipher IS NOT NULL),
    'phoneCipher', contact.phone_cipher,
    'phoneHint', COALESCE(contact.phone_hint, ''),
    'phoneUpdatedAt', contact.updated_at,
    'linkedGoogleAccounts', google_arr,
    'devices', devices_arr,
    'activityLog', activity_arr
  );
END;
$$;

REVOKE ALL ON FUNCTION ertad.member_directory_profile_360(uuid, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.member_directory_profile_360(uuid, text, uuid, uuid) TO ertad_app;
