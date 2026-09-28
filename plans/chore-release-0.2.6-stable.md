# Release 0.2.6 — first stable release

Branch: `chore/release-0.2.6-stable`
Authorization: Michael asked on 2026-09-28 to move from the pre-release channel to
a stable release, numbered 0.2.6.

Acceptance criteria:

- The Release workflow derives the channel from the tag: an even minor
  publishes stable, an odd minor publishes with `--pre-release`. It fails when
  the tag and `package.json` disagree. Both the Marketplace and Open VSX steps
  use the derived flag.
- The runbook, PRD, CLAUDE.md, corporate retest doc, and CHANGELOG describe the
  new channel rule.
- Audit, lint, typecheck, tests, and packaging pass, and PR CI is green before
  merging.
- Tag `v0.2.6` publishes a **stable** Marketplace version. The registry API
  shows 0.2.6 without the `PreRelease` property. The GitHub release is not
  marked as a pre-release.

Tasks:

- [x] Add the *Resolve release channel* step. Tested locally: v0.2.6 gives no
  flag; odd minor v0.3.0 gives `--pre-release`; a tag that doesn't match
  `package.json` fails.
- [x] Update the docs and bump to 0.2.6.
- [x] Local validation: audit clean; lint and typecheck pass; 1,986 tests pass
  with 2 skipped; the 0.2.6 VSIX (10 files, 85.7 KB) has no `PreRelease`
  property. No extension code changed, so the extension-host suite was not
  rerun (it passed for 0.2.5 on the same code).
- [ ] PR CI green, then squash-merge.
- [ ] Tag, then verify the stable channel on the Marketplace and create the
  GitHub release.

Accepted risk: the 36 manual platform checks in `docs/manual-verification.md`
are still unticked. MC chose to go stable on CI and desktop evidence.
