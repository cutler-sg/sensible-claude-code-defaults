> Historical plan preserved on 2026-10-22. Open implementation tasks are proposals, not completed features or release prerequisites. See [the maintenance backlog](../docs/maintenance-backlog.md).

# Claude model availability on Azure Foundry: implementation plan

- Date: 2026-09-30.
- Research branch: `docs/azure-foundry-availability-plan`.
- Baseline: `5377d85`, including the completed Bedrock availability implementation.
- Status: Research complete; implementation not started or authorised by this request.
- Companion: [Research and decisions](../docs/azure-foundry-model-availability-research.md).

## Scope and outcome

Extend the existing model catalogue, stale-result refresh, health panel and upgrade
preview to Claude deployments on Microsoft Foundry. Show public model support,
actual deployments, processing scope and observed inference access separately.
Keep working aliases until the user applies a verified recommendation.

This document proposes future work. The current request authorises documentation
only: no application changes, Azure calls, credentials, deployments or releases.
The estimates below are implementation sizing, not delivery commitments.

### Acceptance criteria for this research

- [x] Verify Claude Code configuration, runtime API and authentication against primary sources.
- [x] Compare ARM and project discovery, including permission and coverage limits.
- [x] Research hosting, geography, Marketplace restrictions and quota semantics.
- [x] Inspect the existing Bedrock implementation and identify concrete integration points.
- [x] Record source conflicts, recommendations, non-goals and live-validation gates.
- [x] Define ordered implementation tasks with observable acceptance criteria.
- [x] Validate document links, whitespace and documentation-only diff; prepare the research handoff.

## Recommended release boundary

Include Public Azure, Opus/Sonnet/Haiku, configured deployment checks using API key
or explicitly supplied bearer, renewable Entra credentials with verified Claude
Code identity parity, and optional account-scoped ARM inventory. Reuse the
existing scheduler and UI. Detect unsupported authentication/network configurations
without trying a different identity.

Defer project/connected deployment discovery, arbitrary gateways, sovereign
clouds, tenant-wide resource enumeration and deployment provisioning. These are
separate capabilities, not prerequisites for checking a configured deployment.
Keep Fable/Mythos out of this three-family release; adding families needs its own
product/configuration contract.

## Dependency order

Research → compatibility spike → redaction/config/auth boundary → provider
contracts → catalogue + discovery + runtime adapter → evidence scheduling → UI
and setup → automated validation → isolated desktop validation → designated live
validation → release review.

Implement on a new feature branch based on the final Bedrock baseline. If the
Bedrock PR changes before merging, reconcile this plan against its final code.
Commit each coherent task with its validation. Do not perform implementation
tasks as part of the current research-only request.

## 1. Resolve external compatibility contracts

- [ ] **F1 — Pin and verify the supported Claude Code contract** [Complex, 4–8h].
  Inspect effective configuration resolution in `src/ui/host.ts`,
  `src/ui/modelController.ts`, `src/config/` and the installed Claude Code version
  used for future testing. Define settings/process/managed environment precedence,
  execution host, provider flags, active primary model and role fallback handling.
  Record the supported Claude Code and Azure Identity versions.
  **Accept:** a compatibility table covers key, explicit bearer (v2.1.203+),
  renewable chain, conflicting flags, managed settings, remote host and shell-only
  overrides. Unknown session-specific `--model` selections are labelled outside
  the checker’s observed configuration, never claimed checked.

- [ ] **F2 — Resolve renewable identity continuity** [Complex, 4–8h; depends F1].
  Evaluate the documented default credential chain in the extension host against
  Claude Code’s actual chain/plugins. Choose supported source integrations and
  their stable identity/change signals. Prefer `@azure/identity` for token
  acquisition; keep the existing bounded HTTP transport for inference.
  **Accept:** source parity is demonstrated for each advertised mode; no new
  interactive account or fallback principal is introduced. Unsupported or
  unobservable parity is explicit. Opaque tokens work without JWT parsing.
  Where principal continuity is unavailable, evidence is credential-generation
  limited, not persisted as current cross-session access. A CLI-only slice may
  ship only if named as such and Claude Code is verified to use the same source.
  Resolve the current source/generation before restoring evidence as current;
  reusing a cached SDK token alone is not proof of external account continuity.

