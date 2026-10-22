> Historical research preserved for 1.2.1 preparation on 2026-10-22. Findings and external facts are dated 2026-09-30; implementation status and release scope are tracked in [the maintenance backlog](maintenance-backlog.md). Local `out/` and `/tmp/` evidence links may be unavailable in a fresh clone.

# Claude model availability on Azure Foundry

Research date: 2026-09-30. Documentation and repository inspection only. No Azure
account, credentials, inference, deployment operations or application changes.

Implementation baseline: `5377d85`, including the Bedrock availability feature.
Execution checklist: [Azure Foundry implementation plan](../plans/docs-azure-foundry-availability-plan.md).

## Recommendation

Reuse the Bedrock scheduling, evidence storage and upgrade-preview mechanisms,
with a small Foundry provider adapter. The key change is the identity being
tested: Foundry invokes an **existing deployment name on a specific resource**,
not a public model ID. A new GitHub catalogue entry can announce a release; it
cannot tell us the organisation’s deployment alias or make that model usable.

Represent three independent facts:

1. **Offered:** Microsoft documents a model/hosting/SKU combination, or the account
   model catalogue lists it.
2. **Deployed:** an inventory read finds a concrete deployment, its underlying
   model/version and its provisioning state.
3. **Invocable:** the configured inference credential successfully generates a
   response from that deployment at a recorded time.

Add processing-policy eligibility as a separate gate. Neither a catalogue entry,
a deployed object, nor a successful inference establishes legal residency.

The first release should cover configured Opus/Sonnet/Haiku deployments on Public
Azure, API-key and bearer authentication, verified renewable Entra identity
integration, and optional account-scoped ARM discovery. Project discovery and
connected deployments are useful follow-ons, not prerequisites. Keep all
provisioning, Marketplace acceptance, key retrieval and permission changes out
of the extension.

## What users would see

On activation, display saved evidence immediately. When the user has enabled
Foundry checks for this resource, refresh stale eligible deployments in the
background. Check the actual configured aliases first, then existing discovered
alternatives allowed by the processing policy. A successful check says “Last
worked …”; it is not a promise that a token, permission or capacity still works.

For Michael’s new-model example:

| Observed state | UI and action |
| --- | --- |
| GitHub lists a newer Sonnet; no inventory permission | “New model available in the catalogue; deployment unknown.” Keep the working alias. Offer administrator request. |
| Complete inventory has no deployment for that model | “No deployment found in this resource.” Administrator deployment required; make no guessed inference call. |
| Deployment exists but is creating/failed/disabled | Show provisioning state separately; wait for a usable deployment. |
| Alias exists; inference is denied | Show observed access denial and safe service reason. Offer access-review text without asserting missing subscription. |
| Alias exists, allowed scope, inference succeeds | Offer an upgrade through the existing configuration preview. Never replace the current alias automatically. |
| Configured custom alias works; inventory denied | Show verified invocation with model identity/hosting/scope unknown. Respect explicit policy for testing unknown scope. |

A matrix should show public model, deployment alias, resource, resource location,
hosting, SKU/processing scope and verification age. Scope it to the active
resource initially. Multiple jurisdictions require actual deployments on
explicitly configured resources; do not generate Azure region/model combinations
and try them all.

## Runtime and Claude Code configuration

Anthropic’s Claude Code documentation is authoritative for the client’s
configuration contract. Microsoft’s Claude-specific API documentation and the
Foundry SDK corroborate the runtime route. [S1–S5]

