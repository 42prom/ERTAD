# Web account lifecycle

## Technical containment and independent release

Migrations 55–56 add [Web account protection](WEB_ACCOUNT_SECURITY.md). A separately authorized technical operator can pause an eligible organizational web account, revoke sessions and unused recovery/email-change proofs, then require the owner to recover through the existing contact. A different authorized technical manager can release the exact hold after password rotation. This preserves membership, email, password/MFA policy and organizational authority; release does not revive sessions or clear unrelated restrictions. Protected bootstrap/technical/provisioned-MFA accounts need their separate governed lifecycle. Lost-contact/MFA recovery and complete account-wide disable/restore remain unfinished.

## Personal verified email change

Migration 54 adds **Account security → Sign-in email**, with a new-address proof followed by the requesting account's current password/session confirmation. The old address stays active until that confirmation commits. All sessions and unused recovery links are then revoked; the user signs in normally with the new address and existing password. A non-action security notice is queued for the old address. Original contact history, member binding, permissions, password and MFA state are preserved. Recovery uses the latest proven address. Synthetic/bootstrap/unbound accounts cannot use this flow, and existing Quick Login remains available. See [the full contract and limits](MAIL_POLICY.md#personal-sign-in-email-change-migration-54).

This handles a signed-in person's own verified contact replacement. Lost-contact/second-factor recovery, technical-account enrollment and account-wide disable/restore remain separate work. No manager can substitute another person's address through this interface.

## Personal account security

The `/account` page is available to an authenticated web account independently of organizational memberships or technical-console grants. It does not grant access to organizational or platform data. The sidebar account area links to this page; existing protected domain routes retain their own gates. The retained password hashing, server sessions, CSRF, fresh password confirmation and audit implementation are reused. The legacy global-role account CRUD route remains disabled.

`GET /api/v1/admin/auth/security/sessions` returns at most 25 of the caller's active sessions with a bounded cursor. Only session IDs, creation/last-seen/expiry times and the current-session marker are disclosed. Tokens, CSRF material, IP addresses, user agents and other users' sessions are not returned. These are web-session records, not verified physical-device identities.

`POST .../sessions/revoke` accepts only a session ID. It requires current authentication, CSRF and fresh step-up; the session must belong to the caller and must not be the current session. Repeating the same revocation is safe. The current session uses normal logout. Revocation and audit commit together, with session/account/step-up conditions checked again after audit.

`POST .../sessions/revoke-others` accepts only an empty object. **Close all other sessions** uses the same real-password confirmation and closes every other unrevoked session belonging to the caller, including sessions outside the visible page and expired records. It preserves the current session, existing revocation timestamps, credentials, memberships and other accounts. The response reports only the number newly revoked. The account lock serializes the operation with login session creation; sessions created after it commits are permitted. This is not an account lockout or protection against somebody who still knows the password.

Bulk revocation and its minimal audit event commit together. Current authentication and step-up are rechecked after audit, and no other own session may remain unrevoked at commit. Competing revocations from different own sessions admit one surviving caller. An uncertain result refreshes the list, clears the entered password and confirmation, and never automatically repeats the mutation. Another explicit confirmation may also close sessions created in the meantime. No new schema, permissions or migration are required.

`POST .../password` accepts only a new password. The page first confirms the current password through the existing step-up endpoint; this flow does not use synthetic quick-login step-up. The server enforces the existing password policy, rejects an unchanged password and rechecks the current account and session inside the transaction. Migration 45 exposes a narrow own-account password-rotation function without granting direct password-column writes to the runtime role. Rotation ends all the account's sessions, including the current session, and removes their step-up assurance. Password changes and session revocations roll back if audit or final validation fails.

Login session creation is bound to the password hash actually verified by the login request. If rotation intervenes before session creation, the old request cannot create a new authenticated session. The new session and account are also checked after login audit before issuing a cookie. Concurrent password changes admit one winner; the losing session is no longer authenticated.

No password, password hash, token or contact address is placed in these audit events. Password mutation results that cannot be confirmed are not automatically retried: the page clears entered secrets and directs the user to sign in to establish the current state. A successful change clears the browser's cached authentication metadata and offers normal login. Existing memberships, position bundles and technical grants remain unchanged.

Development and test composition retains password-only login/step-up. Strict authentication composition retains MFA, and production startup remains gated. Local test evidence does not establish production identity, recovery or device acceptance.

## Enrollment state prerequisite

Migration 46 represents new accounts as **MFA not enrolled**: disabled, no enrollment timestamp and no consumed counter. An encrypted provisioning secret may be absent or pending; an enabled account requires both a secret and an enrollment timestamp. Existing rows are preserved exactly, so this migration does not retrospectively certify historical enrollment. No runtime account-creation or secret-provisioning privileges are added.

Password-only development login and step-up never enable MFA, even when a pending secret exists or a code is submitted. Strict login can complete an already provisioned enrollment only after valid password and fresh, non-replayed authenticator proof. That transition has a minimal transactional audit event and a final-state check; failure rolls it back. Strict step-up cannot complete pending enrollment. Session creation additionally binds the strict login to the exact verified secret/counter and checks it again after session audit, preventing an intervening MFA reset from issuing a cookie using stale proof.

