# Technical control coverage and remaining adaptation

Updated 2026-10-31 against the active ERTAD routes, including migration 37 provider policy and the verified local database restoration drill.

The target is to reuse the source application's useful technical controls comprehensively. Retaining a file is not delivering a functioning ERTAD feature. The technical account owns system security and integrations, without organizational membership, private identity access or authority over organizational decisions.

| Capability | Working ERTAD behavior | Remaining delivery |
|---|---|---|
| Technical console and account separation | Real system health, sanitized journal, separate operator/reviewer, seven development quick logins | Organize growing controls into focused sections without hiding existing tools |
| Web sessions | Filtered live sessions, audited termination, separately approved idle/absolute/concurrent limits | Full incident response workflow and production MFA enrollment |
| Country/IP control | Versioned allow/deny country policy, expiring IP blocks and exceptions, independent approval, verified Cloudflare ingress, localhost recovery | Production ingress acceptance, durable operational alerting |
| API/authentication limits | Independently approved API and login failure budgets, persistent account lockouts, trusted per-address enforcement and history | Shared multi-instance counters and action/enrollment budgets |
| VPN/proxy detection | Editable IPHub policy with encrypted credentials, independent approval, history/restoration, fixed outbound target and bounded lookup/cache; enforced at external login/password confirmation when enabled | Real-key external acceptance, durable alerts and broader provider support; current live policy remains disabled with no provider/key |
| Identity integrations | Inventory distinguishes inactive integrations; simulated assurance fails closed | Reuse NFC/document/liveness/face-match configuration forms, private credential references, configuration history and real provider-specific tests; assurance still needs accepted enrollment evidence |
| Android/iOS integrity | Native/server attestation foundations and negative tests retained | ERTAD package/team/environment policy and challenge binding; server-owned device/member credential registry, revocation and replacement/recovery |
| Mobile device operations | No complete active device-management panel yet | Minimal device status, attestation freshness, credential/session termination and audit; never raw biometrics, push tokens or organizational permissions |
| Push integrations | Source notification forms and token adapters retained | Private provider credentials, scoped test delivery, ownership/rotation, consent and minimal messages; delivery state and retry limits |
| Shield/monitoring | Bounded real API response counters and technical audit; targeted network response | Durable incidents/alerts, provider/WAF integration and bounded response history; no raw-IP dump, full Redis key scan or global limiter deletion |
| Audit integrity and operations | Transactional audit, sanitized journal; local consistent-snapshot restoration compares all 68 tables, runtime table privileges/RLS and function protections, including negative corruption/write probes | Verify the chain, independent external checkpoint receipts, redacted exports, offsite/PITR and attachment/key recovery |

## Next delivery sequence

1. **Security limits and protection policy:** web API/login limits, country/IP controls and reviewed IPHub configuration are active adaptations. Next accept real provider behavior in a controlled environment, add shared counters/durable alerts and separately scope enrollment budgets; retain mandatory authentication/audit checks.
2. **Integration configuration:** expand the current diagnostic inventory into real provider-specific administration. Preserve the source forms and adapters where applicable, keep secrets outside browser responses and audit, constrain external targets, and distinguish configuration, connectivity and verified assurance. Web configuration work is not indefinitely deferred until mobile UI completion.
3. **Mobile credential/device lifecycle and its technical panel:** adapt Android/iOS integrity and enrollment/login/recovery together. Build on real server-owned records before exposing lists/actions. A push-token registration endpoint is not a device registry. Physical-device acceptance remains mandatory.
4. **Push, durable security alerts and operational integrity:** connect actual delivery, incident response, checkpoint verification and restoration. These can reuse existing primitives and must expose real status/failures.

Complete each slice through persisted policy, enforced HTTP behavior, visible controls, negative authorization tests and a browser journey. Do not spend successive slices only on diagnostic inventories while leaving the editable controls disconnected. Do not turn generic legacy settings routes back on to simulate completeness.

The explicitly excluded cryptocurrency/wallet and retired anonymous-voting engine stay excluded. Election-specific device-voter limits become ERTAD action/device policy where applicable; they do not return as obsolete electorate controls. Fake/manual provider choices cannot confer identity assurance. New mobile controls operate only within the member/group-admin product scope; organizational governance remains separate.