| Setting | Contract |
| --- | --- |
| `CLAUDE_CODE_USE_FOUNDRY=1` | Select Foundry. Conflicting Bedrock/other provider flags require resolution; no silent winner. |
| `ANTHROPIC_FOUNDRY_RESOURCE` | Resource name; standard base URL is `https://{resource}.services.ai.azure.com/anthropic`. |
| `ANTHROPIC_FOUNDRY_BASE_URL` | Alternative full Anthropic base URL. Resource and base URL are mutually exclusive in the Foundry SDK. |
| `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Deployment names, which may be arbitrary organisation aliases. |
| `ANTHROPIC_FOUNDRY_AUTH_TOKEN` | Explicit Entra bearer; requires Claude Code v2.1.203+. Takes precedence over API key and default chain. |
| `ANTHROPIC_FOUNDRY_API_KEY` | Resource API key, used when explicit bearer is absent. |
| Neither explicit credential set | Azure SDK default credential chain. |
| `CLAUDE_CODE_SKIP_FOUNDRY_AUTH` | Gateway mode: skips Azure auth and preserves supplied Authorization; ignored when explicit Foundry key/bearer is set. Correct behavior requires v2.1.203+. |

Claude Code currently documents no Foundry startup model check, and warns that
built-in model defaults may lag releases or be unavailable in an account. The
extension directly addresses that gap. For small/fast background work, Foundry
defaults to the primary model when no Haiku deployment is pinned; missing an
explicit Haiku pin is not inherently a broken installation. Deduplicate aliases
shared by multiple roles. [S1]

Resolve effective managed/user/process configuration and the execution host
before claiming the checker matches Claude Code. Shell exports made after VS
Code started may not reach its extension host. Remote SSH, WSL and containers may
have different configuration and credentials. Session-specific `--model` or
`/model` choices are outside a checker that can only observe launch settings;
describe that limit. Do not write organisation-managed settings or infer the
effective primary target from catalogue recommendations. [S1, S2]

### Minimal inference probe

| Element | Proposed contract |
| --- | --- |
| Method/path | `POST {anthropicBaseURL}/v1/messages`, normally `/anthropic/v1/messages`. |
| Headers | JSON content type; `anthropic-version: 2023-06-01`; API key via `x-api-key` (SDK convention), or `Authorization: Bearer …`. |
| Body | Exact deployment alias in `model`; one fixed user message such as `Hi`; `stream:false`; start validation with `max_tokens:1`. |
| Excluded content | Workspace data, conversation history, system prompts, tools, beta features, temperature and thinking overrides. |
| Success | A valid generated Anthropic Message response, including a response truncated by the token cap. Never require literal “OK”, or accept arbitrary HTTP 200/HTML. |
| Persisted evidence | Normalized status, safe reason code, timestamps and optional safe request correlation IDs; no prompt/response body or auth headers. |

The exact minimum is a **live-validation candidate**, not a verified recipe for
every model. Current adaptive-thinking constraints differ by generation and even
conflict within Microsoft’s model page. Do not convert a payload-validation 400
into “model unavailable”. Token counting or `max_tokens:0` prewarming does not
prove generation access. Tiny Messages requests are billable. [S3–S6, S12]

The Anthropic Models API is explicitly unsupported on Foundry. Do not implement
discovery by calling `/anthropic/v1/models`, or substitute Azure OpenAI
Chat Completions/Responses routes. [S3]

## Authentication, inventory permissions and identity

### Keep audiences and capabilities separate

| Capability | Authentication | What success proves |
| --- | --- | --- |
| Claude Messages invocation | Resource API key, explicit Entra bearer, or renewable Entra token for `https://ai.azure.com/.default` | This inference identity could invoke this deployment now. |
| ARM account/deployment/model reads | Entra for `https://management.azure.com/.default`, independently authorized | This management identity could read this metadata. |
| Project deployment reads | Entra; project SDK uses the AI audience | This project inventory is readable; not proof of Claude invocation or complete account coverage. |

Do not copy the generic Azure OpenAI scope
`https://cognitiveservices.azure.com/.default` into the Claude adapter. Do not use
a resource API key as an ARM credential. Discovery permission is optional:
inference-only users retain configured-alias checks. Explicitly display when
inventory uses a different credential source from inference. [S3, S5, S9, S16]

For optional ARM discovery, the required read Actions are:

- `Microsoft.CognitiveServices/accounts/read`
- `Microsoft.CognitiveServices/accounts/deployments/read`
- `Microsoft.CognitiveServices/accounts/models/read` if account catalogue is used
- `Microsoft.CognitiveServices/locations/models/read` only for optional regional exploration

Project listing uses the DataAction
`Microsoft.CognitiveServices/accounts/AIServices/deployments/read`. [S17]

The exact minimal Claude invocation role needs live confirmation: Claude Code
documents `Microsoft.CognitiveServices/accounts/providers/*`, while generic
Foundry guidance uses `accounts/MaaS/*`. These are different permission
descriptions, not interchangeable proof. Built-in Cognitive Services User is
documented and convenient, but includes `accounts/listkeys/action` and broad
DataActions; do not call it least privilege or strictly read-only. The extension
must never call `listKeys` to compensate for missing inference credentials.
[S1, S18, S19]

### Match Claude Code’s actual credential source

DefaultAzureCredential can choose environment/service-principal, workload,
managed identity, plugin-backed VS Code identity, CLI, PowerShell, developer CLI
or broker sources. SDK version, plugins and environment affect selection. A
separate VS Code Microsoft session or an unconditional `az` call could check a
different principal than Claude Code. [S9]

Recommended implementation:

- Honour explicit bearer → key → renewable chain precedence. A failed explicit
  credential must not fall through to another account.
