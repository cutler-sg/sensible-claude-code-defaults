# Settings recovery sprint — phase 1 and merge repair

Branch: `fix/quota-20261004-sensible`
Base: `origin/main` at `09ed463488410214230b1375d79a50f6199ed835` (released 1.0.0).

## Acceptance criteria

- Fix one reproduced install/upgrade or recovery defect using temporary profiles only.
- Preserve user settings and recovery points through failed applies and same-window retries.
- Retain VS Code `^1.98.0` and `@types/vscode ~1.98.0`; keep UI, Bedrock, credentials, and production profiles outside scope.
- Demonstrate a failing regression before the repair, run full checks, validate the VSIX and the VS Code 1.98 extension host, and ship one linked PR.

## Tasks

- [x] Read repository instructions, PRD, September recovery evidence, default branch, and open PRs.
- [x] Reproduce a failed apply consuming the session backup allowance before a same-window retry.
- [x] Repair the demonstrated failure and verify focused regressions.
- [x] Run lint, typecheck, full tests, dependency audit, package, and VS Code 1.98 extension-host checks.
- [x] Validate the current stable VS Code extension host.
- [x] Resolve the dependency audit blocker under Michael's follow-up authorization.
- [x] Commit, push, open/link the draft PR, inspect CI failure, and verify clean state.

## Evidence

- The checkout is clean and matches the fetched default branch. Prior PRs #34–#37 already cover atomic snapshots, UUID backups, compensation after write failures, restore retention, and platform paths.
- Open PR #49 (`5377d85949de7cbdb9bce0db98c61009e0cc2f95`) changes model availability and UI but no `src/config` engine files. PR #50 (`fca057167c7331f2ecb0f908597fccea5bba4c32`) archives only an older manifest-version test. No engine overlap.
- Hypothesis: `backupOnce()` sets `session.backedUp` before any settings write; neither a pre-rename write failure nor successful settings compensation releases that allowance. User settings authored before a same-window retry are then replaced without an undo point.
- Confirmed on released code: both new regression cases fail at `expect(retry.backup).toBeDefined()`. The retry writes successfully and preserves custom keys in the live document, but has no undo point for the exact pre-retry settings.
- Repair: retain the prior session allowance on a failed settings write or a successful compensation. Keep existing backups and retain the allowance when the failed operation's settings/snapshot became durable. No locking or ownership-format changes.
- Baseline: 1,986 tests passed, two existing skips. Repaired: all 63 apply integration tests and all 1,988 tests pass, with the same two skips; lint, typecheck, and whitespace checks pass.
- `bun run package` succeeds; the VSIX contains the repaired engine and retains version 1.0.0, VS Code `^1.98.0`, and `@types/vscode ~1.98.0`. It excludes tests and development dependencies.
- `DISPLAY=:99 bun run test:integration --code-version 1.98.2`: seven passing, one existing Windows-only pending case. The harness uses temporary user-data, workspace, and `CLAUDE_CONFIG_DIR` paths plus checkout-local extension installations; no real profiles or credentials were accessed.
- `bun audit` fails with eight findings (five high, three moderate) in existing `braces`, `brace-expansion`, and `fast-uri` dependencies. `braces@3.0.3` is both affected and the latest published version; the path is `ovsx -> @vscode/vsce@3 -> secretlint -> globby -> fast-glob -> micromatch -> braces`. The direct `@vscode/vsce@4` upgrade has already shipped. Changing the legacy publisher's major dependency or removing tooling would exceed this demonstrated settings fix. No audit exclusion, dependency churn, or scan weakening was applied. Ship a draft PR and report this lane blocked.
- Current stable VS Code 1.140.0 also passes: seven passing, one existing Windows-only pending case.
- Fix commit: [`dd6e1ef`](https://github.com/cutler-sg/sensible-claude-code-defaults/commit/dd6e1ef26405ca193b7aef032447e352e24b006a). Draft PR: [#51](https://github.com/cutler-sg/sensible-claude-code-defaults/pull/51), registered with this T3 thread. The bounded fail-fast CI watch confirms the [package audit failure](https://github.com/cutler-sg/sensible-claude-code-defaults/actions/runs/37138336878/job/111247369874); its logs show the same eight findings. Hosted Linux and no-keyring tests passed at that checkpoint; Windows/macOS and CodeQL were still pending, so full hosted validation is not claimed.
- Lane outcome: **blocked** on the required dependency audit. No next phase or additional workers were dispatched. Branch and PR remain available for the coordinator's handoff.

## Authorized merge repair — 2026-10-04

Michael explicitly requested: "fix all the issues blocking the merge, and merge when done".
This extends the earlier settings-only scope to the required tooling updates and
authorizes merging PR #51 after every required check passes.

- [x] Inspect current checks, reviews, branch protection, dependency graph, and the current default branch.
- [x] Merge the newly landed PR #49 (`origin/main` at `f9430b6`) into this same branch without rewriting history.
- [x] Override Open VSX's VSCE 3 dependency with the already installed VSCE 4 package; confirm its public `createVSIX` options are unchanged.
- [x] Patch brace-expansion from 5.0.9 to 5.0.12 and from 2.1.4 to 2.1.7 within the consumers' existing major ranges.

The override removes only the obsolete VSCE 3 dependency subtree, including
vulnerable `braces`/`fast-uri`; VSCE 4 retains its secretlint core and recommended
rules. The lockfile retains minimatch 9's brace-expansion 2.x and balanced-match
1.x dependencies rather than forcing the incompatible 5.x API on that runner.
No production dependency was added. `bun install --frozen-lockfile` and
`bun audit` pass. Validation and the final merge outcome are recorded in the PR
body, hosted checks, and GitHub merge state; no gate is bypassed.

Final local validation after incorporating PR #49: lint, typecheck, frozen
installation, audit, packaging, and all 2,088 tests pass (two existing skips).
VS Code 1.98.2 and 1.140.0 each pass seven extension-host tests with the existing
Windows-only case pending on Linux. Open VSX resolves the same VSCE 4 module as
the direct CLI; `createVSIX` packages an isolated fixture, while its default
scanner rejects a synthetic private-key fixture. Only the two brace-expansion
versions changed among retained packages; the obsolete VSCE subtree accounts
for the lockfile deletions. Required hosted checks and CodeQL gate the explicitly
authorized merge.
