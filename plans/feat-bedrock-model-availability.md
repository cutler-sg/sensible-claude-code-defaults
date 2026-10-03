# Bedrock model discovery and access verification

Date: 2026-09-30
Status: Implemented and verified on 2026-09-30. See `docs/model-availability-verification.md`.
Branch: `feat/bedrock-model-availability`.
Scope: Michael authorised full implementation, thorough automated and isolated
VS Code computer-use testing, screenshots, and an emailed write-up. No real
credentials will be used during desktop verification.

## Outcome

Keep discovering new Claude models through the existing GitHub update channel,
but recommend only models verified to work with this installation's credential,
source region, and permitted processing geography. On startup, show saved results
immediately and refresh stale evidence in the background. Preserve working model
selections until the user applies an upgrade through the existing preview flow.

## Findings in the current implementation

- `src/ui/manifestHolder.ts` and `src/manifest/resolve.ts` already provide an
  hourly, demand-driven GitHub refresh with cached/bundled fallback. There is no
  autonomous hourly polling timer.
- `manifest/defaults.json` contains three preferred model IDs, not an inventory
  of versions, inference profiles, or supported source regions.
- `src/credential/validate.ts:testConnection` makes a minimal Anthropic
  `InvokeModel` request and stops at the first success. Its payload can be reused;
  its first-success aggregation cannot represent a matrix.
- `src/ui/flows.ts:modelsToTry` selects Haiku and Sonnet from the manifest, rather
  than the user's actual configured model IDs. Opus is not tested.
- `src/extension.ts` holds the last test in memory per window. Results are stamped
  against the credential's set time, but not the source region or configured IDs.
- `src/health/checks/cred.valid.ts` reports that result without making requests.
  `config.models` compares settings with recommendations; it does not test access.
- README Network requests and PRD FR-4.7 / section 12 currently promise
  user-initiated invocation only. Automatic checking intentionally changes that
  contract and requires corresponding product settings, disclosure, and tests.

## Proposed design

### 1. Publish explicit model metadata alongside recommendations

Add an optional, bounded `models` collection to the existing v1 manifest. Older
clients already drop unknown fields; new clients must still accept manifests
without the collection. Leave the existing defaults usable by older releases.

Each entry carries a stable foundation-model ID, display name, family, lifecycle,
recommendation rank, supported probe format, and explicit invocation targets.
Each target specifies its exact invocation ID, supported source regions, and
processing scope (regional, named geography, or global), with AWS documentation
provenance and verification date. Never generate IDs by swapping prefixes or
assume every geography supports every model. Unknown probe formats remain listed
but untested until supported by extension code; downloaded metadata cannot supply
arbitrary URLs, request bodies, headers, or code.

Publishing metadata makes a new compatible model discoverable without a VSIX
release. It still requires catalogue maintenance: retain working older versions,
and add AWS-documented releases promptly. Scheduled generation of candidate
catalogue updates can follow later; it is not required for the initial feature.

### 2. Separate catalogue support, access metadata, and invocation evidence

Use `GetFoundationModelAvailability` against the foundation-model ID in the
configured source region. It reports agreement, entitlement, authorisation, and
regional availability. Bedrock bearer keys support control-plane operations,
subject to IAM permissions. A denied metadata request means metadata is unknown,
not that inference is unavailable or the key is invalid.

Then invoke the exact configured or eligible inference-profile ID using the
existing minimal message and output cap. This proves that particular runtime
route worked at that time; listing a model or passing preflight cannot prove it.
The request is billable, including normal input/message overhead.

Prioritise actual configured Opus/Sonnet/Haiku IDs, deduplicated, followed by new
recommended candidates in the permitted scope. Preserve custom IDs absent from
the catalogue: test compatible configured IDs explicitly, but do not infer their
geography from an opaque application-profile ARN.

Keep credential evidence separate from per-target results. One successful
invocation verifies the credential in that source region; it does not verify
other models. If all calls are denied ambiguously, report access denied with
credential validity unconfirmed. A model-scoped IAM denial must not stop checking
other models. Only an explicit credential failure stops the credential's batch.

