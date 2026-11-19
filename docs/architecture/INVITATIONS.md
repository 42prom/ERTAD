# Group invitations and administrator activation

Product direction confirmed on 2026-11-04: a group leader should be able to distribute a QR code or invitation code so a person can discover the intended group and request membership. This is a planned member-onboarding journey; no QR enrollment endpoint or invitation grants are enabled by this document. Complete the web-management gate first, then integrate member enrollment and device security. Wider referral networks, automatic rewards, leaderboards and subscription features remain separate later scopes.

## Member invitation contract

An authorized group administrator creates a bounded invitation for their current group, using an explicit scoped invitation capability. The QR represents an opaque URL/code, never a person's identifier, biometric reference, credential, permission bundle or administrator secret. A shared invitation may permit multiple redemptions within its configured expiry/use limits; its administrator can revoke or rotate it. Hierarchy moves, archival or loss of the issuer's authority must be rechecked when issuing and redeeming it.

Scanning reveals only intentionally publishable group information and an explicit choice to continue. It grants no access to members, private channels or organizational data. The user sees which group they are joining before accepting. No silent attribution, tracking or automatic contact-list import is permitted. The system must not infer political preference from scanning or joining.

The intended journey is **invitation → group preview and consent → enrollment/verification → membership request → governed admission → scoped member access**. An existing verified member can request admission without creating another identity. Possession of a code cannot substitute for document authenticity, person continuity, liveness, session validation, device binding or current server authorization. Expiry/revocation during onboarding must fail safely and offer an authorized recovery path.

Redemption requires bounded attempts and abuse limits, non-enumerable codes, duplicate-request protection and transactional use accounting. Inviter attribution is separate from membership, permissions, private profile disclosure and communication authority. Any future invitation reward needs a separately approved, verified-event rule; scanning, unverified registrations and invitation counts alone confer neither points nor governance power.

## Web administrator activation is a different journey

Administrator activation is addressed to one intended person, expiring and single-use. It must bind to the eligible member and approved organizational access without making the issuer choose or learn the recipient's password. Creating an account does not appoint a regional or group leader. Appointment and delegation remain independently governed membership/position operations. Technical accounts remain separate from organizational accounts.

Do not reuse a public reusable group QR as an administrator activation credential. Email/contact changes, account recovery, revocation and account-wide suspension need separate authorization and conflict rules, especially when a person has memberships in multiple regions. Regional authority must not disable an unrelated region's access by changing the shared person's global account.

### Web activation acceptance boundary

The planning default is a recipient-only email activation link. Issuance must use current scoped authority and independent review, pin the eligible member and approved contact destination, and recheck them at activation. Neither the issuer nor the reviewer receives the recipient's activation credential or password. An arbitrary email typed by an administrator is not proof that the existing member owns that address; contact verification and person binding must be explicit acceptance gates. A delivery failure must remain pending/failed rather than claiming that an account was activated.

Use an unpredictable, expiring, single-use secret with a stored hash, bounded attempts and atomic consumption; never place it in audit, ordinary logs, list responses or browser persistent storage. Opening a link must not activate an account. The recipient explicitly chooses a password and confirms activation; duplicate/concurrent submission cannot create multiple accounts or rebind an existing account. Revoke/expiry, a changed destination, suspended member, withdrawn approval or lost issuer authority must deny activation. Account creation creates no membership, appointment, permission bundle or technical grant.

Preserve the existing distinction between development password-only access and production MFA. Migration 46 supports pending enrollment without manufacturing an enrolled secret; password-only login does not change that state. See [account enrollment boundaries](WEB_ACCOUNTS.md#enrollment-state-prerequisite). Recipient MFA provisioning and production acceptance remain unfinished. Delivery, review, recipient activation, cancellation/expiry, account binding and negative SQL/API/browser tests belong to one accepted journey.

### Implemented development journey (migration 47)

The permission-driven **Web invitations** page offers scoped eligible recipients, an explicit creation confirmation, review progress and revocation. The existing collective request and independent review mechanism handles `account_invite`; approval creates an invitation, not an account or appointment. Bootstrap-only `account.invite.propose` and `account.invite.approve` permissions supplement current governance authority. Technical-console access grants neither permission.

Contacts are immutable, pre-bound to an active, unlinked member and current unit. The current transport accepts synthetic `.example.invalid` destinations only. The issuer sees a masked destination, never an activation token. The local owner-run mailbox is a development fixture, not proof of real email ownership or a configured email integration. Real contact verification and recipient delivery remain release prerequisites.

A random 32-byte token is stored only as a hash in the database and expires within 24 hours, bounded further by the contact and approval deadlines. Delivery rechecks current authority and audit, then publishes an exclusive private local message file. It never silently rotates a credential or overwrites an existing message. An uncertain commit or publication retains a private `.pending` file for reconciliation; this is not automatic delivery recovery. See [operating steps](../OPERATIONS.md#local-web-invitations).

The activation URL uses a fragment that the page removes from browser history. Opening it does not submit a request. The recipient enters and confirms their own password, explicitly activates, then uses normal login. The public endpoint retains Origin and rate controls. Activation, member binding, token consumption and audit are atomic; concurrent attempts admit one winner. The new account has pending MFA and no newly created memberships, positions, organizational permissions or technical grants. Existing scoped memberships govern subsequent access.

Delivery and activation recheck member/contact state, membership scope, issuer authority, current independent approvals, deadlines and revocation, including after audit. SQL runtime access is limited to narrow command functions; direct contact/token/account mutation is denied. An uncertain browser result clears secrets and directs the recipient to normal login instead of automatically repeating activation.

`npm run test:invitations` validates these boundaries in a disposable database, including actual local mailbox publication, replay/concurrency, cross-region denial, stale approval, audit rollback and current-authority loss. The browser runner covers the separate issuer/reviewer/recipient journey. Executed evidence and remaining acceptance are recorded in [STATUS](../STATUS.md).

## Delivery order

### Real recipient delivery (migrations 51–52)

The [security email contract](MAIL_POLICY.md#external-security-delivery-migrations-5152) extends the development journey with scoped contact entry, reviewed member/contact association, recipient email proof and separate activation mail. Technical management independently enables the configured sender/SMTP or SendGrid integration and public HTTPS origin. The API worker handles bounded durable attempts, while organizational managers see scoped proof/delivery state. Provider acceptance does not establish inbox delivery. Synthetic contacts remain local-only; no existing contact/account is silently rewritten. Contact replacement, lost-contact/MFA recovery and production identity assurance remain separate gates.

1. Finish web personal credential/session controls, then scoped administrator activation/recovery and the corresponding organizational assignment journey.
2. Finish remaining web-management acceptance, including group lifecycle, domain workflows and consistent scoped reporting.
3. Implement group invitation issuance/revocation and preview/redemption together with the accepted member onboarding API and mobile app; do not publish a QR leading to an unavailable enrollment flow.
4. Carry the retained native attestation/key adapters, server validators and negative tests together. Verify fresh action binding, app/environment/subject identity, replay/counter protections, key revocation, device replacement and fail-closed provider outages. Attestation is evidence, never independent authority. Physical-device acceptance remains necessary for changed ERTAD behavior.
