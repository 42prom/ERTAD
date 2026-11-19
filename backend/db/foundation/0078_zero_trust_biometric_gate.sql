-- M4-F: Server-Enforced Zero Trust Biometric Gate
-- Verifies member_identity_proofs.assurance_level = 'biometric_verified' and active device state
-- before allowing access to private/group chats, voting, or task/event participation writes.

CREATE OR REPLACE FUNCTION ertad.mobile_biometric_gate_check(
  sid uuid,
  token text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid;
  pol ertad.verification_infrastructure_policies%ROWTYPE;
  proof ertad.member_identity_proofs%ROWTYPE;
  has_blocked_device boolean := false;
BEGIN
  actor := ertad.review_identity(sid, token, false);
  SELECT * INTO pol FROM ertad.verification_infrastructure_policies WHERE id = 1;

  IF pol.auth_profile = 'google_only' THEN
    RETURN jsonb_build_object('allowed', true, 'reason', 'google_only_policy');
  END IF;

  SELECT * INTO proof FROM ertad.member_identity_proofs WHERE member_id = actor;
  IF NOT FOUND OR proof.assurance_level <> 'biometric_verified' THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'BIOMETRIC_VERIFICATION_REQUIRED');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM ertad.mobile_device_bindings
    WHERE member_id = actor AND status IN ('held', 'revoked')
  ) INTO has_blocked_device;

  IF has_blocked_device THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'DEVICE_HELD_OR_REVOKED');
  END IF;

  RETURN jsonb_build_object('allowed', true, 'reason', 'biometric_verified');
END;
$$;

REVOKE ALL ON FUNCTION ertad.mobile_biometric_gate_check(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ertad.mobile_biometric_gate_check(uuid, text) TO ertad_app;