- Reuse a credential/token-provider object and the correct audience. Keep
  acquired tokens in memory. Refresh only renewable credentials; an externally
  supplied bearer belongs to its upstream process and needs upstream refresh.
- Do not automatically launch interactive login during activation or probes.
- Verify source parity for every supported mode. If parity cannot be established,
  show a configuration limitation, rather than a green “Claude Code works”.
- A CLI-only initial mode is defensible only when named explicitly and Claude
  Code is constrained to the same source. `AZURE_TOKEN_CREDENTIALS` selection
  needs Azure Identity >=4.11; verify the actual Claude Code build honours it
  before relying on that restriction. [S9]

Prefer Azure Identity for renewable token acquisition and the existing injected,
bounded HTTP transport for these few REST calls. A full Projects or management
SDK is not required for the first slice. If the Anthropic Foundry SDK is used,
override its default retries and timeout; its default two retries and ten-minute
timeout conflict with the existing bounded checker. Dependency choice must also
pass Node/VS Code, bundling and enterprise network compatibility checks. [S4, S10]

### Cache identity is not the bearer-token string

Microsoft documents access tokens as opaque, potentially non-JWT. Do not decode
`tid`/`oid` claims to build a durable identity contract. `TokenCredential` exposes
token/expiry, not a standardized selected-principal identifier. [S9–S11]

For static keys, keep the existing opaque credential-generation approach, adding
provider and exact resource context. For Entra, use a trustworthy stable
principal/tenant handle only when the chosen integration actually exposes it.
Bind it to auth source, cloud, resource and configuration location. Do not persist
raw identifiers unnecessarily; use a local opaque digest.

When continuity is not provable, keep access evidence session/generation limited.
Token hashing safely separates generations but causes rechecks after refresh;
that is preferable to reusing another principal’s success. A random session ID
alone does not detect account switching within the session. Keep evidence across
refresh only when principal continuity is guaranteed, otherwise invalidate it.
Historic positive evidence cannot establish that today’s token is valid.

Resolve current credential source/generation **before** accepting cached success,
skipping a probe because its TTL is fresh, or recommending an alias. Activation
and focus must not reuse yesterday’s account evidence merely because no new
inference was due. A cached SDK token alone does not establish continuity with an
externally switched account; use the supported source’s change/identity signals,
or retain only historical evidence until the current generation is established.

## Read-only discovery

### Recommended baseline: account-scoped ARM

Use an explicitly supplied account resource ID. Do not scan all subscriptions to
find a similarly named endpoint. The documented stable `2025-06-01` API is a
candidate to pin, not a claim that it is newest or covers every current Claude
field. Verify Claude-specific response fixtures before release. [S13–S15]

Let the account root be:

`https://management.azure.com/subscriptions/{subscription}/resourceGroups/{group}/providers/Microsoft.CognitiveServices/accounts/{account}`

| Read | Route suffix, all with `?api-version=2025-06-01` | Useful fields and limits |
| --- | --- | --- |
| Account GET | Account root | Resource ID/location, endpoint(s), local-auth/network metadata where relevant. Extract an allowlisted subset; do not store the complete response. |
| Deployments list | `/deployments` | `name`, resource ID, `etag`, `sku`, `properties.model` name/version/publisher/format, provisioning state, upgrade option and any routing/spillover metadata. Paginated. |
| Account model catalogue | `/models` | Model/version, capabilities, lifecycle, SKUs, deprecation and capacity metadata. Offered models, not deployed inventory or entitlement. Paginated. |

Optional location catalogue route:

`https://management.azure.com/subscriptions/{subscription}/providers/Microsoft.CognitiveServices/locations/{location}/models?api-version=2025-06-01`

Reserve location exploration for an explicit selected subscription/location;
it is not needed for the startup feature. [S15]

Join deployment metadata to its account before assigning location or endpoint.
Verify that account endpoints match the configured trusted origin. A deployment
alias can be retargeted or automatically upgraded: model/version/SKU/provisioning
and relevant metadata must invalidate old evidence. A response’s model label is
useful corroboration, not a substitute for authoritative deployment identity.

The generic ARM schema also exposes `properties.spilloverDeploymentName`: a
deployment that serves requests when the primary would otherwise throttle.
Claude support for this field is unverified. If present, do not assume the
primary deployment’s model/SKU describes every possible processing route.
Resolve and policy-check the fallback, including bounded cycle detection, or
mark routing unknown/unsupported. Include routing metadata in evidence
invalidation. Live testing must establish Claude applicability before this
capability is advertised; do not equate it with Anthropic’s unsupported request
`fallbacks` parameter. [S3, S13]

