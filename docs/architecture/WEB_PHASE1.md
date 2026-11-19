# Web-management completion gates

Updated 2026-11-10. This is the completion checklist for the accepted web-first phase, not an estimate of total project completion. Existing features are recorded in [STATUS](../STATUS.md); only checked items below are locally verified. Production release and mobile-device acceptance remain separate gates. Work proceeds in this order without adding network/gamification scope.

## 1. Accounts and access lifecycle — in progress

- [x] Own session list, single/all-other revocation and password rotation with audit and fresh authentication.
- [x] Scoped, independently reviewed web invitation and recipient activation using the synthetic local channel.
- [x] Recipient password recovery using that same previously bound synthetic contact.
- [x] Own pending-recovery inspection/cancellation (migration 49), including SQL/API races and the recipient Chrome journey.
- [x] Technical-panel SendGrid/SMTP configuration, independent approval, explicit delivery opt-in and validation without sending ([contract](MAIL_POLICY.md)).
- [x] Scoped reviewed contact association, single-use recipient email proof and separate activation/recovery delivery code; disposable SQL/API tests cover expiry, uncertainty, concurrency and audit/authority failures with an injected provider.
- [x] Revoke/recreate a wrong unactivated recipient contact (migration 53), including old-link invalidation, queue purge, independent replacement review and linked-account protection.
- [ ] Live provider/domain acceptance for recipient-only delivery and its operational failure/abuse handling. A mock provider or local mailbox is not proof of real email ownership or actual inbox delivery.
- [x] Personal verified-email replacement (migration 54): new-address proof plus own password/session confirmation, old-address notice, all-session/recovery invalidation and unchanged member/permission binding. SQL/API checks cover cancellation, expiry, password rotation, cross-account proof, audit rollback/tampering and recovery races. Chrome verifies replacement, new-email login and recovery/reset/login; language/theme/viewport checks pass. Lost-contact recovery remains separate; managers cannot redirect another person's recovery.
- [x] Governed lost-contact/MFA recovery and account-wide disable/restore. A regional membership suspension must not disable unrelated access; technical response must not grant organizational authority.
- [x] Technical containment/release foundation (migrations 55–56): eligible organizational web accounts, separate technical capabilities, all-session/proof invalidation, existing-contact password recovery and another manager's release. Memberships and permissions are preserved; protected technical/bootstrap/MFA accounts and full lost-contact/account lifecycle remain outside this slice.

**Acceptance:** issuer → independent reviewer → intended recipient → normal login → personal maintenance → recovery, plus expired/revoked/contact-changed/audit-failure/competing-request denial. Development Quick Login stays available; production mandatory MFA remains a release gate.

## 2. Daily organizational operations

- [x] Reviewed unit rename/archive and membership transfer/end/suspend/restore foundations.
- [x] Position retirement and controlled adoption of new permission versions.
- [x] Task creation, editing, materials/evidence, verification and contribution linkage foundations.
- [x] Close remaining event editing/rescheduling/cancellation cases, making their effects on linked tasks, participation and rewards explicit.
- [x] Combined lifecycle acceptance across groups, regions, assignments and active work. Preserve history and deny changes outside current authority.

**Acceptance:** permitted changes persist, dependent work receives defined treatment, stale/repeated changes cannot corrupt state, and another region cannot inspect or modify the records.

## 3. Decisions

- [x] Named advisory poll/referendum/multi-question survey/election authoring, draft roundtrip, scoped publication, participation and results foundations.
- [x] Authorized multi-unit audience selection/exclusions and recipient estimates.
- [x] Scheduled opening and full start/end lifecycle.
- [x] Result presentation and scoped reporting; complete remaining authoring tools listed in [POLLS](POLLS.md).
- [x] Anonymous participation/privacy acceptance and its separate contribution linkage.
- [x] Resolve the full V1 nomination/withdrawal and binding-decision contract; advisory results must never silently appoint or grant permissions.

**Acceptance:** eligibility, frozen definitions, quorum/ties, duplicate prevention, result disclosure and lifecycle changes are tested through HTTP and the actual web journey. Anonymous mode requires its own privacy proof, not a label change.

## 4. Reporting and communication

- [x] Scoped shared inbox, operational/task channels, moderation and contribution notices foundations.
- [x] Complete manager-level operational views for pending action, overdue/blocked work and resource shortfalls.
- [x] Privacy-safe reports/exports with the same authority checks as lists/details; enforce bounds and retention.
- [ ] Finish agreed web notification sources and reminders; external delivery needs explicit retry, duplicate and privacy handling. (In-app web inbox sources including `'event'` and 48h reminders are implemented and verified; external push/mail delivery for non-security domain reminders remains deferred.)

**Acceptance:** totals, filters, links, exports and notifications cannot disclose hidden branches or private evidence; read acknowledgements never execute the underlying approval.

## 5. Combined web acceptance

- [x] Execute the complete council/regional/group/technical permission matrix across the above journeys, including revoked/expired authority.
- [x] Review Georgian/English, both themes, keyboard/focus, small/large viewports, and loading/empty/error/uncertain states for changed journeys.
- [x] Run the aggregate integration chain, relevant browser acceptance, `npm run check`, dependency review, smoke and restore checks; record any incomplete checks explicitly.
- [x] Record unresolved V1 gates and production gates before declaring the web phase complete.

**Open V1 & incomplete local checks recorded:**
- **External domain reminder delivery (Block 4.4):** All 8 web inbox sources (`membership`, `unit`, `work`, `collective`, `decision`, `moderation`, `contribution`, `event`) and 48h in-app reminders are complete and verified, while external push/email delivery for non-security operational reminders remains deferred.
- **Additional Chrome runners not re-executed individually in this final cycle:** `test:account-security:browser`, `test:events:browser`, `test:inbox:browser`, `test:operations:browser`, `test:platform:browser`, `decisions-browser`, and `decision-formats-browser` all passed in Chrome; optional extra browser runners (`test:members:lifecycle:browser`, `test:work-editing:browser`, `test:work-recognition:browser`, `test:units:lifecycle:browser`, `test:email-change:browser`) were not individually invoked in Chromium in this final cycle (their SQL/API/unit suites ran and passed inside `npm run test:integration` and `npm run check`).

**Separate production gates:** verified identity/contact assurance, MFA and recovery, key/secret management, external signed audit checkpoints, monitored external delivery, offsite/PITR and object/key recovery, independent security review, accessibility and measured load/failure acceptance. Local passing tests are not certification.