New local bootstrap accounts use the pending state without generating an unused authenticator secret or claiming enrollment. Existing bootstrap files, passwords and accounts are preserved. Personal-session/password tests now also run with accounts that have no MFA secret. This is a prerequisite for honest invitation activation, not a new MFA setup/reset interface or an implemented invitation delivery channel. Production startup and mandatory MFA release gates remain unchanged.

## Remaining administrator-management journey

### Recipient password recovery (development, migration 48)

Recipient-initiated password recovery is implemented for accounts activated through the existing synthetic invitation channel. It reuses the immutable contact/account binding, password policy, local mailbox publication, audit and session-revocation primitives. Organizational administrators cannot choose another person's password or redirect recovery to a newly entered contact. This is personal credential recovery, not an organizational appointment, technical account recovery or account reactivation.

`POST /api/v1/admin/recovery/request` accepts only an email and returns the same acknowledgement for eligible and unknown accounts. It never discloses an account ID, recovery ID or credential. The router counts successful and failed requests against the existing configured authentication-attempt budget, using the trusted network rate key. SQL keeps one outstanding request per account without extending its deadline on repeated requests. Owner-run local delivery generates a random, hashed, single-use token. The token is valid for at most 30 minutes from the request; requesting another link cannot revoke a valid existing link or lock out the account.

The login page links to `/recover`; the completion link uses a fragment removed from history on mount. Opening the link does not reset anything. `POST .../recovery/complete` accepts only the recovery ID, token and new password after explicit recipient confirmation. It changes the password and atomically revokes all existing sessions. The request pins the original credential fingerprint so an intervening password change invalidates it. Active account/member/contact binding, expiry, lockout and audit are rechecked at consumption. Suspension, lockout, MFA and organizational restrictions remain intact. Recovery grants no permissions, changes no membership, and does not log in automatically. Unknown outcome clears entered secrets and directs the user to normal login.

The development implementation refuses provisioned/enabled MFA and technical accounts rather than bypassing another factor. Existing bootstrap/Quick Login accounts are not silently enrolled in recovery or reset. Real contact verification, real delivery, lost-contact/second-factor recovery and production acceptance remain separate gates. Synthetic mailbox evidence is not real email ownership verification. `npm run test:recovery` uses a disposable database; `npm run test:recovery:browser` adds the recipient browser journey. See STATUS for executed evidence.

Personal security and migration 47's scoped synthetic invitation/activation journey are implemented for development. Invitation activation binds an eligible existing member without implicit appointment, and creates an account with pending MFA. See [the implemented invitation contract](INVITATIONS.md#implemented-development-journey-migration-47) for delivery and authority boundaries.

Real-contact proof/delivery code and personal verified-email replacement are implemented locally; live provider/domain acceptance remains open. Remaining work includes governed lost-contact/MFA recovery, account-wide disable/restore rules and combined group/region administration acceptance. A person with memberships in multiple regions must not lose unrelated access through one regional manager's action. Technical response and organizational governance remain separate.

The shared group QR invitation and single-person administrator activation contracts are specified separately in [INVITATIONS](INVITATIONS.md). Public group invitations must not become administrator credentials or bypass mobile enrollment/device verification.

### Own pending recovery control (migration 49)

**Account security → Password recovery** shows whether this account is currently eligible for its previously bound recovery channel, and its single active request's creation/expiry and link-preparation state. It never returns a recipient address, token, hash, contact record or another account's request. An unavailable state does not prevent ordinary password/session management or Quick Login. Synthetic contacts use the local mailbox; verified real contacts use the separately enabled security-mail worker.

`GET /api/v1/admin/auth/security/recovery` accepts no account selector and requires a current authenticated session. `POST .../recovery/cancel` accepts only the exact recovery ID and requires Origin/CSRF, fresh password confirmation and explicit user intent. Migration 49 exposes a narrow session-bound function; runtime access to recovery tables remains denied. Cancellation is serialized with consumption and new requests, preserves password/MFA/membership/session state, and commits with a minimal audit event. Final validation detects revocation tampering or loss of current account/session assurance after audit.

Retries target the same request: they cannot revoke a replacement issued later. Unknown and other-account IDs return the same conflict. Consumed requests cannot be cancelled; expired unused requests can be invalidated by their owner. Cancellation does not prohibit future recovery requests and is not an account freeze. Concurrent reset/cancellation can have only one successful outcome. Reads are refreshed after audit, use `no-store`, and contain no credential material. The page refreshes on focus and periodically; loading/failure hides old request data. Changing the request ID invalidates the existing form's submission. Uncertain outcomes clear the form and refresh without automatically repeating a mutation.

The recovery SQL/API runner includes these boundaries and the browser runner exercises owner cancellation followed by a new recovery request and successful reset. See STATUS for executed evidence and local migration state.

## Verification

`npm run test:account` uses an isolated database and actual authentication/SQL/API boundaries. It covers cross-account denial, input/CSRF/step-up gates, concurrent retries and rotation, unchanged/invalid secrets, audit rollback and login/rotation races. `npm run test:account:browser` uses synthetic credentials and a disposable API with local Chrome/Vite; it exercises the personal page without organizational grants, revocation, password change, persisted sign-out and subsequent login. See [STATUS](../STATUS.md) for executed results.