Inventory states must distinguish complete, partial, denied, unavailable and
stale. Absence is meaningful only in a complete, fresh snapshot of the correct
resource. Bound pages, total bytes, entries and time; validate `nextLink` against
the expected ARM origin and account route before attaching a management token.
Keep known aliases usable when metadata permission disappears. Never treat
partial discovery as deletion.

### Project API: valid, but defer as a discovery source

The current API is:

`GET https://{resource}.services.ai.azure.com/api/projects/{project}/deployments?api-version=v1`

It supports `modelPublisher`, `modelName` and `deploymentType` filters. The
documented result has `value`, optional `nextLink`, and rows containing `name`,
`modelName`, `modelVersion`, `modelPublisher`, capabilities, `sku` and optional
`connectionName`. The maintained JS SDK corroborates this route and requires
Entra authentication. [S16]

It lacks account location/provisioning state in the documented shape, and the
reviewed sources do not guarantee every direct-resource Claude deployment is
visible in every project. Connected deployments can point elsewhere. Resolve
their exact authorized route before considering a probe; never send them to the
current resource by default. ARM provides the simplest first-release metadata
join. Project-only users can still check configured aliases while a later
project adapter is validated.

### Marketplace and quota

No verified general read-only Claude SaaS entitlement endpoint equivalent to
Bedrock’s foundation-model availability preflight was established. The tempting
Marketplace Agreements GET API documents `offerType=virtualmachine`; it is not
evidence of a Claude SaaS entitlement contract. [S21]

Deployment can accept Anthropic Marketplace terms on the caller’s behalf through
provider data. Never create/update a deployment as an availability test. Eligible
subscription/billing types and Marketplace access affect provisioning; a missing
deployment or generic 403 cannot identify which prerequisite failed. Some setup
documentation still describes individual model offers, while current Claude
docs describe the Claude Platform on Foundry offer and consumption units. Do not
hardcode old offer IDs into subscription diagnostics. [S3, S5, S20]

Quota may be shared by model/version across regions for Global deployments or
within a Data Zone. A listing can be available with zero default quota. Treat 429
as transient throttling/quota evidence; do not try another geography to evade
it, and do not label it missing subscription. [S22]

## Hosting and processing jurisdiction

Current Claude documentation maps hosting version `1` to Anthropic infrastructure
and `2` to Azure infrastructure. Store this as a sourced per-model mapping,
not a timeless rule that every future version number conveys hosting. Model
generation, hosting version and deployment alias are different fields. [S3, S5–S8]

| Hosting / SKU | What the reviewed sources support | What must not be inferred |
| --- | --- | --- |
| Azure-hosted / `GlobalStandard` | Global processing; data-at-rest geography is described separately. | Resource region restricts inference to that geography. |
| Azure-hosted / `DataZoneStandard` | US zone for selected models; Sonnet 5.5 is disputed between sources. | Generic Azure EU/APAC zone support also applies to Claude. |
| Anthropic-hosted / `GlobalStandard` | Inference on Anthropic infrastructure; processing can occur outside Azure and the resource region. | Azure resource location establishes an Azure-only processing boundary. |
| Missing/unknown hosting or SKU | Scope unknown until authoritative mapping or explicit administrator evidence is available. | A successful probe establishes residency. |

Microsoft’s current overview lists US Data Zone for Azure-hosted Opus 5.5, Opus 5,
Opus 4.8, Sonnet 5 and Sonnet 5.5. Anthropic explicitly states Sonnet 5.5 supports
only Global. This is a source conflict, not a supported route to auto-probe.
The reviewed Claude-specific sources establish no general EU/APAC Data Zone or
regional-standard option. Mark unestablished combinations unknown, not forever
unsupported. [S3, S6, S23]

The partner-model table lists Global deployments in several US regions and
Sweden Central, with model/version-specific rows. Exact regional availability
belongs in refreshed, sourced catalogue metadata; it is not a universal hardcoded
list. A Sweden Central Global deployment must never render as EU processing.
[S23]

Anthropic remains the operator and independent data processor for both hosting
options according to the current hosting/privacy docs. Processing scope does not
describe every retention, safety-review or contractual condition. Present this
as routing evidence with provenance, not a compliance certification. [S7, S8]

For restrictive policy, block automatic probes with unknown scope. Key-only users
can explicitly permit testing an unknown-scope configured alias, or supply a
trusted administrator mapping, if organisational policy permits it. Keep that
mapping labelled as administrator-provided; a local preference cannot override
organisation policy. Never reinterpret unknown as Global or a local region.