Use distinct outcomes: invocation succeeded; subscription/agreement required;
model/profile access denied; unavailable route; invalid credential; throttled;
network/service failure; unsupported probe; and unknown. Preserve structured AWS
error codes and safe reason codes, not response text. Do not reuse the existing
rules that treat a bare 403 as a bad key, all 404s as a wrong region, or broad
model-related validation errors as missing subscriptions. Request-format errors
are not evidence that a model is disabled.

### 3. Account for automatic subscriptions

AWS documents that the first invocation can initiate a Marketplace subscription,
and may temporarily succeed before subscription setup later fails. For automatic
discovery, invoke new candidates only after positive availability preflight;
otherwise show the reason or an explicit Test action. Existing configured targets
can be periodically rechecked under the user's automatic-check policy even when
metadata permission is unavailable. Do not call agreement-creation APIs.

Preflight is not an atomic guarantee against subscription side effects. An
organisation requiring that guarantee must withhold Marketplace subscription
permissions from the probing principal. Keep preflight evidence and timestamp
alongside invocation evidence; temporary success is not a subscription guarantee.

### 4. Cache evidence and schedule bounded work

Proposed defaults:

| Evidence | Refresh eligibility |
|---|---|
| Configured model invocation | After 24 hours |
| Unselected, verified candidate | After 7 days |
| Explicit access/subscription denial | After 24 hours |
| New eligible catalogue target | On discovery |
| Network, service, or throttling failure | Backoff, initially 15 minutes |

Evaluate eligibility after activation, on window focus, credential/configuration
changes, and catalogue refresh. A manual Recheck bypasses age/backoff. Health
rendering and settings-watcher events never directly cause unbounded calls.
Respect the startup-check preference and provide a separate automatic model-check
setting. Disclose tiny billable requests and subscription behaviour during setup;
existing installations need a clear migration into the new automatic behaviour.

Store safe results and `checkedAt`, `lastSuccessAt`, `lastAttemptAt`, and retry time
in machine-local extension storage, never Settings Sync. Cache identity includes
an opaque credential generation, configuration location, source region, exact
invocation ID, and probe version. Derive the generation deterministically in memory from the secret-store token
and set timestamp, and invalidate on replacement/removal and cross-window secret changes; never
persist the bearer value in ordinary state or diagnostics. Account-wide results
cannot be inferred from a bearer token. Scope-policy changes re-evaluate which
targets may run, and target metadata changes invalidate affected evidence only.

Refresh without blocking activation. Start with two concurrent requests, ten
seconds per request, a 30-second batch budget, and at most twelve runtime calls
per automatic batch. Resume remaining eligible work on a later trigger. Coalesce
in-flight work; use an expiring, owned lease in extension storage to prevent
several windows starting the same batch. Cancel obsolete work and reject results
whose credential/configuration generation changed while requests were running.
Record attempts before dispatch so failures cannot produce a watcher-driven loop.

Saved success is labelled “Last worked …”, never “working now”. Expired results
are stale; transient failures preserve the previous successful observation but
show that the latest check failed. Removing or replacing a key immediately stops
its old results contributing to current health.

### 5. Show an honest matrix and recommend usable upgrades

The matrix is scoped to the active credential and selected source region.
Rows are model versions; columns are AWS-documented processing scopes. A cell
shows the exact invocation ID in details, access outcome, evidence source, and
age. Distinguish AWS-supported-but-untested, verified, blocked, stale, excluded by
policy, and no documented route. A catalogue omission is not proof of AWS absence.

Source region and processing scope are independent. For example, a request to
Singapore using a global inference profile does not establish Singapore data
residency. Let organisations constrain permitted scopes. Show other scopes as
catalogue information without probing them; never fall back to global silently.
AWS routing metadata is not a complete legal compliance attestation.

