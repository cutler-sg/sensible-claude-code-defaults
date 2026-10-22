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
- [ ] Add a failing credential-recovery regression, implement the smallest fix, and verify temporal/context boundaries.
- [ ] Trace duplicate dispatch ownership and apply supported project-scoped controls or document the exact external blocker.
- [ ] Prepare 1.2.1 metadata and release notes.
- [ ] Run automated validation and inspect both VSIX packagers.
- [ ] Perform computer-use regression checks and record evidence and limitations.
- [ ] Review the full diff, commit, push, open the PR, and verify the handoff state.

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

Desktop fixture root: `/tmp/scd-dependency-qa-20261022-Vgo9tF`. Follow `test/desktop/README.md`, use only its synthetic credential and AWS interceptor, and keep real profiles and credentials untouched. Desktop control uses `xdotool` and screenshots on the existing Xvfb display, as in the documented repository workflow.

- GitHub's advisory records identify `follow-redirects@1.16.1` and `vite@7.3.7` as the first patched releases for the five reported advisories. They satisfy the existing Open VSX and Vitest dependency ranges. Only their resolved versions and integrity hashes change.
- The focused `verify-patched-graph.cjs` fixture fails against the baseline, then passes against the repaired lockfile. It checks every matching dependency path and asserts byte-identical `package.json`, including the VS Code floor. Frozen installation succeeds and installs exactly two changed packages.
- A disposable Bun resolver selected Vite 8 despite a targeted patch request. That graph was discarded. The retained Vite 7 patch uses published integrity metadata, has unchanged dependency metadata verified against its package archive, and passes frozen installation.
- Lint and typechecking pass; all 2,088 unit tests pass with two existing skips. Audit requests are currently waiting on the npm advisory endpoint; a separate bounded HTTP request also timed out. This is recorded as pending verification, not an audit pass.
