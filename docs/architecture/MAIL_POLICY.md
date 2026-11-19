# Technical email configuration

## Personal sign-in email change (migration 54)

**Account security → Sign-in email** manages only the current account. Eligibility requires an active member/account bound through a consumed invitation to an active, verified email contact. Bootstrap, synthetic and unbound technical accounts remain unavailable; Quick Login is unchanged. A new request additionally requires approved, enabled real delivery. It accepts a request UUID and normalized address, never an account/member selector. The old address remains canonical until completion. Requests expire within 30 minutes and the original contact lifetime, with one pending request and at most three creations per account/hour. Exact request-key retries preserve the receipt and deadline. Explicit cancellation requires the current password and the immutable request ID; it cannot cancel a replacement.

The worker sends a distinct `/verify-email-change#<id>.<token>` proof. Opening the link clears the fragment and changes nothing. Completion requires the requesting account's current session, Origin/CSRF, fresh actual password confirmation, explicit intent, the proof and the exact pending new address. A guest must sign in and reopen the email link. Another signed-in account or a mailbox holder without the account password cannot complete it. Expired/revoked source binding, intervening password rotation, an occupied address or changed authority denies completion without redirecting recovery.

Confirmation, canonical login-address update, all-session revocation, invalidation of unused recovery requests, proof-token purge, old-address security-notice enqueue and required audit commit atomically. Post-audit account/source/session checks fail closed. Organizational memberships, positions, permissions, password and MFA state are preserved. The original invitation contact remains immutable history; recovery resolves the account's latest confirmed address through its original member binding. Login session creation binds both the password hash and the email actually authenticated, before and after audit.

The old-address notice has no action token, new address or reversal link. It points to the ordinary account page and advises known-channel support for unexpected changes. Its internal queue nonce is never included in the message. Notice enqueue remains mandatory when delivery is paused; the existing worker can send for at most 24 hours after confirmation. Provider/network ambiguity is not retried automatically and cannot roll back an already committed identity change. Provider acceptance remains distinct from inbox delivery. Pending-state reads expose neither proof tokens nor credential fingerprints, and audit payloads omit addresses.

Run `npm run test:email-change` for the disposable SQL/API matrix and `npm run test:email-change:browser` for the recipient journey. Lost-contact/second-factor recovery, account-wide disable/restore, live-provider acceptance and production retention remain separate gates. This self-service flow is not an administrator override of another person's contact.

## Pending-contact correction (migration 53)

On **Web invitations**, select an email recipient and use **Revoke recipient contact**. The labelled native dialog pins the immutable contact, member/unit and masked destination; revocation requires explicit intent and the manager's current password. The server accepts only organization/contact IDs and rechecks the active session, current scoped invitation-proposal authority, active membership and the member's unlinked account state.

Revocation preserves the old contact and proposal history. It revokes its unused invitations, cancels queued/retry mail and purges remaining encrypted tokens. An in-flight message may already have reached the provider; old proof/activation links still fail against the revoked source. No message recall is claimed. A corrected address creates a new immutable contact and needs a new independent invitation approval and recipient proof. A repeated old-contact command cannot target the replacement.

An activated account, its contact, credentials, sessions, memberships, grants and recovery binding are outside this operation. Activation and revocation serialize: activation wins and revocation is denied, or revocation wins and activation is denied. Required audit and final eligibility checks commit with the contact/invitation/queue changes; failure rolls everything back. While the caller and member remain eligible, a repeated completed revocation returns its result without adding another audit event or extending the original revocation timestamp. The UI clears entered secrets, refreshes state on uncertain outcomes and never retries a mutation automatically.

Run npm run test:contacts for the disposable SQL/API matrix and npm run test:contacts:browser for contact correction through Chrome. Activated-account changes use the separate personal flow above; lost-contact recovery remains separate work.

## External security delivery (migrations 51–52)