- [ ] **F3 — Validate the Azure wire contract in a designated test resource**
  [Complex, 4–8h; depends F1; live gate below]. Check current deployment/account
  response fields, aliases, hosting/SKU mapping and the smallest billable Messages
  payload across supported generations. Capture only sanitized fixtures.
  **Accept:** `max_tokens:1` is either verified per supported probe format or
  replaced by a documented bounded alternative. No zero-token/token-count request
  counts as inference success. Resolve Sonnet 5.5 geography contradictions before
  enabling its disputed routes. Confirm the exact minimal inference DataAction;
  do not publish a speculative custom role.
  Establish whether generic ARM spillover routing applies to Claude; absence of
  that validation cannot justify assuming a returned spillover field is inert.

## 2. Establish config, secret and endpoint boundaries

- [ ] **F4 — Make redaction safe before adding Foundry state** [Medium, 3–5h].
  Extend `src/config/managedKeys.ts`, `src/util/redact.ts` and
  `src/diagnostics/report.ts` for Foundry keys, explicit bearer tokens,
  Authorization/custom headers and credential-provider failures. Include malformed
  settings handling and the secret registry/leak-scan callers discovered during
  implementation.
  **Accept:** sentinel secrets never appear in previews, diagnostics, logs,
  cache files, errors or administrator copy; full ARM responses are not retained.
  Redaction covers recognized sensitive fields even when the extension does not
  own/manage them.

- [ ] **F5 — Resolve provider configuration and trusted endpoints**
  [Complex, 4–8h; depends F1,F4]. Update `src/config/types.ts`,
  `src/manifest/types.ts`, `src/ui/host.ts` and controller resolution. Represent
  provider/auth modes explicitly. Validate resource-name and full `/anthropic`
  base URL modes; bind credentials to the canonical resource origin. A user or
  trusted administrator configuration supplies resource IDs, never GitHub data.
  **Accept:** mixed provider flags, dual resource/base URL, malformed endpoints,
  userinfo, query/fragment and redirects fail safely. Workspace settings cannot
  redirect secrets or broaden consent. Bedrock projection never runs on Foundry.
  ARM metadata must match the configured origin before enriching its targets.

- [ ] **F6 — Implement provider-aware credential and terminal handling**
  [Complex, 4–8h; depends F2,F4,F5]. Adapt `src/credential/types.ts`,
  `src/credential/store.ts`, `src/credential/env.ts`, and setup flows. Preserve
  existing Bedrock storage; namespace Foundry static secrets by trusted resource.
  Keep renewable and externally supplied access tokens out of durable extension
  storage. Match bearer → key → default-chain precedence.
  **Accept:** key setup uses Foundry validation and labels; Entra requires no
  stored Bedrock key; externally owned bearer expiry requests upstream refresh;
  renewable auth refreshes without changing identity. New terminal injection is
  nonpersistent and provider-correct. Switching preserves inactive credentials,
  previews owned flag removal and respects drift/managed settings. Existing
  terminals/sessions receive an accurate restart notice when needed.

## 3. Extend the model engine without duplicating it

- [ ] **F7 — Introduce the small provider strategy boundary**
  [Complex, 4–8h; depends F5]. Adapt `src/models/types.ts`,
  `src/models/service.ts`, `src/ui/modelController.ts` and
  `src/ui/modelPresentation.ts`. Separate catalogue models, deployments,
  inventory capability, auth evidence and invocation evidence. Add Bedrock and
  Foundry adapters; retain shared orchestration and storage.
  **Accept:** the service no longer assumes AWS region/ID generation or emits
  `AWS_REGION` for Foundry. Existing Bedrock behavior passes its regression suite.
  No generic plugin registry, executable manifest or duplicated scheduler appears.

- [ ] **F8 — Add the bounded Foundry catalogue** [Medium, 3–5h; depends F7].
  Add optional `foundryModels` metadata through `src/manifest/types.ts`,
  `src/manifest/schema.ts`, provider-specific catalogue validation and
  `manifest/defaults.json`. Keep v1 Bedrock defaults and `models` compatible.
  Include release rank, publisher/model/version, lifecycle, documented hosting/SKU
  combinations, source/date and supported probe format. Publish only verified
  combinations; retain disputed entries as informational unknowns.
  **Accept:** old manifests/clients still work. New compatible releases appear
  after the existing GitHub refresh without a VSIX. No deployment aliases,
  account endpoints, arbitrary payloads, headers or executable URLs are accepted.
  Catalogue presence alone schedules zero Foundry inference calls.

