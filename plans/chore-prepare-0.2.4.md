# Prepare Marketplace release 0.2.4

Branch: `chore/prepare-0.2.4`
Authorization: Michael requested pulling main, updating dependencies, fixing and
merging maintenance work, and preparing the next VS Code Marketplace release.

## Acceptance criteria

- Dependabot uses Bun, updates its lockfile, and retains the VS Code 1.98 type cap.
- Development dependencies are current within their compatible ranges.
- macOS extension-host failures fail CI; CodeQL analyzes JavaScript/TypeScript.
- Current project and release documentation agrees with verified GitHub state.
- Version 0.2.4 passes lint, typecheck, unit tests, extension-host tests on stable
  and VS Code 1.98.2, packaging, and the platform CI matrix before merging.
- The PR is linked in T3 and merged; main is clean and ready for a release tag.
- Runtime behavior, model defaults, credential handling, and the pre-release
  publishing channel remain unchanged.

## Tasks

- [x] Pull main, verify repository/account, and inspect the PRD and latest CI.
- [ ] Fix dependency automation, refresh compatible dependencies, and validate.
- [ ] Require macOS integration tests and add CodeQL analysis.
- [ ] Refresh stale project guidance and prepare 0.2.4 metadata and release notes.
- [ ] Validate the VSIX, supported VS Code versions, and the complete local suite.
- [ ] Push and link the PR, verify CI, merge, and confirm clean main.

## External follow-ups

- [?] Publish to Open VSX (blocked: namespace/token setup is unfinished; the
  0.2.3 release skipped Open VSX because no publishing token was configured).
- [?] Complete physical Keychain/DPAPI, WSL2/Remote-SSH, and corporate-device
  verification (blocked: requires the hardware and interactive access documented
  in `docs/manual-verification.md` and `docs/corporate-device-retest.md`).

## Evidence and decisions

- Dependabot run 36161518016 failed with `misconfigured_tooling`: the npm
  ecosystem cannot update this repository's `bun.lock`; it requires `bun`.
- CI run 35682780191 passed all platforms; macOS passed 1,984 unit tests and
  seven extension-host tests. `.vscode-test.mjs` already isolates configuration
  without redirecting HOME, resolving the hang mentioned in the stale workflow.
- This is release preparation. Pushing `v0.2.4` would invoke Marketplace
  publishing; the prepared version is merged without triggering that workflow.
