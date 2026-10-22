# Release 1.2.1: dependency repair, credential recovery, and verification

## Acceptance criteria

- Reproduce the committed dependency audit failure before updating dependencies.
- Resolve every current advisory with the smallest compatible graph change.
- Preserve VS Code `^1.98.0`, `@types/vscode ~1.98.0`, CI safeguards, and release configuration.
- Keep recovered credential evidence newer than old rejections through transient failures, with bounded freshness and context isolation; never infer current model access from historical authentication.
- Preserve local UX and Azure research in the repository and track deferred proposals explicitly.
- Prepare stable 1.2.1 with an accurate changelog, package evidence, and release handoff.
- Pass frozen installation, audit, lint, types, unit tests, stable and 1.98.2 extension-host tests, and package inspection.
- Exercise the packaged extension using actual desktop input and screenshots in isolated synthetic profiles; inspect extension logs for new errors.
- Commit and push all changes, open one reviewable PR, and stop before merge or release.

## Tasks

- [x] Reproduce advisories and identify their patched releases and dependency paths.
- [x] Apply the minimal dependency fix; verify the repaired graph and package compatibility.
- [x] Preserve the unmerged research and UX findings; record release scope and remaining backlog (2026-10-22).
- [x] Add a failing credential-recovery regression, implement the smallest fix, and verify temporal/context boundaries (2026-10-22).
- [x] Trace duplicate dispatch ownership and document the exact external blocker in `docs/automation-handoff.md` (2026-10-22).
- [?] Repair the external Hadron dispatcher (blocked: separate repository/service; no supported project-scoped control).
- [x] Prepare 1.2.1 metadata and release notes.
- [x] Run automated validation and inspect both VSIX packagers.
- [x] Perform computer-use regression checks and record evidence and limitations.
- [x] Review the full diff and prepare the final commit and existing PR #54 handoff.
- [x] Verify the final push, clean working tree, PR registration, and hosted checks.

## Scope and evidence

Michael authorized the cleanup and fixes in this thread on 22 October 2026.
Reuse PR #54 for the entire task. The patch includes dependency maintenance and
the confirmed credential-status defect; the broader UX redesign and Azure
implementation remain proposals. Merge and publication remain with Michael.
Local documentation branches must remain recoverable until their contents are
committed and pushed. Routine stale-branch deletion is deferred because it is
destructive and does not affect release readiness.

The earlier desktop run was interrupted after an upgrade assertion failed while
its screenshot captured an unrelated browser window. Its partial screenshots
are not a completed end-to-end pass. The replacement run must use an isolated
display and verify window identity and fixture state after each transition.
Hosted checks on `6e6f404` subsequently passed, and a fresh isolated audit of
that exact lockfile passed on 22 October with no advisories.

Michael explicitly authorized dependency remediation on 22 October 2026 after the bounded investigation established that run 39565962529 fails independently of application code. The prior cross-version fixture reproduced the same five advisories using Bun 1.3.14 and exact CI Bun 1.4.3+c6da4a4d3. This task may repair the dependency graph; no release is authorized until verification and review are complete.

The completed replacement desktop fixture is `/tmp/scd121-G4qmj5`, using a
dedicated Xvfb display `:109` with window-identity checks. It supersedes the
interrupted `/tmp/scd-dependency-qa-20261022-Vgo9tF` run. See
`docs/verification-1.2.1/README.md` for committed screenshots, byte-level
assertions, request counts, isolation details, and limitations.

- GitHub's advisory records identify `follow-redirects@1.16.1` and `vite@7.3.7` as the first patched releases for the five reported advisories. They satisfy the existing Open VSX and Vitest dependency ranges. Only their resolved versions and integrity hashes change.
- The initial focused `verify-patched-graph.cjs` fixture failed against the baseline, then passed against the repaired lockfile. It checked every matching dependency path and the then-unchanged `package.json`, including the VS Code floor. The later release preparation changes only its version to 1.2.1. Frozen installation succeeds and installs exactly two changed packages.
- A disposable Bun resolver selected Vite 8 despite a targeted patch request. That graph was discarded. The retained Vite 7 patch uses published integrity metadata, has unchanged dependency metadata verified against its package archive, and passes frozen installation.
- The initial audit endpoint timeouts were resolved. Fresh `bun audit` runs pass with no vulnerabilities; the final validation below supersedes the earlier pending audit and 2,088-test baseline.

## Credential recovery repair

Six new regression cases fail against the original implementation and pass
after the fix. They cover rejected → recovered → offline/throttled, persistence
across restart, processing-policy exclusion, 24-hour expiry, a newer rejection,
and isolation by credential generation, source region, and configuration path.
Authentication uses the newest success/rejection in its persisted context,
with a 24-hour lifetime; alternative model availability may still be cached for
seven days. Current failed model checks remain inconclusive and cannot drive an
upgrade from historical successful authentication.

Independent review reproduced an additional metadata-change edge: invalidating
model metadata erased historical success during the next transient request.
The follow-up preserves historical same-target authentication independently of
metadata validity. Its regression fails before the follow-up and passes after.
The controller test now asserts valid historical authentication alongside warning
health and `models-unavailable`, rather than conflating those two facts.
All 2,094 unit tests pass with two existing skips; lint and typechecking pass.
Independent review found no remaining issues, including timestamp ties, future
evidence, cross-window recovery, and alternative-model cache lifetimes.

## Final validation and handoff

The 1.2.1 candidate passes frozen installation, audit, lint, typechecking, all
2,094 unit tests (two existing skips), and Linux extension-host suites on
VS Code 1.142.0 and 1.98.2 (seven passing and one Windows-only skip each).
Both packager paths produce the expected ten archive entries with equivalent
contents. The desktop-tested product bundle matches the final package.
The fixture window and dedicated display processes exited normally.

See `docs/release-1.2.1.md` for release notes and exact publication steps.
The changelog remains Unreleased until publication is scheduled, as required
by `docs/releasing.md`. Hosted checks must pass on the final pushed commit;
review their current state in PR #54. Hadron's external repair remains a
separate explicit blocker, not an implemented fix.

Candidate `4032471` passed all nine hosted check entries: the five platform
jobs, packaging, dependency audit, and both CodeQL entries. The
[CI run](https://github.com/cutler-sg/sensible-claude-code-defaults/actions/runs/39796996950)
completed successfully on that exact SHA. Every entry in its downloaded VSIX
matches the locally validated package. The subsequent completion commit only
records this evidence; PR Checks remains authoritative for its own result.
