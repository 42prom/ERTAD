-- M4-H: Sovereign In-House Biometric Policy & Flexible ArcFace Thresholds (0.15–0.99)
-- Removes third-party external biometric provider options, lowers the default ArcFace
-- cosine similarity threshold to 0.400 (40%, where 54% real eID match passes comfortably),
-- and exposes real face_match_score & liveness_score in member_directory_verification_summary.

UPDATE ertad.verification_infrastructure_policies
SET liveness_provider = '3d_face_detector',
    face_match_provider = 'custom_biometric_matcher',
    liveness_min_score = CASE WHEN liveness_min_score = 0.850 THEN 0.700 ELSE GREATEST(0.300, liveness_min_score) END,
    face_match_min_score = CASE WHEN face_match_min_score = 0.800 THEN 0.400 ELSE GREATEST(0.150, face_match_min_score) END,
    credential_cipher = NULL,
    credential_digest = NULL
WHERE id = 1;

UPDATE ertad.verification_infrastructure_proposals
SET liveness_provider = '3d_face_detector',
    face_match_provider = 'custom_biometric_matcher',
    liveness_min_score = GREATEST(0.300, liveness_min_score),
    face_match_min_score = GREATEST(0.150, face_match_min_score),
    credential_cipher = NULL,
    credential_digest = NULL;

ALTER TABLE ertad.verification_infrastructure_policies
  DROP CONSTRAINT IF EXISTS verification_infrastructure_policies_liveness_provider_check,
  DROP CONSTRAINT IF EXISTS verification_infrastructure_policies_face_match_provider_check,
  DROP CONSTRAINT IF EXISTS verification_infrastructure_policies_liveness_min_score_check,
  DROP CONSTRAINT IF EXISTS verification_infrastructure_policies_face_match_min_score_check;

ALTER TABLE ertad.verification_infrastructure_policies
  ALTER COLUMN liveness_min_score SET DEFAULT 0.700,
  ALTER COLUMN face_match_min_score SET DEFAULT 0.400,
  ADD CONSTRAINT verification_infrastructure_policies_liveness_provider_check
    CHECK (liveness_provider = '3d_face_detector'),
  ADD CONSTRAINT verification_infrastructure_policies_face_match_provider_check
    CHECK (face_match_provider = 'custom_biometric_matcher'),
  ADD CONSTRAINT verification_infrastructure_policies_liveness_min_score_check
    CHECK (liveness_min_score >= 0.300 AND liveness_min_score <= 0.990),
  ADD CONSTRAINT verification_infrastructure_policies_face_match_min_score_check
    CHECK (face_match_min_score >= 0.150 AND face_match_min_score <= 0.990);

ALTER TABLE ertad.verification_infrastructure_proposals
  DROP CONSTRAINT IF EXISTS verification_infrastructure_proposals_liveness_provider_check,
  DROP CONSTRAINT IF EXISTS verification_infrastructure_proposals_face_match_provider_check,
  DROP CONSTRAINT IF EXISTS verification_infrastructure_proposals_liveness_min_score_check,
  DROP CONSTRAINT IF EXISTS verification_infrastructure_proposals_face_match_min_score_check,
  DROP CONSTRAINT IF EXISTS verification_infrastructure_proposal_face_match_min_score_check,
  DROP CONSTRAINT IF EXISTS verification_infrastructure_proposals_face_match_min_score_chec;

ALTER TABLE ertad.verification_infrastructure_proposals
  ADD CONSTRAINT verification_infrastructure_proposals_liveness_provider_check
    CHECK (liveness_provider = '3d_face_detector'),
  ADD CONSTRAINT verification_infrastructure_proposals_face_match_provider_check
    CHECK (face_match_provider = 'custom_biometric_matcher'),
  ADD CONSTRAINT verification_infrastructure_proposals_liveness_min_score_check
    CHECK (liveness_min_score >= 0.300 AND liveness_min_score <= 0.990),
  ADD CONSTRAINT verification_infrastructure_proposals_face_match_min_score_check
    CHECK (face_match_min_score >= 0.150 AND face_match_min_score <= 0.990);

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

  RETURN jsonb_build_object(
    'assuranceLevel', COALESCE(proof.assurance_level, 'google_scoped'),
    'citizenshipCountry', COALESCE(proof.citizenship_country, ''),
    'sodCscaVerified', COALESCE(proof.sod_csca_verified, false),
    'livenessScore', proof.liveness_score,
    'faceMatchScore', proof.face_match_score,
    'verifiedAt', proof.verified_at,
    'portraitCipher', proof.portrait_cipher
  );
END;
$$;

REVOKE ALL ON FUNCTION ertad.member_directory_verification_summary(uuid, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.member_directory_verification_summary(uuid, text, uuid, uuid) TO ertad_app;
