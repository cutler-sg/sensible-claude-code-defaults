> Historical research preserved for 1.2.1 preparation on 2026-10-22. Findings and external facts are dated 2026-09-30; implementation status and release scope are tracked in [the maintenance backlog](maintenance-backlog.md). Local `out/` and `/tmp/` evidence links may be unavailable in a fresh clone.

# Extension UI/UX review — 30 September 2026

The current build is suitable for moderated usability research on 1 October,
with one qualification: fix or explicitly account for the credential-status
defect before testing error recovery. A recovered credential is incorrectly
reported as rejected when a later request fails offline or is rate limited.
That is product behavior, not a participant comprehension failure.

The initial key flow is clear and restrained. The maintenance panel is less
successful: the full model/geography catalogue dominates the sidebar, important
actions sit below it, and the upgrade preview clips the version being approved.
The proposed direction is a compact summary of configured models and contextual
next actions, with catalogue comparison and exact evidence available on demand.
This review changes documentation only; recommendations remain proposals.

## Build and method

- Product code baseline: `5377d85`; reviewed checkout `e18435a` adds Foundry
  research documentation. Product package version: `1.0.0`.
- Fresh package: [current.vsix](../out/uiux-review-2026-09-30/current.vsix).
  SHA256: `001862bfcf717f3b748c3f97a61fed3d3ceb5c4b29b594cd743b0ab278859cc6`.
- Native VS Code `1.139.1`, official Claude Code extension `2.1.285`, Linux X11,
  `DISPLAY=:99`, 1920 × 1080 desktop. Actual mouse/keyboard interactions used
  `xdotool`; captures used `scrot` and were inspected with vision.
- New isolated user-data, extensions, workspace and Claude configuration under
  `/tmp/scd-uiux-review-KEY413`. Existing sessions and real credentials were not
  used. Only this review's window was closed, using Alt+F4.
- [Desktop harness](../test/desktop/harness.ts) intercepted Bedrock and manifest
  requests using a dummy token and synthetic responses. Its dependency was
  appended only to the installed fixture copy so interception activated first;
  shipped source and VSIX were unmodified.
- Sidebar widths approximately 300, 500 and 694 px; Dark Modern, Light Modern,
  Dark High Contrast; two native Zoom In increments. No exact zoom percentage
  or numerical contrast claim is made.
- Independent design and source/accessibility assessments were completed before
  synthesis. Impeccable's source detector ran once: exit 0, stdout `[]`, zero
  findings. This does not establish native usability or accessibility compliance.
- Build/package succeeded. No software test suite was rerun for this
  documentation-only review. Behavioral findings come from the native fixture
  and source investigation, not a new automated regression suite.

Artifacts, including 26 product screenshots, cropped excerpts, safe request/action
logs and both independent assessments, are in
[out/uiux-review-2026-09-30](../out/uiux-review-2026-09-30).
[evidence.json](../out/uiux-review-2026-09-30/evidence.json) records package and
screenshot hashes and 115 synthetic Bedrock requests across six scenarios.
These artifacts are local and ignored by Git; the report and plan are committed.
Capture `00` is an initial launch diagnostic, and `24` is a theme picker;
neither is counted as product evidence.

## High-priority findings

P1 means a material task or trust problem to address before broader rollout;
P2 means a usability or accessibility improvement requiring follow-up. No P0
was established in this bounded assessment.

| ID | Priority | Finding | Evidence strength |
| --- | --- | --- | --- |
| U1 | P1 | Old credential rejection resurfaces after successful recovery | Native reproduction and source trace |
| U2 | P1 | Catalogue matrix overwhelms the normal sidebar | Native layout and keyboard navigation |
| U3 | P1 | Upgrade preview clips the decisive new version | Native preview and command wiring |
| U4 | P1 | Recovery action does not match the failure | Native denial/rejection and command wiring |
| U5 | P1 | Recheck discards reading position | Controlled mouse reproduction and source trace |

### U1 — recovered authentication becomes “rejected” after a transient failure

Reproduced with the same fixture key/context:

