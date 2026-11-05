# Dependency audit repair and 1.2.1 publication

Michael delegated the fix, merge, and release in this thread on 6 November 2026.

## Context

Release 1.2.1 was prepared and dated 2026-10-23 but never tagged; the Marketplace
still serves 1.2.0. From 2026-10-24 the daily dependency audit failed on seven new
advisories (three high), all in development and publishing tools. Dependabot PR #58
also failed CI because Biome 2.6 began formatting Markdown and the configuration
schema was still pinned to 2.5.15.

## Acceptance criteria

- `bun audit` reports no vulnerabilities on a frozen install with the Bun version CI uses (1.4.4).
- Lint, typecheck, unit tests, and stable and 1.98.2 extension-host tests pass locally and on all CI platforms.
- The packaged VSIX contains the same files as the 1.2.1 candidate, with a byte-identical product bundle.
- PR #58's updates are included, and #58 is closed as superseded.
- 1.2.1 is re-dated, tagged from the green merged commit, published to the stable Marketplace channel, and verified through the registry API, with its VSIX attached to a GitHub release.

## Tasks

- [x] Reproduce the audit and PR #58 failures; trace each advisory to its dependency path.
- [x] Apply in-range updates (`follow-redirects` removed by ovsx 1.3, `qs` 6.17.1, `serialize-javascript` 7.1.4, `@azure/msal-node` 7.2.0 through vsce 4.1 and `@azure/identity` 4.14.1).
- [x] Override `glob` to ^14.0.2 and `minimatch` to ^11.0.1. No 10.x/13.x backport exists. Consumers (`mocha`, `@vscode/test-cli`, vsce) use only `glob()`, `glob.hasMagic()`, and `minimatch()`, none of which the majors removed.
- [x] Take PR #58's bumps at their latest versions; migrate `biome.json` to 2.6.5.
- [x] Disable Biome's Markdown formatter. It rewrote fenced code blocks nested in list items into broken inline code (`docs/manual-verification.md`), so applying it would have corrupted the documentation. Markdown linting stays enabled.
- [x] Local gate (Bun 1.4.4): frozen install, audit clean, lint, typecheck, 2,094 unit tests passed (two existing skips), extension hosts 1.145.0 and 1.98.2 seven passing (one existing Windows-only skip) each.
- [x] VSIX: same ten files as the `main` build; `dist/extension.js`, the defaults manifest, README, and VSIX manifest are byte-identical (compared before the changelog was re-dated). Only dev-dependency metadata in the bundled `package.json` differs.
- [x] Re-date the 1.2.1 changelog and record the dependency repair.
- [ ] Open the PR; confirm every CI entry passes; merge.
- [ ] Verify CI on the merged commit; tag `v1.2.1`; watch the Release workflow.
- [ ] Verify the Marketplace version and channel through the registry API; attach the VSIX to a GitHub release.
- [ ] Update the release handoff and maintenance backlog.

## Remaining limitations

Manual checks for live AWS entitlement and billing, physical Keychain/DPAPI,
WSL/Remote-SSH placement, and screen readers remain in `docs/manual-verification.md`.
The product bundle is unchanged since the desktop-verified 1.2.1 candidate, so that
evidence still applies.
