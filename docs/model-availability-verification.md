# Bedrock model availability: implementation and verification

Verified on 30 September 2026, branch `feat/bedrock-model-availability`.

The extension now discovers explicit model routes from the downloaded manifest,
checks access with the installed credential, and offers upgrades only after a
successful invocation. A blocked new model does not invalidate a working setup.
The catalogue includes six documented Claude generations; the existing default
pins remain unchanged. Compatible future releases can be added through the
existing GitHub manifest channel without rebuilding the extension.

## Behaviour delivered

- An availability matrix separates the configured AWS source region from each
  route's processing geography. Details include exact model/profile IDs,
  timestamps, previous success, and availability metadata.
- Checks cover the actual configured Opus, Sonnet, and Haiku IDs independently.
  Working Haiku cannot conceal a denied Sonnet or Opus.
- New, unconfigured candidates require positive
  `GetFoundationModelAvailability` evidence before invocation. Metadata denial is
  inconclusive and does not prevent testing explicitly configured models.
- Automatic checks are off by default. The enablement dialog explains billable
  requests and AWS's possible first-invocation subscription behaviour. No
  project content or agreement-creation API calls are involved.
- Configured targets and access denials refresh after 24 hours; other verified
  candidates after seven days. Transient failures back off from 15 minutes.
  Manual checks bypass age and backoff.
- Two workers, a 12-target cap, 10-second request deadlines, and a 30-second batch
  budget bound each run. An owned filesystem lease deduplicates windows.
  Attempts are persisted before dispatch; inaccessible storage prevents calls.
- Evidence is scoped to credential identity, settings location, source region,
  exact target, and probe metadata. Changing context cancels obsolete requests.
  A rejection remains a barrier to older success, including across restart,
  expiry, policy changes, and inconclusive retries.
- Policy exclusions apply to both automatic and manual checks. There is no
  silent fallback to a global route. Unsupported source-region routes are not
  invoked.
- Upgrades use the existing preview, drift protection, and backup flow. Merely
  discovering or probing a model never changes its pin. Existing pins survive
  missing/mismatched credentials, and verified upgrades preserve their source
  region. Opaque custom pins are not replaced by arbitrary catalogue rankings.
- Administrator requests and diagnostics contain safe IDs and evidence, with no
  bearer token, raw AWS response body, or credential fingerprint field.

## Automated validation

| Check | Result |
| --- | --- |
| `bun run lint` | Clean; no warnings |
| `bun run typecheck` | Passed |
| `bun run test` | 2,086 passed, 2 existing skips across 57 files |
| New model-engine tests | 73 passed, included above |
| Final focused configuration checks | 45 passed after test-only lint cleanup |
| `DISPLAY=:99 bun run test:integration` | 7 passed, 1 existing platform skip; host exited 0 |
| `bun run package -- --out out/model-availability.vsix` | Passed; ten packaged files, approximately 103 KB |
| Impeccable mechanical UI detector | No findings |
| `git diff --check` | Passed |

Coverage includes error classification, malformed/oversized responses, redirects,
missing metadata permission, exact configured targets, persistent cache reuse,
credential replacement, source-region changes, cancellation, bounded dispatch,
lease recovery and ownership races, schema compatibility, catalogue growth,
recommendation preservation, expired credential evidence, and UI escaping.

## Computer-use verification

Used the actual packaged extension in VS Code 1.139.1 on Linux, with `xdotool`
and `scrot` on `DISPLAY=:99`. The profile, extension directory, workspace, and
`CLAUDE_CONFIG_DIR` were isolated beneath `/tmp/scd-models-qa-uzkwnb7h`.
All AWS responses were synthetic. Screenshots are actual desktop captures.

| Journey | Observed result | Screenshot |
| --- | --- | --- |
| Fresh setup | Masked key input, request/subscription disclosure, successful configured-model checks | `setup-disclosure.png` |
| Blocked release | Sonnet 5.5 needs administrator enablement; configured models remain healthy | `model-matrix.png` |
| Automatic consent | Native dialog explains billable probes and potential subscription effects | `automatic-consent.png` |
| Verified upgrade | Preview proposes exactly one Sonnet pin change; cancel leaves settings byte-identical | `upgrade-preview.png` |
| Apply upgrade | Only Sonnet changed from 5 to 5.5; backup exactly matches the prior file | `upgrade-verification.json` |
| Configured denial | Sonnet is flagged despite working Opus and Haiku; credential remains verified | `configured-denial.png` |
| Invalid credential | Rejection overrides older successes and stops further dispatch | `invalid-credential.png` |
| Metadata permission denied | Configured targets can work; unconfigured alternatives remain unverified | `metadata-denied.png` |
| Offline / throttled | Distinct inconclusive states, without presenting old success as fresh access | `offline.png`, `throttled.png` |
| Policy restriction | EU-only policy excludes configured global IDs; recheck sends no requests from the US source region | `eu-only-policy.png` |
| Stale evidence | Neutral information status, explicit stale cells, no green current-success claim | `stale-evidence.png` |
| Narrow sidebar | Horizontal table scrolling works with keyboard arrows; visible focus, wrapping IDs, working disclosure | `keyboard-scroll.png` |
| Themes | Native dark, light, and high-contrast themes remain readable | `model-matrix.png`, `light-theme.png`, `high-contrast.png` |

