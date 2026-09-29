# Release 1.0.0 — first full production release

Branch: `chore/release-1.0.0`
Authorization: Michael asked on 2026-09-29 to merge the Opus 5.5 manifest change
(#46), drop the Marketplace preview flag, and ship the first full production
release.

Acceptance criteria:

- `package.json` has no `preview` key, and a unit test enforces this.
- Version 1.0.0 (even minor, so the release workflow publishes it as stable).
- The bundled manifest carries the Opus 5.5 default from #46.
- Audit, lint, typecheck, tests, packaging, and the extension-host suite
  (stable and 1.98.2) pass, and PR CI is green before merging.
- After tagging, the registry API shows 1.0.0 with no `PreRelease` property, and
  the extension flags no longer include `preview`. The GitHub release is marked
  Latest.

Tasks:

- [x] Merge #46; the raw manifest serves revision `2026-09-29T00:00:00Z` with
  `global.anthropic.claude-opus-5-5`.
- [x] Remove `preview`, bump to 1.0.0, and replace the test that asserted
  `preview: true` with one that asserts it's absent. Document the flag in the
  runbook's verification step.
- [x] Local validation: audit clean; lint and typecheck pass; 1,986 tests pass
  with 2 skipped. The VSIX (10 files, 85.8 KB) has no preview flag, no
  pre-release property, no `extensionKind`, and bundles the Opus 5.5 default.
  The extension-host suite passes on stable and 1.98.2 (7 passing, 1 pending
  each).
- [x] PR CI green (all platforms, package, CodeQL 0 open alerts); squash-merged
  as `00c656b`; main CI passed.
- [x] Tagged `v1.0.0` on `00c656b`. Release run 36508982156 noted "1.0.0
  publishes as a stable release" and published to the Marketplace; Open VSX was
  skipped. About 5 minutes later the registry listed 1.0.0 with no `PreRelease`
  property and flags `validated, public` (was `validated, public, preview`). A
  screenshot of the live listing shows no Preview badge. The GitHub release
  v1.0.0 is marked Latest and carries the workflow's VSIX.

Accepted risk (carried from 0.2.6): the manual platform checks in
`docs/manual-verification.md` remain unticked.
