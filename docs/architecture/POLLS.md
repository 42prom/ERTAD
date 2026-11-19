# Scoped polls, referendums, surveys and elections

The first Decisions delivery began with advisory, single-choice **named** polls. The restored composer now supports polls, referendums, multi-question surveys and option-based elections in the local web console at `/decisions`. It reuses the imported console, cards, forms, navigation, session/step-up, audit and scoped authority. It does not activate the retired voting protocol or the retained legacy poll endpoints.

## Working contract

- Create a draft with a title, description, a format definition, an authority unit, a future deadline within 90 days and a quorum percentage. Polls have two to eight distinct options; referendum and survey definitions are described below. Edits require the expected draft version. The audience unit stays fixed; cancel and create a new draft to choose a different unit.
- An administrator with explicit `decision.manage` and `decision.read` grants can create/edit/cancel within the granted unit/subtree. Publication and early closure require `decision.publish` and read permission. Role names alone grant nothing. These advisory polls do not assign authority or replace independent governance approval.
- Publication snapshots one eligible membership per distinct member in the selected unit and its descendants. A current membership, approved matching permission-bundle version, active ancestry and `decision.vote` are required. Ancestor administrators are not automatically members of a regional electorate. Empty electorates cannot be published.
- Publication makes the poll visible in the eligible participants' scoped poll list. This is in-app distribution, not email, push or a public sharing link. The web demo exercises participation through the existing synthetic administrator/member links. Mobile participation is still deferred.
- A participant must remain eligible through the snapshotted membership. Later joins cannot expand the electorate; expired/revoked membership or authority denies participation. Moving the poll's scope ancestry invalidates further voting. One account-linked member gets one submission, with no re-vote or weighted votes. A survey submission contains the answers to its questions.
- Answers are explicitly stored with member IDs. No endpoint exposes a voter directory or another person's individual choice. The UI discloses named storage before voting. Anonymous mode is rejected by this API and is **not** implemented using these tables or payload-bound receipts.
- Results stay hidden until the deadline or an explicit close. Quorum uses the frozen electorate, rounded up to a whole participant. Equal leading counts mean a tie, with no automatic winner or authority change. Below-quorum results are displayed with the failed quorum, not treated as an approved decision. Cancelled polls suppress results and cannot accept votes; a naturally expired poll cannot subsequently be cancelled.
- Mutations require current session, CSRF/Origin and development password step-up. Idempotency binds each key to actor, operation and exact payload. Identical retries acknowledge the original outcome; different payloads or stale versions conflict. Organization locks serialize voting/publication/closure and authority changes. Required audit shares the transaction; authority and voting deadlines are checked again after audit. The runtime role has no direct access to the decision tables.

## Hierarchical audience and management

The current installation serves one organization. The web console automatically uses its server-authorized context. Organization selection controls are removed from every console page, including the former multiple-context fallback. Organization IDs remain enforced at API/SQL boundaries. An audience is a hierarchy unit, not a different organization.

Council grants cover the root and its descendants; choosing the root distributes to eligible members throughout the structure. Council administrators can also choose a particular region/group and manage its polls. Regional grants cover only their region and descendants. Group leadership, including multiple managers with explicit memberships, covers the assigned group scope. All managers use the same operations within their grants. A regional/group participant may vote in a root-wide poll when eligible, but cannot thereby edit or close it. Management of a child poll does not automatically make an ancestor administrator a voting member of that child electorate.

Currently each poll selects one unit and its subtree. Multiple disjoint audience selections, exclusions and a pre-publication recipient preview are still pending; they need union/deduplication, coverage authorization for every selected unit and a frozen electorate. Group leadership is tested in disposable web fixtures; production group/mobile login and the UI for assigning those managers remain separate unfinished work.

## Local operation

Apply the additive foundation migration with `npm run db:migrate`, then run `npm run demo:decisions`. This explicitly grants bounded decision memberships to the six existing synthetic accounts through a separate approved demo bundle. Re-running preserves passwords, reviews, prior grants and poll outcomes, and does not reinstate revoked grants. It is an offline development action, not a production permission-management UI.

Use regional A account 1 to create and publish to region A. Regional A account 2 can participate; region B cannot see that poll. Council accounts can manage both regions only through their persisted grants. Publishing at the council/root audience includes eligible members from both regions.

`npm run test:decisions` creates a disposable database and exercises actual SQL/HTTP/auth boundaries, including concurrent votes, retries, regional denial, revocation, immutable eligibility, audit rollback and expiry. Add `-- --browser` for the Chrome draft/edit/publish/participate/close/results flow and responsive presentation. Test fixtures never consume the real local demo's requests or polls.

## Remaining Decisions scope