1. Select `invalid-credential`: headline says “AWS rejected this credential”.
2. Select `available-upgrade`: invocations succeed and the headline becomes healthy.
3. Select `offline`: rows say “Connection or service failure”, but the headline
   and credential summary return to “rejected”.
4. Recover with `available-upgrade`, then select `throttled`: rows say
   “Rate limited · retry later”, while the headline again says “rejected”.

Evidence: [rejection](../out/uiux-review-2026-09-30/shots/14-invalid-credential.png),
[offline](../out/uiux-review-2026-09-30/shots/15-offline.png),
[recovery](../out/uiux-review-2026-09-30/shots/16-recovered.png), and
[throttle](../out/uiux-review-2026-09-30/shots/17-throttled.png).
The request log corroborates successful invocations between rejection and
transient failure. The throttle capture below is cropped from the native image.

![Rate-limited model rows contradict the rejected-credential headline](../out/uiux-review-2026-09-30/credential-status-crop.png)

Root cause: [ModelAvailabilityService.snapshot](../src/models/service.ts),
lines 162–177, computes `successAt` only from currently available, fresh rows.
The worker retains newer `lastSuccessAt` evidence on transient outcomes, but
the authentication verdict ignores it and lets the older rejection win within
its 24-hour lifetime. Inspected evidence contained `lastSuccessAt:
1790758864560` and `lastCredentialFailureAt: 1790758840792` with status
`network-error`: later successful authentication exists.

Proposal: derive authentication from chronological evidence for the current
credential/context, independently of current target availability. A later
success must supersede an older rejection; an older success must not override
a newer rejection. Keep current model access inconclusive after transient
failures. Verify both orderings, offline/throttle after recovery, stale evidence
and credential/context changes in focused regression coverage.

For tomorrow: use separate fresh profiles for denial, invalid-key and transient
tasks if this remains unfixed. Record this sequence as a known defect. Do not
score participants down for trusting its incorrect headline.

### U2 — the primary surface makes users inspect a catalogue

At roughly 300 px, only the model name and Global result fit; even the wide
sidebar needs horizontal scrolling. Six model versions × seven scope columns
contain many repeated exclusions or absent routes. The blocked, unconfigured
Sonnet 5.5 appears before working configured models. Automation and administrator
controls follow the table; automation controls are below the default viewport.

Evidence: [default width](../out/uiux-review-2026-09-30/shots/06-healthy-default-width.png),
[wide](../out/uiux-review-2026-09-30/shots/07-healthy-wide.png),
[lower actions](../out/uiux-review-2026-09-30/shots/18-narrow-lower-actions.png),
[keyboard horizontal scroll](../out/uiux-review-2026-09-30/shots/19-keyboard-horizontal-scroll.png).
Arrow-key scrolling works with visible focus, but model names disappear at
the rightmost columns. [modelsSection](../src/ui/panel/html.ts), lines 165–201,
renders the catalogue independently of the native Details disclosure.

Proposal: lead with the three configured models, their exact configured scope
and result. Put alternatives/full geography comparison behind a disclosure;
label blocked alternatives as not affecting the working configuration. Keep
row identity sticky if retaining the wide table. Put relevant actions beside
their status. Test whether users distinguish a blocked upgrade from a broken
setup; confusion is a hypothesis, not observed user behavior.

### U3 — the upgrade preview hides what users must approve

The preview shows `global.anthropic.claude-sonnet-5 →
global.anthropic.claude-sonnet-5…`; the new version suffix is clipped. Cancel is
safely selected first, but the visible comparison cannot establish the change.
Selecting an informational row dismisses/cancels rather than revealing detail.

![Upgrade preview clips the new model version](../out/uiux-review-2026-09-30/upgrade-preview-crop.png)

Evidence: [full preview](../out/uiux-review-2026-09-30/shots/12-upgrade-preview.png).
[applyDefaults](../src/ui/commands.ts), lines 239–255, supplies raw change
descriptions as labels without secondary detail.

Proposal: primary text “Sonnet 5 → Sonnet 5.5 · Global unchanged”, with full
IDs in readable secondary detail. Keep explicit Apply and Cancel-first behavior.
Tomorrow, require participants to state the exact version and geography change
before consenting; record whether they can establish it from the preview.