The technical panel additionally supports **SMTP** through fixed SendGrid, Google/Gmail and Microsoft 365 endpoints. SMTP requires STARTTLS on port 587, valid certificates/TLS 1.2+, bounded connection/greeting/socket timeouts and provider-supported credentials. SMTP logging, file reads and URL content access are disabled. Arbitrary hosts/ports and unreviewed message templates/attachments are not accepted. The SMTP check validates authentication without sending; SendGrid retains its sandbox check. Live vendor compatibility still needs the operator's configured account and credentials.

**Enable real email delivery** is a separate, independently approved choice, alongside the public application HTTPS origin. Existing approved policies acquire delivery-disabled defaults. Links use this reviewed origin, never a request Host/Origin header. It must identify the reachable ERTAD application without a path/trailing slash. Secrets stay in the panel's encrypted store. Changing provider, SMTP service or username requires a replacement credential. A retained credential is available only for the exact current provider/service/username.

### Recipient journey

An authorized organizational manager opens **Web invitations → Add member email**, selects an active unlinked member in their scope, enters the address supplied by that member, confirms consent and their own password, then creates the invitation. Another currently authorized manager independently reviews the immutable member/contact association through the existing invitation approval. This is governed contact association, not legal-identity or biometric proof.

After approval, the worker first sends an email-proof link. The public /verify-email page removes the fragment credential from history and requires explicit confirmation. The token expires within 30 minutes, is single-use and cannot activate an account. Confirmation and audit commit together; stale/revoked authority, contact/member changes or an expired link deny confirmation. A separate activation message follows, using a different token and the existing recipient password-selection flow. Account creation grants no new membership or organizational/technical permissions. Password recovery uses the same verified immutable contact after activation. Existing synthetic contacts keep the local-only mailbox.

### Durable delivery

The existing API process runs a bounded queue worker every 15 seconds. PostgreSQL owns jobs, source binding, token hash, encrypted temporary token, deadlines, attempt state and leases. Runtime cannot select/mutate the job/contact tables directly. Source authority and deadlines are rechecked on preparation and immediately before the attempt, including after required audit. The worker's server-side message adapter accepts only a selected recipient, fixed security purpose and opaque one-time link; no organizational labels, documents, ballots or tracking metadata reach the provider.

Queue states are queued, sending, retry, accepted, failed, uncertain and cancelled. SMTP acceptance or SendGrid 202 means provider acceptance, not confirmed inbox delivery. Only an explicit retryable rejection (SendGrid 429 / SMTP 4xx) schedules bounded exponential backoff, with at most five attempts and one unchanged token. Network errors, interrupted sending leases and uncertain outcome commits never automatically repeat the network effect. Accepted/failed/uncertain/cancelled jobs purge the encrypted token; token hashes remain for replay protection. Expired pending jobs are cancelled. A later valid queued/retry attempt uses the latest independently approved enabled policy, pinning its version for the attempt; disabling delivery pauses eligible pending work.

Concurrent workers claim a job once. Audit failure before an attempt prevents sending. Outcome recording is a separate database transaction and retries only a rolled-back database deadlock, never the provider call. Configuration/source changes during the final authorization/audit check deny the attempt. Authority can change after the send begins; the recipient's proof, activation and recovery endpoints still recheck current authority before acting.

Technical managers see aggregate queue counts without recipient addresses or source IDs. Scoped organizational invitation rows show email-proof and delivery state for their permitted recipients. Recipient credentials never appear in list responses, logs or ordinary audits. Unknown results are not silently presented as delivery or activation success.

### Operational limits

This slice does not replace already bound contacts, recover lost MFA/contact access, reactivate disabled accounts, provide vendor bounce/delivery webhooks or certify sender-domain ownership. A failed/uncertain invitation can be revoked and issued anew under current approval; recovery retains its bounded existing request deadline. Migration 53 adds revocation/recreation of a wrong unactivated contact as described above. Production retention/purge policy for historical metadata, secret-manager rotation, provider acceptance, abuse review and production MFA remain release gates. The development quick-login flow is preserved.