- [ ] **F9 — Add optional read-only ARM inventory**
  [Complex, 4–8h; depends F2,F5,F7; validate against F3]. Introduce a Foundry
  discovery adapter under `src/models/`. Start with account GET and deployment
  list API `2025-06-01`, using a separately scoped management token. Account model
  list is optional contextual information, not an entitlement check. Validate
  schemas, resource/endpoint association, pagination and provisioning states.
  **Accept:** API-key configured checks need no ARM permission; denied inventory
  differs from complete empty inventory; partial pages never establish absence.
  If `spilloverDeploymentName` is present, resolve and policy-check all possible
  routes with bounded cycle detection, or mark routing unknown/unsupported.
  Bound pages/bytes/rows/time; validate every `nextLink` origin and account path.
  No `listKeys`, subscription enumeration, role changes or write API calls.

- [ ] **F10 — Implement the Foundry Messages probe**
  [Complex, 4–8h; depends F3,F6,F7]. Add the provider adapter alongside
  `src/models/probe.ts`: exact deployment alias, correct path/headers, fixed tiny
  input, nonstreaming response validation, sanitized reasons/correlation IDs.
  Integrate token acquisition and one bounded renewable-auth refresh into the
  total budget; avoid SDK retry multiplication.
  **Accept:** auth rejection, authorization denial, missing deployment, request
  incompatibility, quota, network and service errors remain distinct. HTTP 200
  HTML cannot pass. Generic 403 never means invalid key or missing Marketplace
  subscription. No failed explicit credential falls back to another source.

- [ ] **F11 — Extend cache identity, freshness and consent**
  [Complex, 4–8h; depends F6,F7,F9,F10]. Adapt `src/models/store.ts`, scheduler and
  `package.json` model-check settings. Scope consent by provider/trusted resource;
  keep the existing Bedrock opt-in intact without enabling Azure requests.
  Version cache data; bind evidence to resource, deployment metadata and resolved
  credential identity/generation. Refresh inventory before recommending aliases.
  **Accept:** same alias in another resource, principal switch, alias retargeting,
  auth-mode changes, service spillover and processing-policy changes cannot
  inherit current success.
  Unknown principal continuity invalidates on token generation change. Lease,
  cancellation, persistence-before-dispatch and stale-result protections survive.
  With every target still fresh, switching accounts then focusing/restarting the
  extension cannot reuse the previous account’s success to skip resolution or
  recommend an upgrade; results stay historical until identity is established.
  Automatic budgets remain two workers, ten-second request, thirty-second batch,
  twelve runtime calls including retries, with configured targets first. Deferred
  targets resume on a later trigger. Token acquisition cannot block activation.

## 4. Integrate setup, matrix and recommendations

- [ ] **F12 — Make health/setup provider-aware** [Complex, 4–8h; depends F6,F11].
  Update `src/health/types.ts`, `src/health/setup.ts`, provider config/credential
  checks, `src/ui/flows.ts`, command dispatch and `package.json` descriptions.
  **Accept:** Foundry Entra users never get missing-Bedrock-key remediation;
  effective configured aliases and primary-model fallback are reflected; source
  configuration and last verification age are visible. Unsupported gateway or
  network parity is actionable and does not trigger automatic alternate auth.

- [ ] **F13 — Present deployment and jurisdiction evidence**
  [Complex, 4–8h; depends F8,F9,F11,F12]. Extend matrix/presentation with public
  model, alias, resource location, hosting, deployment SKU, processing scope,
  inventory completeness and invocation evidence. Keep the active resource view
  concise; expose detailed provenance on demand.
  **Accept:** Global in Sweden never renders EU-verified; disputed catalogue scope
  is unknown; key-only aliases remain usable with unknown metadata under explicit
  policy. Unknown scopes are never automatically broadened. Catalogued releases
  have “No deployment found” only with complete fresh inventory, otherwise
  “Deployment unknown”. Read-only refresh does not require inference consent.