### U4 — recovery promotes retries for problems users cannot resolve by retrying

Both a configured model denial and confirmed invalid key promote “Recheck
models”. The administrator-request action is after the matrix; Replace key is
a secondary link. Model denial repeats Recheck above and below the table.

Evidence: [configured denial](../out/uiux-review-2026-09-30/shots/13-configured-denial.png)
and [invalid key](../out/uiux-review-2026-09-30/shots/14-invalid-credential.png).
[modelHealth](../src/ui/modelPresentation.ts), lines 26–40, assigns the same
fix to model outcomes. Healthy Test connection and Recheck models also force
the same availability engine, with different result/progress presentation.
This is label ambiguity; concurrent checks coalesce, so the UI does not prove
duplicate billable requests.

Proposal: denied/enablement → Copy administrator request; confirmed rejected
key → Replace key; transient outcome → Retry. Name the configured model and
cause in the summary, use one consistent model-check label, and omit duplicate
actions. Test whether users choose the appropriate resolution unaided.

### U5 — rechecking loses the place being inspected

After expanding evidence, scrolling to its bottom and moving the matrix
horizontally, a controlled mouse click on Recheck resets the vertical position
to the top and the table horizontally to the left. Evidence stays expanded.

Evidence: [before mouse refresh](../out/uiux-review-2026-09-30/shots/21-before-mouse-refresh.png)
and [after mouse refresh](../out/uiux-review-2026-09-30/shots/22-after-mouse-refresh.png).
[PanelProvider.paint](../src/ui/panel/provider.ts), lines 146–157, preserves
the key-entry document but replaces the full HTML for other states. Only
evidence disclosure openness is persisted. Background refresh interruption is
a source-backed risk; this reproduction used an explicit mouse refresh.

Proposal: update stable content in place or retain scroll positions and control
identity across repaint. Move focus deliberately for user-initiated transitions.
Exact keyboard focus restoration and spoken announcements were not verified.

## Additional findings

| ID | Priority | Finding and proposal | Basis |
| --- | --- | --- | --- |
| U6 | P2 | Continue also establishes region/model defaults before effective routing is disclosed. Show the planned source region and Global-processing implications before submission; label it “Save key and test”. | Captures 02/04; `PanelProvider.submit`, lines 234–240 |
| U7 | P2 | Key entry has no Back/Cancel; successful Done offers no clear next instruction to use Claude. Add a visible return path and usage handoff. | Captures 02–06; setup markup/message handling |
| U8 | P2 | Processing policy uses lowercase codes and “0 Selected” for inherited policy; the explanatory placeholder clips. Show user-facing geography names and effective policy. | Capture 10 |
| U9 | P2 | Configured marks a whole model row rather than its exact scope cell. Mark the configured route and include scope in the compact summary. | Capture 07; `modelsSection`, lines 174–181 |
| U10 | P2 | Details opens a separate lower native tree with its own scrollbar. Label the destination clearly and provide a native navigation handoff. | Capture 08 and provider wiring; speech/navigation impact remains unverified |
| U11 | P2 | Setup outcomes lack deliberate focus/live announcements; reveal control lacks exposed current state; validation lacks `aria-invalid`. Maintain accessible state and meaningful outcome focus/announcements. | Source inspection; screen-reader behavior remains unverified |

The independent design assessment scored the interface 25/40 across Nielsen's
ten heuristics. This is a subjective diagnostic score, not a measured usability
result. Both assessments independently identified matrix overflow, clipped
upgrade consent and mismatched recovery prominence.

## What works and should survive refinement

- First run has one clear setup action, a masked key field and useful inline
  correction for pasted spaces; creation/storage guidance uses disclosures.
- Automatic-check consent explicitly discloses tiny billable requests and
  possible Marketplace subscription initiation. Upgrades default to Cancel.
- A configured Sonnet denial remains visible when other models work; a blocked
  alternative does not itself invalidate the current configuration.
- Source region and processing geography are separate concepts in the UI.
- Tab/Enter expands model evidence, keyboard arrows scroll the matrix, and
  visible focus was observed. The table has headers and a named scroll region.
