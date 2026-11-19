# Technical integration inventory and diagnostics

The [Email service panel](MAIL_POLICY.md) adds versioned sender/SendGrid configuration and a bounded sandbox diagnostic under the existing technical capabilities. Real mail delivery, contact proof and SMTP remain unfinished.

Migration 33 adds explicit `platform.integrations.read` and `platform.integrations.test` capabilities to the separated technical account model. It does not activate any provider, seed a grant, accept a credential or change organizational authority. The local installer option `npm run platform:bootstrap -- --integrations` adds diagnostic authority to an existing active technical grant without changing its expiry, revocation or password; reruns are idempotent.

## Runtime contract

`GET /api/v1/admin/platform/integrations` returns an allowlisted inventory. `platform.read` and `platform.integrations.read` are both required. Infrastructure entries derive from the actual application's registered dependency checks. Loaded configuration means a runtime binding exists, not that its credentials, permissions or availability have been verified. Identity, attestation, push, Shield and external checkpoint entries explicitly describe their inactive status in the current API composition and their outstanding activation gates. Environment values and the old inactive settings tables are not represented as active configuration.

`POST /api/v1/admin/platform/integrations/check` accepts only `{target: "postgres" | "redis" | "storage"}`. It requires the separate test capability, the current authenticated browser session, Origin and CSRF. A route limit permits twelve requests per minute per IP in addition to the existing application limit. The server calls only its pre-registered check, with a two-second outer deadline; callers cannot supply a URL, API key, filesystem path, provider name, identity sample or arbitrary HTTP request. Existing concrete dependency clients retain their own timeouts.

Authorization and required audit precede the check; authorization and required outcome audit run again after it. A revoked/expired grant or failed audit withholds the diagnostic result. Audit records contain only operator reference, fixed operation/target and the bounded result (`requested`, `ready`, `unavailable`, `not_configured`). Endpoint/error/credential details are never returned. Requested and completed checks are separate events: an interrupted check must not be presented as completed. Diagnostic results are request-time observations; the browser clears them on inventory refresh, failed authorization and unmount, and ignores late responses from superseded views. There is no claim of continuous monitoring or durable latest-status storage.

The database check verifies the expected migration presence; Redis checks its configured connection with PING; storage checks its existing health endpoint. These checks do not prove all database permissions, S3 object access, biometric accuracy or identity assurance. A successful availability check must never mark a person, passport or mobile device as verified.

## Retained provider boundaries

Inspection found simulated success in the retained remote liveness/face-match implementations and their legacy connection-test endpoint. The remote adapters now fail closed without returning scores, transmitting media or accepting a configured key as verification. Unused mock-success classes were removed. Unsupported provider names no longer silently select an alternate implementation. The retained local liveness adapter also fails closed: face presence and a client-side blink/movement result do not establish accepted server-side PAD. The actual local face-match adapter remains available for later adaptation and testing.

The legacy verification connection-test endpoint now returns an explicit inactive-provider conflict. The active ERTAD composition still denies the entire legacy settings API. No remote vendor contract, production biometric assurance or physical-device acceptance was added by this change. The read-only source application was not modified.

## Next delivery

The first versioned security configuration consumer is the [approved web-session policy](SESSION_POLICY.md): bounded durations/concurrency, independent approval, version history and restoration through a new proposal. Provider settings and protected credential references remain later slices. Configuration editing must be connected to an accepted runtime consumer; inactive settings must not be saved merely to make a form appear functional. No generic URL tester or unrestricted settings editor is planned. Real remote providers require their actual protocol, action-bound evidence, negative acceptance tests and authorized credentials before activation.

## Editable VPN/proxy provider (2026-10-31)

The first real provider configuration is available in [Provider settings](PROVIDER_POLICY.md): independently reviewed IPHub selection, encrypted key replacement and effective external-authentication enforcement. The integration inventory links to this page for authorized accounts. Identity, attestation and push entries remain inactive; infrastructure diagnostics retain their original bounded targets. Earlier statements about absent configuration describe the pre-migration-37 inventory.