## Error and evidence semantics

Classify structured provider codes where verified. Use conservative generic
fallbacks and bounded sanitized reason strings; do not store raw server messages.

| Observation | Classification and behavior |
| --- | --- |
| Valid generated Message | Deployment worked; inference credential accepted for this call. |
| Token acquisition fails | Authentication source unavailable; deployment untested. No automatic alternate login. |
| Explicit expired/invalid credential or wrong audience | Auth rejected. Refresh a renewable source once within the total budget; stop credential-scoped dispatch if rejection persists. |
| Permission-related 401 | Authorization may be denied despite a valid token; generic Microsoft guidance documents this case. Exact Claude mapping requires live fixtures. |
| 403 | Access/policy/network restriction unless verified error code permits a narrower diagnosis. No automatic “invalid token” or “subscription missing”. |
| Deployment 404 | Alias/route absent or incorrect at this endpoint; not proof that Microsoft lacks the underlying model. |
| 400 | Request/configuration incompatibility until a specific code proves more. Thinking or retention/ZDR restrictions are possible. |
| 429 | Throttle/quota; honour available Retry-After and bounded backoff. Standard Anthropic rate-limit headers are not guaranteed on Foundry. |
| DNS/TLS/proxy/timeout/5xx | Inconclusive; retain historical success and display latest failure/staleness. |
| Inventory denied, invocation works | Current alias usable; discovery unknown. |
| Inventory works, invocation denied | Deployment exists; inference identity lacks usable access. |

Only clear credential rejection should create a batch-wide rejection barrier;
model-specific authorization denial must not suppress other targets. ARM errors
must not invalidate inference credentials. [S3, S5, S18]

## Integration with this repository

The implementation is presently Bedrock-specific beyond its HTTP transport.

| Existing file(s) | Required future change |
| --- | --- |
| `src/models/types.ts` | Replace AWS-shaped context/target assumptions with explicit provider contexts and deployment identity. Separate inventory capability, auth evidence and invocation evidence. |
| `src/models/service.ts` | Inject provider discovery/probe/recommendation behavior. Reuse orchestration, target prioritization and cancellation. Remove Foundry dependence on AWS ID generation and `AWS_REGION` projection. |
| `src/models/probe.ts` | Preserve AWS adapter. Add a Foundry adapter with its own payload, headers, endpoint security and error classification. |
| `src/models/store.ts` | Version/cache provider-specific metadata and credential identity safely; retain leases and bounded persisted data. |
| `src/models/catalogueSchema.ts` | Keep AWS ID/region validation strict. Add separate Foundry catalogue validation instead of weakening it. |
| `src/manifest/types.ts`, `src/manifest/schema.ts`, `manifest/defaults.json` | Add optional `foundryModels`; preserve existing v1 Bedrock defaults and `models` for old clients. Separate common defaults from provider projection. |
| `src/ui/modelController.ts`, `src/ui/modelPresentation.ts` | Resolve active provider/effective targets, display deployment and inventory distinctions, project verified aliases into previews. |
| `src/config/types.ts`, `src/config/managedKeys.ts` | Add provider settings and sensitive-key classification; retain owned-key merge and drift semantics. |
| `src/credential/types.ts`, `src/credential/store.ts`, `src/credential/env.ts` | Separate static resource secrets from renewable providers; remove unconditional Bedrock terminal flag injection from shared behavior. |
| `src/ui/host.ts`, `src/ui/flows.ts` | Wire provider/auth/config resolution and setup/rotation/switch flows. Do not require saved AWS token for Entra. |
| `src/health/setup.ts`, `src/health/types.ts`, `src/health/checks/config.bedrock.ts` and credential checks | Provider-aware health/remediation; no missing-Bedrock-key status on Foundry. |
| `src/util/redact.ts`, `src/diagnostics/report.ts` | Mask Foundry/API/bearer/custom-header credentials before any Azure-aware logging or support export. |
| `package.json`, README, `docs/PRD.md` | Provider-correct labels, settings, supported modes, network/cost disclosure and migration behavior. |

### Small provider boundary

Keep one scheduler/store, with provider-owned operations for resolving context,
discovering concrete targets, probing/classifying results and projecting a
recommendation. Use explicit Bedrock/Foundry variants rather than optional AWS
fields on every object. Do not introduce a dynamic plugin framework.

The deployment record needs a resource/endpoint identity, exact alias, optional
catalogue identity/family, model version, hosting, SKU, resource location,
processing scope, provisioning state, metadata source/freshness and an evidence
key. Unknown values are explicit. Role bindings map Opus/Sonnet/Haiku to these
deployments, with shared aliases deduplicated.