Run npm run test:mail:delivery for disposable SQL/API/queue acceptance and npm run test:mail:delivery:browser for the issuer/reviewer/recipient Chrome journey. These tests use artificial recipients and an injected provider; they send no real email.

The following sections describe the original migration-50 checkpoint; the transport and delivery additions above supersede its earlier limitations.

The technical console exposes **Email service** at `/platform/email`. Migration 50 introduced versioned sender/provider proposals and SendGrid sandbox validation. Configuration is managed in the panel, without writing provider credentials to `.env`. Migrations 51–54 extend this foundation with the separately enabled SMTP/delivery and recipient-proof journeys described above.

## Permissions and approval

The existing separated technical-account capabilities apply: `platform.providers.read` reads the policy/history, `platform.providers.propose` proposes or withdraws an own change, and `platform.providers.approve` independently approves/rejects another operator's proposal. `platform.integrations.test` additionally authorizes sandbox checks. Every operation requires a current technical account and web session; mutations/checks require fresh password confirmation and Origin/CSRF controls. No organizational administrator gains access through a role name. Migration 50 grants no new account permissions.

A proposal contains the expected current version, provider (`none` or `sendgrid`), mode (`off` or `enabled`), sender name/email, an optional replacement API key, reason and request UUID. The API accepts only these bounded fields. A blank key retains the currently approved key; selecting `none` clears the active key. Historical proposals retain encrypted credentials; clearing the active key is not a purge of history or revocation at the vendor. Revoke compromised keys at the provider as well.

Configuration changes require another currently authorized technical reviewer. Reviewers see the proposed provider, mode, sender, key-presence indicator and base version, never the secret. Proposals expire after 24 hours. Concurrent approvals serialize, stale versions conflict, and revoked proposers cannot be approved. Exact repeated requests return the original receipt without applying a second change. Unknown browser outcomes refresh the list without automatically retrying a mutation.

## Credential and audit boundary

Credentials use the existing authenticated encryption service; a domain-separated keyed digest compares exact request retries without storing plaintext. Neither API projections nor audit records expose ciphertext, credential digests or API keys. Audit events omit sender addresses. Runtime cannot directly select or mutate proposal rows; its internal approved-policy function supplies ciphertext solely to the server adapter. Required audit, live authority checks and policy writes share a transaction. Audit failure or post-audit revoked authority rolls back the mutation.

## Sandbox validation

The explicit **Validate without sending** action checks the selected effective version. The server authenticates and audits before the request, reads the approved configuration and rechecks authority/version after the result. No caller URL, recipient or message body is accepted. There is a three-per-minute route limit and a five-second provider timeout. The fixed HTTPS SendGrid endpoint refuses redirects, uses an artificial `example.invalid` recipient, enables sandbox mode and disables tracking. Only the sandbox success status is reported as `valid`; other responses/timeouts become a generic unavailable result. Raw provider errors are not disclosed.

This check is not message delivery, domain verification or proof of address ownership. Enabling a policy does not start mail delivery. Diagnostic results are observations for that version; refreshing configuration or losing access removes the displayed result.

## Verification and next integration

`npm run test:mail` exercises a disposable database and real HTTP session/CSRF/step-up boundaries, encrypted storage, independent review, idempotency, policy conflicts, key retention/clearing, expiry, revoked authority, audit rollback and SQL ACLs. Provider HTTP is mocked; no real message or credential is sent. `npm run test:mail:browser` additionally checks proposal/review persistence through Chrome, masked inputs, keyboard/focus and both languages/themes at four viewport widths. Unit tests cover fixed-origin sandbox behavior and failure cases; web component tests cover permissions, secret clearing and uncertain outcomes.

The approved policy is now bound to durable recipient security delivery and the tested SMTP adapter described above. Remaining operational gates include vendor account/domain setup, actual delivery acceptance, monitored failures/bounces, production secret rotation and retention. These are outside the evidence from local injected-provider tests.
