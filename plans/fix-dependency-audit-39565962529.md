# Dependency audit repair and desktop verification

## Acceptance criteria

- Reproduce the committed dependency audit failure before updating dependencies.
- Resolve every current advisory with the smallest compatible graph change.
- Preserve VS Code `^1.98.0`, `@types/vscode ~1.98.0`, runtime behaviour, CI safeguards, and release configuration.
- Pass frozen installation, audit, lint, types, unit tests, stable and 1.98.2 extension-host tests, and package inspection.
- Exercise the packaged extension using actual desktop input and screenshots in isolated synthetic profiles; inspect extension logs for new errors.
- Commit and push all changes, open one reviewable PR, and stop before merge or release.

## Tasks

- [x] Reproduce advisories and identify their patched releases and dependency paths.
- [x] Apply the minimal dependency fix; verify the repaired graph and package compatibility.
- [ ] Run automated validation and inspect both VSIX packagers.
- [ ] Perform computer-use regression checks and record evidence and limitations.
- [ ] Review the full diff, commit, push, open the PR, and verify the handoff state.

## Scope and evidence

Michael explicitly authorized dependency remediation on 22 October 2026 after the bounded investigation established that run 39565962529 fails independently of application code. The prior cross-version fixture reproduced the same five advisories using Bun 1.3.14 and exact CI Bun 1.4.3+c6da4a4d3. This task may repair the dependency graph; no release is authorized until verification and review are complete.

Desktop fixture root: `/tmp/scd-dependency-qa-20261022-Vgo9tF`. Follow `test/desktop/README.md`, use only its synthetic credential and AWS interceptor, and keep real profiles and credentials untouched. Desktop control uses `xdotool` and screenshots on the existing Xvfb display, as in the documented repository workflow.

- GitHub's advisory records identify `follow-redirects@1.16.1` and `vite@7.3.7` as the first patched releases for the five reported advisories. They satisfy the existing Open VSX and Vitest dependency ranges. Only their resolved versions and integrity hashes change.
- The focused `verify-patched-graph.cjs` fixture fails against the baseline, then passes against the repaired lockfile. It checks every matching dependency path and asserts byte-identical `package.json`, including the VS Code floor. Frozen installation succeeds and installs exactly two changed packages.
- A disposable Bun resolver selected Vite 8 despite a targeted patch request. That graph was discarded. The retained Vite 7 patch uses published integrity metadata, has unchanged dependency metadata verified against its package archive, and passes frozen installation.
- Lint and typechecking pass; all 2,088 unit tests pass with two existing skips. Audit requests are currently waiting on the npm advisory endpoint; a separate bounded HTTP request also timed out. This is recorded as pending verification, not an audit pass.