- [ ] **F14 — Add safe upgrades and administrator requests**
  [Medium, 3–5h; depends F13]. Reuse configuration preview/merge and model-access
  copy actions. Rank actual mapped deployments by catalogue release metadata.
  **Accept:** only verified, policy-allowed aliases on the active endpoint are
  proposed; unknown-family aliases remain configured without speculative upgrades.
  No AWS region write, endpoint fallback or automatic alias replacement occurs.
  Admin text distinguishes deployment creation, access review and inconclusive
  checks; includes no credentials and claims no unverified subscription cause.

## 5. Verify and prepare a future release

- [ ] **F15 — Complete focused automated coverage** [Complex, 4–8h; depends F14].
  Add unit/contract tests alongside each implementation task, then run existing
  typecheck, lint, build, full unit suite, extension-host tests and VSIX packaging.
  Cover the [research verification matrix](../docs/azure-foundry-model-availability-research.md#verification-matrix).
  **Accept:** identity, origin, geography and provider isolation tests fail when
  those boundaries are deliberately broken; malformed/untrusted data is covered;
  complete existing Bedrock tests pass on Linux, Windows and macOS CI. No tests
  use production Azure credentials or assert live access from mocks.

- [ ] **F16 — Test the actual VSIX through isolated computer use**
  [Medium, 4–6h; depends F15]. Use `DISPLAY=:99`, `xdotool`, `scrot`, fresh
  `--user-data-dir`, `--extensions-dir` and `CLAUDE_CONFIG_DIR`. Use injected
  synthetic adapters confined to the test harness; keep production endpoint
  validation intact. Never touch existing sessions or real credentials.
  **Accept:** screenshots show key-only working alias, denied discovery,
  non-deployed new model, renewable auth state, expired external bearer, unknown
  jurisdiction, stale refresh, access denial and upgrade preview. Verify reload,
  keyboard access, narrow panel, provider switching, and secret-free diagnostics.
  Report synthetic results separately from live evidence.

- [?] **F17 — Execute designated live Azure validation** [Complex, 4–8h initial
  pass; blocked: no designated Azure test resource/identity supplied, and this
  request is research only]. Provisioning and Marketplace acceptance are an
  administrator prerequisite, not test actions. Use separately designated
  inference-only and metadata-read identities with pre-existing deployments.
  **Accept:** prove actual Claude Code/checker identity parity, real custom aliases,
  key and bearer paths, renewable refresh/account switch, allowed hosting/SKUs,
  discovery denial with successful inference and its converse, least-privilege
  errors, and required corporate proxy/private DNS/CA paths. Document untested
  combinations and disable unsupported claims. Validate F3 before adapter rollout.

- [ ] **F18 — Write verification and release documentation**
  [Medium, 2–4h; depends F15–F17]. Update README, PRD, network/cost disclosure,
  configuration instructions, administrator guidance and support matrix. Record
  API/SDK versions and sanitised live fixtures; prepare a reviewable PR and VSIX.
  **Accept:** release notes distinguish catalogue freshness from tenant access;
  no unsupported geography or generic Entra parity claim remains; evidence links
  and screenshots are included. Release/publication requires the future task’s
  authorization and normal repository release checks.

## Deferred follow-on work

- [ ] Project deployment discovery: prove direct-account Claude coverage; resolve
  `connectionName` routes under separate permission and endpoint trust before use.
- [ ] Additional explicitly registered resources for a cross-resource matrix;
  never automatically scan every subscription or geography.
- [ ] Dedicated gateway adapters and sovereign-cloud support, each with verified
  product availability, authentication, network and processing-scope contracts.
- [ ] A verified read-only Claude SaaS entitlement API, if Microsoft publishes one.
  Do not substitute the VM Marketplace Agreements API or a deployment write.

## Handoff risks

The critical path is identity parity and live validation, not drawing the matrix.
Mutable documentation cannot resolve account-specific access or contradictory
SKU availability. If a gate fails, narrow the advertised capability and retain
an explicit unknown state; do not substitute guessed model IDs, credentials,
regions or subscription diagnoses.