Keep inventory completeness and auth source/result outside the per-deployment
access status. Rank catalogue releases, not aliases, region names or numeric
hosting versions. Unknown-family aliases can be tested and preserved, but not
automatically ranked into family upgrades.

### Catalogue and periodic refresh

Reuse the existing hourly, demand-driven GitHub refresh and cached/bundled
fallback. Public Foundry metadata can include model publisher/ID, family,
lifecycle, rank, hosting/version/SKU combinations, documentation provenance,
verification date and an allowlisted probe-format identifier. Never include
tenant deployment aliases, secret-bearing endpoints, headers or executable
request templates in the shared manifest.

A new compatible model can appear without a VSIX update. A new API format needs
an adapter update and should be listed as unsupported-to-probe until then. This
still requires catalogue maintenance; “downloads periodically” does not discover
undocumented releases automatically. Disputed geography entries stay
informational pending verification.

### Scheduling, freshness and migration

Retain the Bedrock engine’s proposed operational defaults:

| Evidence/work | Default |
| --- | --- |
| Configured deployment success | Recheck after 24 hours. |
| Unselected successful alternative | Recheck after seven days. |
| Explicit access denial | Recheck after 24 hours. |
| Transient failure | Backoff starting at 15 minutes, capped. |
| Automatic runtime batch | Two workers, ten seconds/request, thirty seconds total, at most twelve runtime calls including retries. |

Run eligibility checks on activation, focus, relevant configuration/credential
changes and catalogue refresh. Record attempts before dispatch, coalesce work,
use owned cross-window leases, cancel obsolete contexts, and resume deferred
targets on later triggers. Include auth acquisition/discovery in a bounded
overall workflow; automatic credential resolution must not block activation.

Treat inventory freshness separately from invocation TTL. Refresh stale
deployment metadata before testing/recommending alternatives; re-resolve changes
before applying a preview. Bind success to model/version/hosting/SKU as well as
alias. Key-only checks cannot detect administrator retargeting reliably: show
that metadata limitation, constrain reuse and require a fresh check for upgrade
decisions. No cache can prove an alias will remain unchanged after the check.

Existing `autoCheckModels=true` is a Bedrock opt-in. Do not silently migrate it
into permission to send Azure probes. Foundry needs provider/resource-scoped
consent and processing policy. Manual recheck bypasses age/backoff, not endpoint
trust, credential identity, geography policy or call budgets. Metadata-only
reads can refresh without billable-inference consent when their discovery
configuration is enabled.

Provider switching uses the existing preview/owned-key merge semantics: preserve
inactive credentials, remove only incompatible flags owned by the extension,
surface external conflicts and respect managed settings. Do not clear user
secrets or silently write both provider flags. Refreshing a model catalogue must
never switch a provider.

## Endpoint, network and information boundaries

Foundry adds configurable origins to an engine that currently builds fixed AWS
hosts. Validate that boundary before reusing any secret:

- Require HTTPS and canonical resource/base-path syntax. Reject embedded
  credentials, query/fragment ambiguity, unexpected paths and redirects.
- Bind a secret to the configured trusted origin. Do not fetch a credential for
  an endpoint supplied by catalogue data, untrusted workspace data or a foreign
  pagination URL.
- Support normal resource hostnames resolving through private DNS; do not ban
  private addresses simply because private endpoints use them. Treat VPN/DNS
  failure as network failure, never rewrite to another public endpoint.
- Detect custom gateways/skip-auth as a distinct unsupported first-release mode.
  A future gateway adapter needs its own explicit endpoint/auth contract.
- Check Claude Code parity for proxies, NO_PROXY, custom CAs and mTLS. VS Code’s
  Node transport does not automatically match the Claude native runtime’s trust
  store. Never disable TLS verification to make a check pass. [S24]
- Public Azure is the researched target. Generic SDK support for Government or
  China does not establish Claude availability or the right endpoints/audiences.
- Store only sanitized model/access metadata locally, outside Settings Sync.
  Treat resource names/IDs as organisational metadata; disclose their inclusion
  in optional admin copy. Do not copy subscription/tenant IDs by default.

Redaction must land before new credential flows: current `SECRET_KEYS` and
diagnostic copy are Bedrock-oriented. Cover both valid and malformed settings,
provider exceptions, bearer/custom headers, refresh failures and support text.
Do not log complete SDK credential chains or ARM objects.

## Source conflicts and remaining uncertainty