The upgrade preview was cancelled first, then applied. File comparison proved
cancellation made no write and application changed only
`ANTHROPIC_DEFAULT_SONNET_MODEL`. A backup exists with byte-identical original
contents. The fixture then restored the old Sonnet pin to exercise configured
access-denial and blocked-upgrade cases.

Request-log checkpoints establish the scheduler behaviour independently of UI:

| Checkpoint | Total HTTP requests | Total runtime invocations |
| --- | ---: | ---: |
| Before fresh reload | 129 | 55 |
| After fresh reload | 129 | 55 |
| After expiring evidence and reloading with automatic checks enabled | 140 | 60 |
| Before stale reload with automatic checks disabled | 140 | 60 |
| After that disabled reload | 140 | 60 |
| Before EU-only manual recheck | 140 | 60 |
| After EU-only manual recheck | 140 | 60 |

The stale refresh made six metadata calls and five invocations; the blocked
candidate did not receive an invocation. All runtime IDs in the fixture request
log were global IDs, matching the selected policy. No excluded geography was
contacted. Cache files and the copied administrator request were checked for the
synthetic token and contained none.

## Findings fixed during verification

- Existing pins were at risk when credentials could not establish a probe
  context; recommendation fallback now preserves them.
- Generic Apply Defaults could reset a custom source region while applying a
  model verified elsewhere; resolved recommendations preserve the tested region.
- An expired rejection or inconclusive retry could restore an older successful
  credential verdict; a persistent failure timestamp prevents that.
- Repeated forced batches could starve candidates beyond the cap; untested and
  older alternatives now rotate after configured targets.
- Working configurations with optional upgrades appeared unhealthy; verified
  upgrades are informational.
- Successful metadata was labelled as successful invocation; those evidence
  types now have distinct labels.
- Windows CI found a Unix permission-bit assertion in the cache test. That
  assertion now runs only on POSIX; cache behaviour remains tested on Windows.
- Stale configurations used a green success icon, and light-theme success text
  had poor contrast. Stale status is now neutral; success uses a theme-appropriate
  text colour.

## Scope and limitations

This run proves extension behaviour against controlled AWS responses, not live
account entitlement, Marketplace subscription, regional routing, or billing.
No real AWS credentials were used. AWS documents that first inference can initiate
a subscription; preflight is not an atomic protection against that side effect.
Organisations requiring a strict prohibition must enforce it through IAM.

The Linux desktop had no usable OS keyring. Its first synthetic secret did not
survive reload. The test session was relaunched with `--password-store=basic`
using only the dummy credential, after which persistence/reload checks passed.
OS-backed keychain encryption was not verified. The downloaded Electron binary
also needed `--no-sandbox` because its sandbox helper lacked required ownership.
Neither flag changes the distributed extension or is recommended for production.

An initial reload activated the product before the fixture interceptor, making
that reload invalid as synthetic evidence. The installed test copy's dependency
metadata was adjusted to activate `local-test.scd-model-qa` first, and reload
checks were repeated. The shipped VSIX is unmodified and excludes the harness.
`test/desktop/README.md` records the fixture procedure.

Windows/macOS physical desktop behaviour and screen-reader output were not
exercised here. Existing skipped tests are reported rather than counted as passes.
No release, Marketplace publication, merge, or version bump was performed.

## Artifacts and implementation map

- Installable development package: `out/model-availability.vsix`.
- Screenshots, safe request/action logs, test logs, administrator request, and
  upgrade evidence: `out/model-availability-evidence/` (ignored build artifacts).
- Engine and persistence: `src/models/`.
- Host coordination and health presentation: `src/ui/modelController.ts`,
  `src/ui/modelPresentation.ts`, and `src/extension.ts`.
- Matrix and commands: `src/ui/panel/` and `src/ui/commands.ts`.
- Catalogue: `manifest/defaults.json`; schema under `src/models/catalogueSchema.ts`.
- Design and completed acceptance criteria: `plans/feat-bedrock-model-availability.md`.

AWS references: [model access](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html),
[availability API](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_GetFoundationModelAvailability.html),
[API keys](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-reference.html),
[cross-region inference](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html).
