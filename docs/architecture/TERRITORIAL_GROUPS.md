# Territorial organization and group workspace

Planning decision: 2026-11-26, [ADR-024](DECISIONS.md#adr-024---territorial-catalogue-organizational-groups-and-member-workspace). This document specifies a staged V1 extension; it does not activate membership, new endpoints, channels or geography data. Implementation follows the existing web-first delivery gates. Runtime evidence belongs in [STATUS](../STATUS.md).

## Product model

ERTAD coordinates local communities, practical work, events and eligible participation. Location, organizational authority, membership and communication therefore have distinct meanings:

| Concept | Purpose | Authority consequence |
|---|---|---|
| Geographic area | Shared region/city, municipality/district and optional settlement reference | Choosing an area grants nothing |
| Organizational unit | One organization-owned node with one authority parent | Explicit current permissions govern its unit/subtree |
| Membership | A person's governed relationship to a unit and versioned position | Admission grants only the approved member capabilities |
| Professional/project affiliation | Collaboration across local branches | No second geographic authority parent or automatic territorial authority |
| Channel | Conversation or announcements owned by a unit, or an existing task/private room | Current channel/domain authorization determines access |
| Active workspace | The authorized group currently open in the app | Switching changes presentation, never membership or authority |

Example organizational tree:

```text
Organization
  Tbilisi regional unit
    Saburtalo district unit
      Local group A
        Working team
      Local group B
  Kakheti regional unit
    Municipality unit
      Local group C
```

This is an organizational example, not a complete administrative classification. The geographic catalogue supports the actual area's type and parentage rather than forcing every location into identical levels. Organizational containers need only be activated where operations require them. Multiple local groups may serve the same area; do not manufacture an empty group or chat for every catalogue entry.

## Existing implementation and gaps

| Boundary | Inspected implementation | Required extension |
|---|---|---|
| Authority tree | [`units` schema](../../backend/db/foundation/0003_scoped_membership.sql), [reviewed child creation](HIERARCHY.md), [`units.ts`](../../backend/src/modules/organization/units.ts) | Explicit operational level, geographic binding and validated parent/type choices |
| Member lifecycle | [Membership lifecycle](MEMBERSHIP_LIFECYCLE.md), [position definitions](POSITIONS.md) | Member admission request and a primary local-group designation without self-grants |
| Channels | [`channels.ts`](../../backend/src/modules/communication/channels.ts), [current group/global authorization](../../backend/db/foundation/0082_flagship_messaging_and_private_rooms.sql) | Main-group channel provisioning and explicit descendant announcement selection |
| Mobile location | [`region_selection_sheet.dart`](../../mobile/lib/widgets/region_selection_sheet.dart), [`org_context_sheet.dart`](../../mobile/lib/core/shell/org_context_sheet.dart) | Replace the locally saved flat region choice with catalogue selection and server-owned membership context |
| Mobile workspace | [`shell_providers.dart`](../../mobile/lib/core/state/shell_providers.dart) selects an organization and loads permitted domain lists | Select an organization + group pair, with group-aware requests, navigation and cache isolation |

These are source inspection findings, not a claim that the planned end-to-end journey or its security tests already pass. Existing `global` channel semantics and domain visibility must be examined before extension; renaming a channel or filtering a list in the client is insufficient.

## Data and authority contract

1. Add a minimal, versioned `geographic_areas` reference catalogue with stable identifiers, typed parent relationships, Georgian/English labels, source identifiers and active/retired state. Geography is shared reference data; memberships and units remain organization-owned. Retired references preserve historical bindings. Names are labels, never join keys; region codes must not be treated as unit UUIDs.
2. Verify the complete catalogue against official sources before import: [Geostat regional/self-governing-unit data](https://www.geostat.ge/ka/modules/categories/41/mosakhleoba) and [Tbilisi district administration references](https://www.tbilisi.gov.ge/contacts). Record source date, scope, reconciliation and ambiguous/de jure/operational distinctions. Do not guess missing boundaries or silently omit territories. No exact unit counts are asserted by this plan.
3. Extend existing `units` additively with a geographic reference and an operational classification for organizational root, regional container, municipality/district container, local group and team. Preserve `kind = authority | professional | project`; geographic level is not a replacement for that distinction. Final SQL names are chosen with the first implementation slice.
4. Every organizational unit retains one parent in the same organization. Allowed parent/type and geographic-containment rules are enforced in SQL and API: local groups belong below the applicable territorial container; teams belong below their group. Reject cycles, archived parents, cross-tenant links and incompatible areas. A child normally inherits its parent's area; a more specific valid area may be chosen. Professional/project affiliations do not acquire a second authority parent.
5. Geographic catalogue changes do not reparent units, transfer people or modify permissions automatically. Existing hierarchy-move and populated-archive restrictions remain intact. No migration rewrites old migration checksums or derives geography from a unit's name.
6. Use existing memberships, positions, permission versions, typed reviews, audit and command retry mechanisms. No parallel member/group permission store, chat engine, generic audience framework or speculative services.
7. Designate at most one primary local membership per person per organization as the normal Home context. This is a preference over authorized local memberships, not a ban on other approved memberships. Validate the membership server-side; primary designation cannot extend expiry, change position or admit the person. Concurrent changes must preserve uniqueness. Ending the primary membership clears the designation; the app offers remaining authorized choices instead of silently joining another group.

## Member journey

The three separate actions are **choose an area**, **request admission**, and **open an existing membership**.

- Area selection uses the shared catalogue: region/city, then applicable municipality/district. Optional settlement/neighborhood detail is added only for a demonstrated operational need; no address, GPS tracking or proof of residence is inferred.
- Show only deliberately published, bounded group previews for that area. The catalogue and preview cannot expose the protected organizational tree, member list, private chats, group activity counts or private content. Unpublished groups remain undiscoverable. Broader social discovery remains V1.5.
- The member explicitly requests admission to a local group. Reuse and extend the typed membership-review boundary; default admission requires an independent authorized reviewer. The beneficiary/requester cannot approve their own admission. Duplicate requests, expired requests, denied identity assurance and revoked authority cannot create membership.
- On approval, assign the approved least-privilege member position, with the applicable validity and assurance requirements. No manager appointment follows from area selection, creating a group, invitation possession or becoming its first member. Admission does not auto-subscribe the member to unrelated broadcasts.
- Once admitted, opening the group shows its main chat, permitted announcements, tasks, events and Decisions. Current domain eligibility remains additional to membership, especially frozen electorates and identity/biometric requirements. Admission and workspace switching do not relax the current mobile assurance gate.
- A person can additionally join approved professional/project units. Switching to another existing membership is a view change. Moving the primary local membership to a new group uses the existing reviewed transfer/responsibility rules, not a profile-location edit. Preserve identity, Activity, earned points and frozen Decision records.
- Existing invitation/code entry must converge on this same admission contract; [INVITATIONS](INVITATIONS.md) does not authorize a shortcut or immediate QR rollout.

## Group creation and main chat

From the permitted territorial parent, **Create group here** preselects and displays parent, inherited area and unit type. Server-provided choices limit alternatives; the server independently rechecks all inputs. The proposal pins these values, main-chat intent and version so later edits require a fresh review.

For a new local group, independent approval creates the child unit and exactly one main group channel in the same transaction as required audit and retry receipts. Main-channel provisioning is an explicit consequence authorized by the reviewed payload, not an implicit grant to the proposer. Enforce one main channel per group, including concurrent retries. Failure creates neither unit nor channel. Regional/municipal containers do not automatically receive member chats.

Position publication and administrator appointment remain separately governed. The new group may have no members until admission/appointments complete. Legacy groups and channels require an explicit reviewed mapping/backfill preview; never label an arbitrary existing chat as the main chat. Preserve existing channel identities, read markers, restrictions and history. Archive/restore retains the current lifecycle blockers; this feature does not enable moving populated branches.

## Content and communication visibility

| Resource | Initial audience contract |
|---|---|
| Main group chat | Current explicitly authorized group readers/posters; ordinary membership elsewhere grants nothing |
| Internal administrative chat | Explicit administrative participants/capabilities; no descendant-member access |
| Group announcement | This group, or explicitly this unit and descendants, subject to current membership and channel policy |
| Task/event | Existing Work/event visibility, assignment and delegation rules; display filtering cannot expand access |
| Decision | Existing published audience, frozen eligibility and privacy rules; new membership never silently enters the electorate |
| Task conversation/private room | Existing assignment/participant authorization; territorial membership does not replace it |

Use the existing group/global channel distinction for local versus descendant announcements where its authorization contract fits. Separate read and post: receiving a regional announcement grants no right to write in the regional administrators' conversation. A visible ancestor announcement does not disclose that ancestor's directory or unrelated content. Higher organizational rank still requires explicit scoped grants and disclosure policy.

Represent audience intent on the canonical domain resource, reusing that domain's supported model. Do not copy content into every descendant group. Revalidate current membership, permission, tenant and ancestry on lists, details, search, attachments, unread counts, realtime delivery and notification/deep-link resolution. Revocation stops subsequent server access; stale links and queued writes confer no rights. Minimal external notification payloads must not carry private titles or message bodies.

Default main-chat history follows the existing authorized group-channel retention contract for admitted current members. The UI must make history availability clear before admission; joining is not a promise of access to all historical private artifacts. Restrictions, deleted/expired attachments and domain-specific history policies remain effective. Preserve private-room participant boundaries.

## Web and mobile presentation

- Web first: shared catalogue selectors, typed tree/filtering, scoped parent action, proposal/review summary, admission queue and main-channel link. Extend existing Units/Reviews/Inbox/Channels pages and primitives. Council/regional administration stays on web.
- Mobile afterwards: retain Status / Messages / Home / Tasks / Polls. Add the selected group's name and authorized group switcher in the existing context sheet; no sixth tab. Messages opens the selected group's main chat and permitted channels, while explicitly addressed private rooms retain their existing meaning. Cross-group direct messages are not forced into a territorial chat.
- Bootstrap exposes authorized organization + group contexts and allowed actions. Requests carry the selected pair as a filter, never as proof of permission. Include ancestor notices only through their canonical audience rules. An invalid/revoked context is cleared and resolved through current authorized choices.
- Key data, unread state, offline snapshots and queued commands by account, organization, group and resource as applicable. On switch clear visible data immediately; reject late responses from the previous context. Pending writes retain their original target/key and require fresh server authorization. Local snapshots cannot prove continued membership; purge on detected loss/revocation/sign-out and do not promise offline revocation guarantees.
- Georgian/English labels, separate web/mobile tokens, keyboard/focus behavior, narrow layouts and loading/empty/error/forbidden/offline/pending states accompany each delivered screen.

## Delivery sequence and acceptance gates

| Stage | Concrete deliverable | Required evidence before the next stage |
|---|---|---|
| T0: catalogue and mapping review | Official-source reconciliation, valid level matrix, current-unit/channel mapping preview and additive migration design | No ambiguous units auto-mapped; source coverage and intentional unresolved entries recorded; existing data/IDs preserved |
| T1: catalogue + typed hierarchy on web | Minimal catalogue import/read API, typed/geographic unit binding and existing create/review UI | Real SQL/API/browser cases for containment, invalid parents, tenancy, duplicate names, ancestry drift, retries and no authority from choosing an area |
| T2: atomic group workspace | Reviewed local-group creation plus unique main chat and independently governed appointments | Another administrator approves; reload shows exactly one child and chat; chat/audit failure rolls back; proposer gains no membership or extra authority |
| T3: admission + primary membership | Bounded published preview, member request, independent review and primary-context designation | Self-approval and duplicate/concurrent requests denied; expiry/revocation tested; transfer blockers and existing history preserved |
| T4: scoped content on web/API | Explicit group/descendant announcements and group-filtered domain projections | Group-only/private admin content isolated; ancestor announcement works; attachment/search/unread/realtime paths agree; frozen Decision eligibility preserved |
| T5: mobile group workspace | Catalogue/admission states, authorized group switcher and group-scoped content using stable server contracts | Flutter format/analyze/tests, API regressions and physical-device group switching/revocation/late-response/offline-queue cases; never claim unrun device checks |
| T6: end-to-end acceptance | Two regions, two sibling groups in one district, another municipality, ordinary members and scoped managers in disposable fixtures | Create → approve → admit → open chat → post → view targeted content → switch → revoke → retry/reload; all unauthorized sibling/tenant paths denied |

T0–T4 are increments within existing web-management work; T5 follows the applicable web and mobile-security gates. Professional/project administration is extended only when its actual journey is delivered, without scaffolding it during the territorial slice. Optional settlements, automatic/open admission, branch moves, broader discovery/subscriptions and QR rollout are not prerequisites for this feature.

For each implementation stage run `npm run check`, dependency audit and affected SQL/HTTP/browser suites (hierarchy, membership lifecycle, channels, Work, Decisions and mobile API where touched). Infrastructure changes additionally require Compose validation and `npm run smoke`. Use synthetic disposable fixtures; preserve the developer's data and review outcomes. No production migration/deployment is authorized by this plan.

## Completion criteria

The feature is complete only when a person can select an area, request and receive governed admission, open the approved group's main chat/content and safely switch among existing authorized memberships. A new group must appear beneath its reviewed parent with its main chat, while another group's private data stays inaccessible through UI, direct API/SQL boundaries, files, search, notifications and stale requests. Record actual verification and remaining gates in STATUS; source presence or a health check is not acceptance.