| Topic | Evidence conflict / gap | Decision |
| --- | --- | --- |
| Sonnet 5.5 US Data Zone | Microsoft model overview includes it; Anthropic says Global only. | Mark disputed; no automatic US classification/probe until current account metadata and provider contract are reconciled. |
| Sonnet 5.5 Azure Global regional row | Azure hosting is listed, but some partner Global rows only show version 1. | Omission is unknown, not proof of absence or a fabricated version-2 route. |
| Foundry base URL | Microsoft Claude Code tutorial [S25] uses bare resource URL; Anthropic product docs/SDK use `/anthropic`. | Follow product/SDK path; test normalized resource and explicit-base modes. |
| Authentication | Older tutorial focuses on CLI; product docs support default chain and explicit bearer. | Product contract wins; test actual identity parity. |
| Region list / model fallback | Tutorial’s two-region/every-role framing differs from current regional docs and primary-model fallback. | Do not hardcode tutorial examples as constraints. |
| Minimal inference role | `providers/*` versus generic `MaaS/*`. | No least-privilege claim until actual Claude invocation is tested. |
| Thinking parameters | Model summary/table disagree for current generations. | Omit optional controls; validate smallest generation payload live. |
| Project inventory coverage | Route/schema verified, complete direct-account Claude coverage unestablished. | ARM first; project adapter deferred. |
| Service spillover | Generic ARM has `spilloverDeploymentName`; Claude applicability is unestablished. | Resolve and policy-check any returned fallback, or mark routing unknown/unsupported; validate live before support claims. |
| Marketplace offer/entitlement | Older per-model setup versus current platform offer; VM Agreements API is not a Claude SaaS contract. | No universal subscription preflight or diagnosis. |
| Renewable identity | Default token interface has no stable principal handle. | Verify source-specific identity or restrict cache to safe generations. |

Confidence is **high** for deployment-alias invocation, auth precedence, separate
audiences, documented discovery routes and the distinction between resource
location and processing geography. Confidence is **conditional** for individual
model/SKU/region combinations and the minimum request/role on a given tenant.
No live access or end-to-end credential parity was established in this research.

Two parallel research streams covered discovery/residency and client/auth/API
contracts, followed by repository inspection and direct spot-checks of the
highest-risk claims. Context7’s Azure JS SDK material corroborated credential
interfaces; Claude-specific primary docs took precedence over generic OpenAI
examples. All sources below were consulted on the research date; SDK `main`
links are mutable and must be pinned/rechecked during implementation.

## Verification matrix

| Area | Required future evidence |
| --- | --- |
| Config/source | Provider flag conflict, managed precedence, process-vs-terminal env, primary/Haiku fallback, remote host, explicit bearer precedence. |
| Identity | Key rotation, opaque external bearer expiry, renewable refresh, environment principal before CLI, account/tenant switch with every cached target still fresh, unknown identity continuity. |
| Discovery | Key-only success without ARM; metadata allowed/inference denied and reverse; empty vs denied vs partial inventory; malicious pagination; account/endpoint mismatch. |
| Deployment | Custom alias differs from model ID; same alias on two resources; retargeted version/SKU; returned spillover target with different scope, unknown target or cycle; pending/deleted/disabled deployment; public release without deployment. |
| Geography | Azure/Anthropic hosting, Global/allowed US Data Zone, Sweden Global, unknown metadata, disputed Sonnet scope, no cross-geography fallback. |
| Probe/errors | Valid Message vs HTML200; minimum payload per supported generation; structured 400/401/403/404/429; refresh once; disabled local auth; request timeout. |
| Persistence | TTL/backoff, last-success preservation, auth rejection barrier, call cap including retries, cross-window lease, cancellation after context switch. |
| Security/network | Endpoint validation, redirect rejection, private DNS, corporate proxy/CA, mTLS support boundary, no secret in malformed-settings diagnostics or admin copy. |
| UI/regression | Provider-correct setup/commands, stale state, keyboard/narrow panel, safe upgrade preview; all existing Bedrock checks remain valid. |

Use unit/HTTP-contract and extension-host fixtures first, then isolated VS Code
computer-use testing with synthetic adapters and screenshots. Live Azure testing
requires a designated pre-existing resource, least-privilege test identities and
approved billable probes; it is a future release gate, not part of this task.
Mocks cannot establish Marketplace, tenant RBAC, hosting geography or identity
parity. No application tests or desktop screenshots are claimed for this
documentation-only change.

## Primary sources