Keep the primary panel simple: “Your configured models worked when last checked”
or a precise configured-model failure. A blocked, unselected new release is
informational and must not make an otherwise working setup unhealthy. Offer
Recheck, Review available upgrade, and Copy administrator request. The latter
copies model/profile, source region, reason, and timestamp without credentials;
it does not send a message or perform a subscription.

Rank only freshly verified, policy-eligible models within each family. If the
newest release is blocked, keep the working pin and display the new release's
status. Feed the same resolved recommendation into health comparisons and the
apply-preview flow so the UI does not keep insisting on a known unusable default.
Preserve drift protection, backup, and explicit application. On a fresh setup with
no verified candidate, present an unverified choice and test action, not a claim
that the published default is usable. A normal refresh never changes model pins.

## Implementation sequence and acceptance criteria

- [x] Trace manifest, probe, health, activation, and selection behaviour.
- [x] Verify relevant AWS API and subscription semantics against public docs.
- [x] Record design, integration points, and acceptance criteria.
- [x] [Medium] Extend `src/manifest/{types,schema}.ts` and bundled metadata.
  Accept old/forked manifests; validate bounded targets, exact IDs, regions, and
  scopes; prove a new compatible model appears without an extension release.
- [x] [Medium] Introduce a VS Code-independent per-target probe and preflight
  module, reusing transport code in `src/credential/validate.ts`. Test specific
  denial classes, ambiguous 403s, 404s, payload errors, 429/5xx, proxy responses,
  missing metadata permission, and no raw-body/credential leakage.
- [x] [Medium] Add persistent evidence and scheduler; wire into `src/extension.ts`
  and manual flows. Fake-clock tests cover stale startup, fresh-cache reuse,
  catalogue additions, budgets, cross-window ownership, credential rotation during
  an in-flight request, source-region changes, opt-out, and transient failures.
- [x] [Medium] Integrate actual configured IDs and verified recommendations into
  `src/ui/flows.ts`, `src/health/checks/{cred.valid,config.models}.ts`, and the
  existing apply preview. Prove working Haiku cannot hide broken Sonnet/Opus,
  blocked new releases do not replace working pins, and drift stays protected.
- [x] [Medium] Add matrix/details to `src/ui/panel/{state,provider,html}.ts`, scoped
  to a source region and allowed geographies; extend safe diagnostics. Test that
  excluded scopes receive no requests and stale/unknown states never render as
  fresh success. Verify interaction in the VS Code extension host.
- [x] [Simple] Update README, PRD, settings/commands, and setup disclosure to
  describe control-plane requests, automatic inference, cost, and subscription
  effects. Run repository lint, typecheck, unit tests, build, and focused
  extension-host tests. Live AWS validation requires a designated test account;
  do not infer production access from fixtures.

## Sources verified on 2026-09-30

- [AWS model access and automatic subscriptions](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html)
- [GetFoundationModelAvailability](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_GetFoundationModelAvailability.html)
- [API key supported operations and short-term regional restriction](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-reference.html)
- [Cross-region inference and processing geography](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html)

Specific new-release IDs and route coverage must be verified when populating the
catalogue. The user's Sonnet 5.5 scenario is a motivating example, not an assertion
that an unverified ID or geographic variant is supported.

Implementation decision: derive credential identity deterministically in memory
with SHA-256, then include it only in the hashed cache context key. A separate
random SecretStorage identity raced when two fresh windows initialised together,
defeating the shared lease. No bearer value or fingerprint field is persisted,
synced, or logged.

## Verification completed

- [x] 2,086 unit tests passed, two existing skips; lint and typecheck clean.
- [x] Seven real VS Code extension-host tests passed, one existing platform skip.
- [x] Packaged VSIX tested in an isolated desktop profile using synthetic AWS.
- [x] Upgrade cancellation/application, backup, failures, policy exclusion,
  fresh/stale reloads, opt-out, keyboard scrolling, and three themes verified.
- [x] Full report and screenshots prepared under `out/model-availability-evidence`.

Physical Windows/macOS, OS keyring encryption, and live AWS entitlement changes
were not verified in this Linux fixture run. Those limitations are recorded in
the verification report; no live AWS credentials were used.