- Light and high-contrast captures appear readable. Two Zoom In increments
  showed readable wrapping; catalogue overflow and actions below the fold
  persist. No numerical contrast or WCAG conformance claim follows.
- Expired evidence loses its healthy headline and receives a stale marker with
  automatic checks off. Historical success is not presented as current access.

## Coverage and screenshot index

| Journey/check | Captures | Observed result |
| --- | --- | --- |
| First run, key entry, correction, help, success | 01–05 | Clear visual flow; no visible return action |
| Healthy default/wide widths and Details | 06–08 | Working setup; persistent two-axis catalogue navigation |
| Automatic-check consent | 09 | Explicit cost/subscription disclosure |
| Processing policy and available upgrade | 10–12 | Policy wording ambiguity; decisive preview suffix clipped |
| Configured denial and credential rejection | 13–14 | Distinct outcomes, same promoted retry |
| Offline, recovery, throttle | 15–17 | Authentication regression reproduced |
| Lower actions, keyboard scroll and evidence | 18–20 | Actions reachable; focus visible; row names lost on horizontal scroll |
| Controlled mouse refresh | 21–22 | Scroll reset, evidence disclosure retained |
| Light, high contrast, increased zoom | 23, 25–26 | Visually readable; matrix still overflows |
| Expired evidence and reload | 27 | Fresh-check headline and stale labels; auto checks remained off |

Full captures are in [shots](../out/uiux-review-2026-09-30/shots).
The fixture supports `metadata-denial`, but that scenario was not exercised in
this pass. Upgrade preview/cancel was assessed; applying an upgrade and sending
an actual Claude message were not part of this review. Synthetic model IDs and
successes are fixture data, not independently verified launch or availability
claims. Live AWS entitlement, billing, performance, screen-reader output,
Windows/macOS behavior and OS keychain encryption were not verified.
The fixture used `--no-sandbox` for downloaded Electron and
`--password-store=basic` for its dummy secret.

## Follow-up — first-time, non-technical business users

Michael confirmed the audience and reported a participant opening missing-key
help, clicking through to AWS and becoming lost. That is direct user evidence
that the handoff failed. The cause inside AWS is unknown: sign-in, account,
region, permissions and navigation are hypotheses, not established facts.
This follow-up re-inspects the existing native captures and current source;
it does not claim a new AWS-console test or implemented redesign.

Provisioning is now confirmed: the key is supplied separately, and instructions
for installing VS Code and opening this extension are already in place. The
extension's primary journey starts with a supplied key. Key acquisition and
AWS-console navigation are outside that journey.

The current help equates “I have no key” with “I can create a key”. Clicking
Open console only opens the manifest URL: the extension does not enter a help
state, provide a return checkpoint or detect success/permission failure.
The link already targets `#/api-keys`; a deeper link alone cannot remove AWS
sign-in or account permissions. The instructions remain in VS Code while the
user is in a browser. Expanding help also places a five-step list and a raw URL
above Continue. The original one-minute claim does not cover provisioning.

For this audience, rank the proposed changes as follows:

| Order | Proposal | Decision/click removed |
| --- | --- | --- |
| 1 | Display the key field immediately, with “Connect” as the sole primary action. | Removes Set up now and the welcome-to-field transition. |
| 2 | Omit key-creation help and the AWS link from first-run key entry. Say “Use the Bedrock key supplied with your setup instructions.” | Removes the branch that distracted the participant. |
| 3 | On verified success, show “You're connected” and “Open Claude”, using a verified native panel command or precise fallback instruction. | Replaces Done followed by finding Claude; avoids returning to a maintenance catalogue. |
| 4 | Put the full matrix, model IDs, policy editing and automation controls behind a secondary Settings and diagnostics entry. Keep material processing/cost information visible before Connect. | Removes irrelevant first-run choices without hiding consent. |
| 5 | Present one next action for each failure: replace rejected key, request administrator help for denied access, retry transient failure. | Removes diagnosis by trial and error. |

Proposed initial screen copy:

> **Connect Claude to Amazon Bedrock**
>
> Paste the Bedrock key supplied with your setup instructions.
>
> [Masked key field]
>
> [Connect]