- **S1:** [Claude Code on Microsoft Foundry](https://code.claude.com/docs/en/microsoft-foundry) — environment, auth, deployment pinning, startup gap, role fallback and invocation roles.
- **S2:** [Claude Code environment variables](https://code.claude.com/docs/en/env-vars) — bearer precedence/version, skip-auth behavior and environment precedence.
- **S3:** [Claude in Microsoft Foundry](https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry) — deployment aliases, runtime/auth, hosting, unsupported Models API, errors and Sonnet scope restriction.
- **S4:** [Anthropic TypeScript Foundry client](https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/packages/foundry-sdk/src/client.ts) — base URL/resource exclusivity, headers, retry/timeout defaults.
- **S5:** [Deploy and use Claude models](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-claude) — Messages REST contract, AI audience, deployment/hosting and subscription prerequisites.
- **S6:** [Claude models overview](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/claude-models) — models, capabilities and deployment types; conflicting Sonnet Data Zone listing.
- **S7:** [Claude hosting comparison](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/claude-models-hosting-comparison) — Azure/Anthropic infrastructure and processing responsibilities.
- **S8:** [Claude data privacy](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/claude-models/data-privacy) — processing/retention boundaries and provider responsibilities.
- **S9:** [Azure JavaScript credential chains](https://learn.microsoft.com/en-us/azure/developer/javascript/sdk/authentication/credential-chains) — chain ordering, plugins and credential-source selection.
- **S10:** [Azure Identity bearer token provider](https://raw.githubusercontent.com/Azure/azure-sdk-for-js/main/sdk/identity/identity/src/tokenProvider.ts) — token-provider refresh mechanism.
- **S11:** [Microsoft identity access tokens](https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens) — tokens are opaque to clients.
- **S12:** [Messages create API](https://platform.claude.com/docs/en/api/messages/create) — generation request contract; prewarming differs from inference proof.
- **S13:** [ARM deployments list, 2025-06-01](https://learn.microsoft.com/en-us/rest/api/aifoundry/accountmanagement/deployments/list?view=rest-aifoundry-accountmanagement-2025-06-01) and [account GET](https://learn.microsoft.com/en-us/rest/api/aifoundry/accountmanagement/accounts/get?view=rest-aifoundry-accountmanagement-2025-06-01) — alias/model/SKU/provisioning fields and account endpoints/location.
- **S14:** [ARM account models list](https://learn.microsoft.com/en-us/rest/api/aifoundry/accountmanagement/accounts/list-models?view=rest-aifoundry-accountmanagement-2025-06-01) — account catalogue metadata.
- **S15:** [ARM location models list](https://learn.microsoft.com/en-us/rest/api/aifoundry/accountmanagement/models/list?view=rest-aifoundry-accountmanagement-2025-06-01) — optional location catalogue.
- **S16:** [Current project deployment API schema](https://ai.azure.com/api-reference/llm/deployments/list.md), [Projects JS SDK](https://learn.microsoft.com/en-us/javascript/api/overview/azure/ai-projects-readme?view=azure-node-latest) and [SDK deployment operations](https://raw.githubusercontent.com/Azure/azure-sdk-for-js/main/sdk/ai/ai-projects/src/api/deployments/operations.ts) — route, pagination, fields and Entra-only client. The older Learn project-list reference returned 404; use the current reference.
- **S17:** [Azure AI permission inventory](https://learn.microsoft.com/en-us/azure/role-based-access-control/permissions/ai-machine-learning) — management Actions and project DataActions.
- **S18:** [Configure Entra inference](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/configure-entra-id) — generic inference role and error guidance; not proof of exact Claude custom role.
- **S19:** [Cognitive Services User role](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles/ai-machine-learning#cognitive-services-user) — broad reads/DataActions and key-listing permission.
- **S20:** [Deploy Claude with the Azure developer tooling](https://learn.microsoft.com/en-us/azure/developer/ai/how-to/deploy-claude-foundry) — provisioning/terms side effects and older offer/region examples.
- **S21:** [Marketplace Agreements GET](https://learn.microsoft.com/en-us/rest/api/marketplaceordering/marketplace-agreements/get?view=rest-marketplaceordering-2021-01-01) — VM-only documented offer type; excluded from Claude entitlement design.
- **S22:** [Claude quotas and limits](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/claude-models-quotas-limits) — quota allocation and scope.
- **S23:** [Partner model region/deployment tables](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-from-partners) — version-specific Global/Data Zone regions and Marketplace provisioning permissions.
- **S24:** [Claude Code network configuration](https://code.claude.com/docs/en/network-config) — proxy, CA, mTLS and runtime trust behavior.
- **S25:** [Microsoft’s Claude Code tutorial](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/configure-claude-code) — setup examples whose path/auth/region claims require reconciliation with current product docs.
