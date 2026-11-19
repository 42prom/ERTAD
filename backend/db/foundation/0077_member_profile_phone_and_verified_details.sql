-- M4-E: Member Personal Profile (Verified eID Attributes + Encrypted Phone Number)
-- Phone numbers are stored strictly with AES-256-GCM encryption; only a masked hint is returned.

CREATE TABLE IF NOT EXISTS ertad.member_contact_profiles (
  member_id uuid PRIMARY KEY REFERENCES ertad.member_users(id) ON DELETE CASCADE,
  phone_cipher text,
  phone_hint text NOT NULL DEFAULT '' CHECK (length(phone_hint) <= 40),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

REVOKE ALL ON TABLE ertad.member_contact_profiles FROM PUBLIC;

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
BEGIN
  IF op IS NULL OR op NOT IN ('get', 'set_phone') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid profile command';
  END IF;

  actor := ertad.review_identity(sid, token, false);

  IF op = 'set_phone' THEN
    clear_phone := COALESCE((input->>'clear')::boolean, false);
    IF clear_phone THEN
      INSERT INTO ertad.member_contact_profiles (member_id, phone_cipher, phone_hint, updated_at)
      VALUES (actor, NULL, '', clock_timestamp())
      ON CONFLICT (member_id) DO UPDATE
        SET phone_cipher = NULL,
            phone_hint = '',
            updated_at = clock_timestamp();
    ELSE
      p_cipher := NULLIF(btrim(COALESCE(input->>'phoneCipher', '')), '');
      p_hint := left(btrim(COALESCE(input->>'phoneHint', '')), 40);
      IF p_cipher IS NULL OR p_hint = '' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Encrypted phone payload required';
      END IF;
      INSERT INTO ertad.member_contact_profiles (member_id, phone_cipher, phone_hint, updated_at)
      VALUES (actor, p_cipher, p_hint, clock_timestamp())
      ON CONFLICT (member_id) DO UPDATE
        SET phone_cipher = EXCLUDED.phone_cipher,
            phone_hint = EXCLUDED.phone_hint,
            updated_at = clock_timestamp();
    END IF;
  END IF;

  SELECT * INTO proof FROM ertad.member_identity_proofs WHERE member_id = actor;
  SELECT * INTO contact FROM ertad.member_contact_profiles WHERE member_id = actor;

  RETURN jsonb_build_object(
    'assuranceLevel', COALESCE(proof.assurance_level, 'google_scoped'),
    'sodCscaVerified', COALESCE(proof.sod_csca_verified, false),
    'citizenshipCountry', COALESCE(proof.citizenship_country, ''),
    'hasStoredTemplate', (proof.biometric_template_cipher IS NOT NULL),
    'googleLinked', (proof.google_sub_hash IS NOT NULL),
    'verifiedAt', proof.verified_at,
    'hasPhone', (contact.phone_cipher IS NOT NULL),
    'phoneHint', COALESCE(contact.phone_hint, ''),
    'phoneUpdatedAt', contact.updated_at
  );
END;
$$;

REVOKE ALL ON FUNCTION ertad.mobile_profile_command(uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.mobile_profile_command(uuid, text, text, jsonb) TO ertad_app;