Beside the submission action, show the effective source region/processing scope
and a short, accurate disclosure that the connection check makes small billable
requests and can initiate a model subscription if permissions allow. Do not
add a new region/model decision for novices; use supplied configuration and
make any material change understandable before it is applied. A public
extension cannot infer a company's approved region or support contact.

Once the key is available, the proposed path has two button activations:
Connect, then Open Claude. Field focus, paste and opening VS Code/the extension
are excluded from that count. Do not automatically submit or read the clipboard.
Opening Claude is still a proposal: the current allowed terminal-launch command
is not a verified way to open the intended Claude panel.

Keep the input focused on entry and preserve its contents during validation
and recoverable submission errors. Provide an accessible Show/Hide control.
Do not introduce another form, an “I have a key” choice, a pasted-key preview
or a confirmation dialog. Make format corrections inline; disable duplicate
submission while connecting and show a clear progress/result message.

If a user actually lacks the supplied key, direct them back to their setup
instructions or the person who supplied them. This is a support exception,
not a default competing call to action or an AWS key-creation tutorial. Keep
self-service documentation accessible to administrators outside first-run
entry. Do not invent a company support address.

On successful verification, the business-user surface should contain readiness
and the next usage action, not Test connection, model comparison or optional
upgrades. Preserve the full model engine and advanced controls behind Settings
and diagnostics. Do not label denied configured models as ready or prompt the
user to replace a valid key for an access denial. Resolve U1 before relying on
its authentication verdict for these simplified messages.

Measure independent supplied-key connection and reaching Claude, plus successful
recovery from common paste/key/network problems. Teach processing-policy
terminology and model versions only when a later task requires them.

## Moderator script — 1 October, approximately 30 minutes

Audience: first-time, non-technical business users setting up Bedrock. Use a
fresh isolated profile for each participant and disposable approved test data.
Give participants the normal installation/opening instructions and a supplied
test key. Prepare a supplied-key state and separate clean error fixtures.
Keep automatic checks off. Hide the scenario selector.
Do not ask users to provision real credentials or activate paid subscriptions
for this usability exercise.

Open with: “We are testing the tool. Please say what you think it is telling
you and what you would do next. You can stop any task.” Do not teach the panel's
terms before observing comprehension. Give assistance only after recording the
unaided outcome. These prompts describe goals, not control names.

| Time | Participant task | Moderator observes / success criterion |
| --- | --- | --- |
| 0–2 min | Establish prior VS Code/Claude experience. | Do not teach AWS terminology; record existing mental model. |
| 2–12 min | “Use these setup instructions and this supplied test key to get Claude ready.” | Finds the extension, pastes/submits, recognizes readiness. Record every extra click, hesitation and help/AWS detour. |
| 12–17 min | “Show me where you would start using Claude.” | Finds the intended Claude panel without a second setup, terminal detour or model-catalogue exploration. In the synthetic fixture, locating Claude is sufficient; don't score a live message attempt. |
| 17–20 min | “What did connecting do? Was anything unexpected?” | Understands saving/testing and material processing/cost implications without model IDs or policy vocabulary. Ask after the unaided attempt to avoid coaching it. |
| 20–27 min | Present a paste-format problem, then separate rejected-key, access-denied and connection-failure states: “What would you do next?” | Fixes the paste without losing work; finds key replacement, administrator help or retry unaided. Avoid U1-contaminated histories or record the known defect. |
| 27–30 min | “Where did you become unsure? What did you expect to happen next?” | Capture exact confusing text/screens and whether help restored progress. |

For each task record unaided success / assisted success / not completed,
elapsed time, first action, assistance, incorrect interpretation and a short
verbatim quote. Separate observable behavior from inferred emotion. Capture
which build and sidebar width were used. Do not aggregate a handful of sessions
into population-level performance claims.

Use model upgrades, geography editing, automatic checks and horizontal evidence
navigation as secondary tasks in a separate session. They are not prerequisites
for the business user's first successful setup. A separate screen-reader session
is required to resolve U10/U11.

Before expanding testing, verify U1 is fixed or fixtures avoid its history;
prioritize U3 if participants must approve real upgrades. Use tomorrow's results
to choose the smallest sidebar simplification that keeps exact model/scope
evidence available.
