# ERTAD mobile migration baseline

The imported Flutter application and native Android/iOS adapters are being adapted in place. The user reports the source application was tested on physical hardware. On 2026-10-04, the ERTAD copy passed formatting, analysis and 54 unit/widget tests using Flutter 3.44.0 / Dart 3.12.0. Locked dependencies verified on 2026-10-03 are unchanged. The local SDK is installed outside the shell PATH at `C:/Users/nakem/flutter/bin`. No Android/iOS build or ERTAD physical-device pass is claimed.

Run from this directory with Flutter 3.44.0 on PATH:

```sh
flutter pub get --enforce-lockfile
dart format --output=none --set-exit-if-changed lib test integration_test
flutter analyze --no-pub
flutter test --no-pub
```

CI includes the same checks using the verified SDK commit. These are retained/adapted baseline tests; they do not establish acceptance of the target ERTAD feature set. This implementation batch has not run in hosted CI.

Startup now blocks on network, forbidden, server, malformed-response or secure-storage failures and offers a Georgian/English retry without erasing credentials. Only HTTP 401 clears an invalid session; error text cannot authenticate or invalidate a session. The retained authenticated poll read is a temporary probe, not the final revocable-session contract. Retry concurrency, disposal, HTTP classification and narrow-screen enlarged text are covered by synthetic tests. Test-service overrides are non-release-only. See [identity/access boundary](../docs/architecture/ACCESS.md).

Wallet functionality and the old election submission/proof/receipt protocol are removed. Reusable option/question screens remain with a localized unavailable notice and disabled submission; there is no synthetic success or offline vote queue. Startup sanitizes all accounts' cached participation history to remove choices, receipts and payout data, erases malformed caches and the old secret, and propagates cleanup failures. NFC/camera/liveness and native attestation adapters remain; challenge forwarding and provider-failure tests use mocked platform channels. Original source stays read-only. New Decisions remains pending after identity and scoped membership.

The development app identity is provisionally `ge.ertad.mobile`, with matching native/Dart attestation channels. No source application signing keys or provider files were copied. The default API points to ERTAD loopback port 13000; Android emulator access can use an explicit `API_BASE_URL=http://10.0.2.2:13000/api/v1`. Device networking, provider registrations and final app identity require their own validation. Release startup is blocked during migration.

Four photographic liveness examples and one animation containing embedded images were withheld for provenance/content review. Splash/enrollment now use `assets/images/ertad-mark.png`; Android adaptive/launcher and iOS app icons are regenerated from this ERTAD mark. The former branded logo and illustration are removed. No real identity records, enrollment captures, private keys or database data were transferred.

The Dart package is `ertad_mobile`. Native channel names match the ERTAD adapters and tests. Existing source-project credentials, attestations and platform registrations are not reused.

Target navigation: Status / Messages / Home / Tasks / Polls. Home is central. Compact profile entry, safe-area footer, system/light/dark preference, Georgian/English. No full platform administration.

During subtraction, the retained destinations are My Activity / Messages / Voting / Settings. The wallet destination is gone. Final Home/Tasks/Status navigation will arrive with its implemented flows; the current four destinations are not the completed V1 navigation.

Tokens: design/tokens.json -> npm run tokens -> lib/core/theme/generated_tokens.dart. The original application still uses its original theme/state composition; adopting ERTAD palettes, Riverpod/Dio and feature boundaries follows the intact transfer. Do not replace the tested onboarding journey with a new empty shell.
