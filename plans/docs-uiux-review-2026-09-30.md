> Historical plan preserved on 2026-10-22. Open implementation tasks are proposals, not completed features or release prerequisites. See [the maintenance backlog](../docs/maintenance-backlog.md).

# Current-extension UI/UX review before user testing

Date: 2026-09-30.
Branch: `docs/uiux-review-2026-09-30`.
Product code baseline: `5377d85`; later commits add research documentation only.

## Outcome and acceptance criteria

Assess the packaged extension through actual VS Code mouse/keyboard interaction
and visual inspection, ahead of user testing on 1 October. Record reproducible
findings, screenshots, priorities and a moderator script. This is an assessment;
application changes are outside this turn's scope.

- [x] Inspect current UI, prior verification and isolated desktop harness.
- [x] Build/package the current source; record package identity and test environment.
- [x] Use a fresh isolated profile and synthetic AWS responses on `DISPLAY=:99`.
- [x] Visually inspect first-run setup, health, blocked/working upgrades, failures and recovery.
- [x] Check default/narrow/wide sidebar, keyboard navigation, theme and zoom behavior.
- [x] Complete independent design and source/accessibility assessments.
- [x] Write findings with evidence and recommendations for tomorrow's user testing.
- [x] Verify documentation/artifacts and commit a clean handoff.

## Boundaries

Use `xdotool` and `scrot` for the native desktop per Michael's computer-use
instructions. Keep all user data, extensions, workspace and Claude configuration
in a new temporary directory. Use only the harness's dummy token, never real
credentials or cloud API calls. Close only this review's VS Code window through
its UI. Preserve screenshots under ignored `out/` and report their locations.

## Review journeys

1. Fresh install: find the extension and understand/setup the credential.
2. Working configuration: identify readiness, selected models and next action.
3. Blocked new release: understand that the current setup still works and request access.
4. Verified upgrade: discover, preview, cancel and understand changes.
5. Denied/invalid/offline/throttled: interpret the error and recover.
6. Processing policy, evidence and automatic-check consent: understand control and cost.
7. Keyboard, panel widths, themes and zoom: complete the same actions accessibly.

## Verification limits

Synthetic responses establish UI behavior, not AWS entitlement/billing or actual
end-user comprehension. Record observed usability risks as hypotheses for user
testing. Screen-reader behavior and physical Windows/macOS desktops require
separate validation.

## Handoff

Report: `docs/uiux-review-2026-09-30.md`.
Local ignored artifacts: `out/uiux-review-2026-09-30/` (fresh VSIX, 26 product
screenshots, safe logs, evidence manifest, crops and independent assessments).
Owned native window closed through Alt+F4. No application code changed.

Five P1 findings: authentication rejection resurfaces after later success and
transient failure; matrix overwhelms sidebar; upgrade preview clips version;
recovery actions mismatch failures; refresh loses reading position. Six P2
findings cover onboarding disclosure/navigation, policy wording, configured
scope identity, Details destination and accessible state/announcements.

The report includes a 30-minute moderator script and separates observed
behavior from source-backed risks and untested user comprehension hypotheses.
Verification: all 25 report links resolve, 28 full screenshot hashes match
(26 product captures plus two diagnostics), safe log fields are whitelisted,
and the documentation diff passes `git diff --check`.

## Follow-up: non-technical business-user onboarding

Audience confirmed: first-time Bedrock users. Michael reported a participant
opening the missing-key help, following the AWS link and getting lost. The
specific AWS obstacle is unknown; do not invent a cause.

- [x] Re-read current setup/help/result handling and visually re-inspect native captures.
- [x] Record the shortest proposed flow and a bounded missing-key handoff.
- [x] Reprioritize the moderator script for business users; verify and commit docs.

Assessment/proposals only. No application implementation or new live AWS
verification is implied by this follow-up.
Provisioning confirmed: keys and installation/opening instructions are supplied
separately. The proposal now starts with direct key entry, omits AWS creation
from first-run help and tests supplied-key connection and the Claude handoff.
No support destination or browser observation is invented.
