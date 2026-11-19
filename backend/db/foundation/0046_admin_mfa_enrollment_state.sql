-- Pending web accounts must not claim MFA enrollment without authenticator proof.
-- Existing account values, credentials, memberships and sessions are preserved.
ALTER TABLE ertad.admin_users
  DROP CONSTRAINT admin_users_mfa_enabled_check,
  ALTER COLUMN mfa_secret_encrypted DROP NOT NULL,
  ALTER COLUMN mfa_enabled SET DEFAULT false,
  ALTER COLUMN mfa_enrolled_at DROP NOT NULL,
  ALTER COLUMN mfa_enrolled_at DROP DEFAULT;

ALTER TABLE ertad.admin_users ADD CONSTRAINT admin_users_mfa_enrollment_state CHECK (
  (mfa_enabled AND mfa_secret_encrypted IS NOT NULL AND mfa_enrolled_at IS NOT NULL)
  OR (NOT mfa_enabled AND mfa_enrolled_at IS NULL AND mfa_last_counter = -1)
);

-- No new runtime grants: secret provisioning and account creation remain denied.
