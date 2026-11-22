# ERTAD V1 Production & Store Launch Checklist

> Operational runbook for Technical Administrators and Release Engineers.
> Scope: V1 Core (I1–I18 mandatory). Never commit real secrets, keystores, or identity/biometric data to Git.

---

## 1. Technical Administrator Console (`/platform`)

All external service credentials are stored with **AES-256-GCM** encryption in PostgreSQL and require **two-person technical approval (`Propose → Approve`)**. Secrets are never returned to the browser.

- [ ] **Google OIDC (`/platform/integrations → Google OIDC`)**
  - Create Android & iOS OAuth 2.0 Client IDs in Google Cloud Console (register Release SHA-1 / SHA-256 signing fingerprints).
  - Propose & approve `androidClientId` and `iosClientId` in `/platform/integrations` and enable `google_oidc`.
- [ ] **Firebase Push (`/platform/integrations → Firebase Push (FCM)`)**
  - Configure `projectId` and Service Account OAuth token/key; enable `fcm_push`.
  - Place production `google-services.json` (Android) and `GoogleService-Info.plist` (iOS) in CI/release secrets (never in public Git).
- [ ] **Optional Messaging Channels (`/platform/integrations`)**
  - **Telegram Bot:** Enter `@botUsername` + Bot Token (`telegram_bot`).
  - **WhatsApp Business API:** Enter Meta `phoneNumberId` + Permanent Access Token (`whatsapp_business`).
  - **Viber Bot:** Enter `senderName` + Viber Auth Token (`viber_bot`).
- [ ] **Biometric & Device Policy (`/platform/verification`)**
  - Review `requireDeviceAttestation`, `requireNfc`, `requireGeorgianCitizen`, `livenessMinScore`, `faceMatchMinScore`, and `biometricTtlSeconds`.
  - Verify two-person approval is active (self-approval is blocked at SQL & API layers).
- [ ] **Security Email (`/platform/email`)**
  - Configure SendGrid or STARTTLS SMTP credentials, verify public HTTPS origin, and approve delivery enablement.

---

## 2. Council Governance Setup (`/contribution`, `/units`, `/positions`)

Council members hold zero technical/credential authority and configure organizational rules only:

- [ ] **Contribution & Referral Point Rules (`/contribution`)**
  - Approve initial point values and monthly caps for:
    - `task` (Verified task participation)
    - `vote` (Voting participation)
    - `survey` (Survey completion)
    - `manual` (Individual recognition)
    - `referral_join` (Personal referral signup)
    - `referral_verified` (Personal referral eID biometric verification)
    - `referral_l2_verified` (Optional level-2 referral verification)

---

## 3. Production Infrastructure & Security Gates

- [ ] **Database (PostgreSQL 16+)**
  - Run all migrations (`0001..0083`) with owner role; runtime API connects strictly as least-privilege `ertad_app`.
  - Enable automated PITR backups and verify periodic restore drills (`npm run restore:drill` — locally verified: 105 tables, 83 migrations, ACL/RLS/audit checks).
- [ ] **Secrets & Key Custody**
  - Manage `API_KEY_ENCRYPTION_SECRET`, `JWT_SECRET`, DB credentials, and Redis password via Vault/KMS/HSM (never `.env` files in Git).
- [ ] **Network & TLS**
  - Terminate TLS 1.3 at reverse proxy / WAF; set `NODE_ENV=production`, `ERTAD_LOCAL_ADMIN=false` (or scoped production routing), `ERTAD_NETWORK_CONTROL=true`, and verified `TRUST_PROXY`.
- [ ] **Audit Chain Checkpoints**
  - Periodically verify and export signed SHA-256 `audit_log` checkpoints from `/platform/audit`.

---

## 4. Mobile Store Release (Android & iOS)

- [ ] **Android Release Build (`ge.ertad.mobile`)**
  - Configure Play App Signing / release keystore (`mobile/android/key.properties`, gitignored).
  - Build without dev flags: `flutter build appbundle --release` (ensures `kReleaseMode == true`, disabling Dev Quick Login and dev bypasses).
  - Verify Play Integrity API verdict in Google Play Console.
- [ ] **iOS Release Build**
  - Enable App Attest & NFC Tag Reading entitlements in Xcode (`Runner.entitlements`).
  - Build archive on macOS (`flutter build ipa --release`) and verify TestFlight + App Store Connect review.
- [ ] **Physical Device Field Acceptance**
  - Complete end-to-end Georgian eID card scan (MRZ + NFC SOD/CSCA + 3D Liveness + encrypted template storage + biometric re-auth) on physical Android and iOS devices.
  - Verify opt-in Push / Telegram / WhatsApp / Viber delivery via `notificationDispatcher`.