The planned mobile [three-profile access policy](MOBILE_CONTROL.md#access-matrix-and-one-time-proofing) adds a shared identity gate to all four formats in hybrid mode: authorized reading after Google authentication, valid document-and-face proof before participation, and no repeated enrollment for already verified accounts. It creates no membership or electorate eligibility and never automatically submits a response after verification. Current named web behavior is unchanged. Mobile electorate/quorum semantics, API enforcement and physical-device acceptance remain unimplemented gates; this policy does not enable anonymous voting.

Anonymous ballots and small-electorate suppression need their own reviewed unlinkable storage and retry design. Candidate nomination/withdrawal, binding votes, proposal escalation, configurable result policies, scheduled opening, anonymous-participation contribution awards, notification delivery, member-mobile sessions, production MFA/identity and external audit checkpoints remain incomplete. Passing these local named journeys does not complete the full Decisions or release acceptance gate.

## Restored authoring formats (2026-10-11)

The editor follows the retained authoring layout: basic-information and question cards, audience/settings beside them, then save actions. `/create-poll` opens this accepted composer. The old protocol endpoints stay denied. Migration 8 adds format metadata and immutable survey responses without changing existing polls or their original receipts. Existing records default to `poll`.

- **Poll**: two to eight distinct options, one choice per eligible member.
- **Referendum**: fixed Yes/No/Abstain semantics and a 50-100% support threshold. Abstentions count toward quorum but not the Yes/No denominator. Quorum is checked first; no Yes/No answers yields no decision; equal Yes/No yields a tie. Acceptance requires more Yes than No and reaching the configured threshold. Results never grant authority or execute governance changes.
- **Survey**: one to twenty ordered questions, stable question IDs, required/optional answers. Single choice, multiple choice, text (up to 2000 characters), integer rating (within 0-10) and complete ranking of all options are supported. Ranking aggregates use positional points N, N-1 ... 1, disclosed before answering. Required answers and exact question/option boundaries are checked in both HTTP validation and SQL. One immutable response object per member prevents partial/multiple submissions; optional unanswered questions are omitted.

All formats share scoped authority, publication-time eligibility, expiry/revocation, payload-bound retries, audit rollback, post-close results and explicit named-mode disclosure. Survey aggregates omit participants and individual answer bundles. Text snippets are available only to current scoped managers, limited to 25 per question with an explicit truncation indicator; ordinary result readers receive only their count. No text or answer payload enters the audit chain. Named mode does not promise that voluntarily entered text cannot identify its author.

Anonymous mode, formal candidate nomination/withdrawal, binding execution, scheduled opening, disjoint audience selection, anonymous-participation contribution awards and generalized delivery remain separate unfinished work. Do not label the implemented forms as completion of those requirements.

Migration 9 extends the same definition validator without adding services or tables. **Election** restores the imported option-based candidate ballot: two to eight distinct candidate labels, one choice per eligible member, draft edits, frozen publication, existing quorum/tie reporting and post-close totals. It is named advisory participation; totals do not appoint someone or mutate authority. Candidates are ballot labels, not linked private member profiles, and this form does not claim nomination/withdrawal management.

Survey rating endpoints can carry optional labels (up to 120 characters each); text questions can carry a placeholder (up to 200). HTTP and SQL both constrain types, lengths and applicable question types. These fields roundtrip with the draft and freeze with the published definition. The inline participant preview reuses the response controls, is disabled, makes no write and keeps the named-mode disclosure. Existing definitions without this metadata remain valid.

## Authoring restoration and remaining gaps (2026-10-12)

The first active single-choice composer replaced too much of the imported journey. Keeping the original files while routing users through a reduced editor did not preserve functional coverage. Replacing the old voting protocol does not authorize dropping compatible authoring, lifecycle or reporting tools. Complete the following restoration before calling the migrated module equivalent to its source.

| Capability | Active behavior / remaining work |
|---|---|
| Multi-question survey entry | Direct Create survey action; `/create-poll` opens survey mode as in the original authoring flow. Separate poll and referendum actions remain. |
| Questions and answers | Five question types; required/optional answers; add/remove/reorder questions; collapsible question cards; individual answer removal; choices preserved when switching between choice types. Limits are 20 questions and 8 options per choice question. |
| Draft roundtrip and participation | All questions persist on save/edit, freeze on publication, accept one complete response and produce post-close aggregates. This is active and separately tested, not source-only retention. |
| Election type | Active option-based candidate authoring, draft edit, scoped publication, one vote and results. Formal nomination/withdrawal and appointment are separate unfinished behavior. |
| Question configuration and preview | Numeric bounds, endpoint labels, text length and placeholder work. Inline participant preview covers all four formats and cannot submit a vote. |
| Referendum tools | Explicit Yes/No/Abstain roles, threshold, quorum and outcomes work. Custom response wording and the richer source result visualization remain pending; wording must not alter vote semantics. |
| Scheduling | Closing deadline works; scheduled opening and the full start/end authoring workflow remain pending. |
| Audience tools | One authorized hierarchy subtree works. Multiple selected units/exclusions and authorized recipient estimates remain pending. Do not restore demographic targeting without the applicable disclosure and privacy rules. |
| Results and navigation | Question-level aggregates and lifecycle views work. Adapt richer charts, permitted reporting and original list/detail navigation; retained legacy URLs other than the composer still use unadapted pages. |
| Rewards | Cryptocurrency is intentionally removed. Administrator-controlled contribution rules now award named vote/survey participation through migration 14, with pinned rules, source deduplication and compensating cancellation entries. Anonymous participation awards remain gated by the separate anonymous contract. |
| Privacy | Current mode is explicitly named. Anonymous participation still needs separate unlinkable storage/retry and result-disclosure acceptance; never relabel named responses as anonymous. |

Preserve the source application's read-only working tree. Keep provenance and detailed working comparisons local-only. Restore each remaining capability with an ERTAD contract and tests, rather than making the old denied API reachable or presenting inactive controls as completed functionality.

## Verified contribution linkage (2026-10-31)

Migration 14 already pins the applicable vote/survey rule at publication and awards named participation transactionally. scripts/contribution-tests.ts, executed by npm run test:work, verifies duplicate submission handling, answer-independent points and cancellation compensation. Earlier delivery notes that list all contribution linkage as pending describe the pre-migration-14 boundary; anonymous mode and its privacy-preserving reward linkage remain incomplete.
