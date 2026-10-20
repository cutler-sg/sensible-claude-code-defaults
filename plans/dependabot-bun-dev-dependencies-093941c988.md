# Production release 1.2.0 preparation

Branch: `dependabot/bun/dev-dependencies-093941c988`
PR: https://github.com/cutler-sg/sensible-claude-code-defaults/pull/53
Authorization: Michael requested unattended implementation of the repository
health follow-ups and preparation for the next production submission on
2026-10-20. Reuse the existing dependency PR; do not merge, tag, or publish.

## Acceptance criteria

- The exact committed lockfile passes `bun audit`, including transitive packages.
- New advisories are checked daily without requiring a source change.
- Required platform checks remain intact and cover stable VS Code and 1.98.2.
- Version 1.2.0 is ready for the stable channel (even minor), with complete
  release notes for model verification and failed-apply backup preservation.
- The release workflow fails on missing Marketplace configuration and publishes
  the packaged artifact that was validated, without silently skipping submission.
- Local validation, hosted CI, package inspection, and remaining environmental
  limits are recorded honestly. Physical desktop and live AWS checks are not
  inferred from synthetic tests.
- The final diff is reviewed, committed, pushed, and handed off in this PR.

## Tasks

- [x] Repair the vulnerable transitive dependency and verify the dependency group.
- [x] Add scheduled dependency auditing and strengthen release/platform checks.
- [x] Prepare 1.2.0 metadata, changelog, release notes, and submission instructions.
- [x] Validate lint, types, unit tests, stable/API-floor extension hosts, both
      packagers, and VSIX contents. Investigate and fix failures in scope.
- [ ] Review the complete diff and hosted checks; finish the PR and session summary.

## Decisions and evidence

- The current GitHub dependency inventory contains direct package ranges and
  Actions, but omits `source-map-js`. Zero dashboard alerts is not an audit pass.
  A standalone daily audit is the smallest reliable way to cover the committed
  transitive dependency graph without introducing a custom dependency exporter.
- The baseline audit reproduces GHSA-68fv-2mgg-jv7q in `source-map-js@1.2.1`
  through Vitest and coverage tooling. The first patched version is 1.2.2.
- Retain Dependabot's six dependency updates and repair its existing PR.
- Choose 1.2.0 for the new backwards-compatible model-verification feature:
  this repository publishes odd minor versions to the pre-release channel.
- Existing release records explicitly carry physical-platform checks as
  unverified. This preparation does not convert them into passes.
- Bun 1.4.3 updates the nested dependency without adding a runtime dependency;
  the older locally installed Bun 1.3.14 adds a direct dependency instead. The
  committed change is only the resolved `source-map-js` entry, and both versions
  report a clean audit afterwards. Frozen installation succeeds with Bun 1.4.3.
- Biome's schema now matches the Dependabot update to 2.5.15.
- The dependency-fix commit passed all existing hosted platform, package, and
  CodeQL checks in CI run 39431030694.
- Added a daily 02:43 UTC frozen-lockfile audit, stable/API-floor host runs
  within the existing required CI job names, and an explicit Ubuntu 26.04 leg.
  GitHub runner-images issue 14748 documents that label as generally available.
- actionlint 1.7.12 validates the workflows with a temporary runner-label
  configuration for Ubuntu 26.04; its bundled label catalogue predates that
  image. No workflow checks or security scans were suppressed.
- Executed the release workflow's channel resolver against stable, pre-release,
  mismatched-tag, suffix, and leading-zero fixtures. Valid numeric versions
  select the expected channel; invalid inputs and missing configuration fail.
- Local extension-host suites pass on VS Code 1.142.0 and 1.98.2: seven passing
  and one existing Windows-only skip each. Both use disposable profiles.
- Workflow commit `40bc894` passed the expanded hosted matrix in run
  [39431951437](https://github.com/cutler-sg/sensible-claude-code-defaults/actions/runs/39431951437):
  Windows, macOS, ubuntu-latest, explicit Ubuntu 26.04, and no-keyring Linux.
  Each executed both supported VS Code versions successfully. Dependency audit
  run 39431958987 and CodeQL run 39431958757 also passed.
- The existing local dependency directory retained an old nested VSCE 3.9.2
  despite a clean lockfile. A separate clean snapshot confirmed Open VSX
  resolves VSCE 4.0.0 and packages successfully with the committed override.
  The working checkout's old dependency directory was preserved under `/tmp`
  and replaced with a fresh frozen install; it now resolves VSCE 4.0.0 too.
- Repeated typechecking and all 2,088 unit tests against the clean installation;
  both passed, with the same two existing skips. Candidate manifest tests pass.
- Inspected stable, pre-release, and clean Open VSX packager archives: ten
  expected files, version 1.2.0, publisher `cutler-sg`, correct channel marker,
  bundled model catalogue and icons, no `preview` or `extensionKind`, and no
  source maps, dependencies, test fixtures, or plan files.
- The stable candidate is 105,877 bytes. The locally built Marketplace VSIX
  SHA-256 is `7328f5a7444a905eeb9e3ff34494b722f8474dae71f8b6e06cea7689adf64688`.
  ZIP timestamps can differ between builds; publish the exact Release artifact.
- Independent read-only review found no blocking defects. Verified the CLI
  handling of prepackaged artifacts, channel metadata, and environment tokens.

## Remaining submission boundaries

- Merge and production publication remain with Michael. No tag or registry
  submission has been created.
- Live AWS account entitlement/subscription behaviour, physical keychain
  prompts, corporate policies, remote-host placement, and screen-reader output
  remain unverified. See `docs/release-1.2.0.md` for the handoff.
- Open VSX namespace/token configuration is absent; Marketplace publication
  remains independent of it.
