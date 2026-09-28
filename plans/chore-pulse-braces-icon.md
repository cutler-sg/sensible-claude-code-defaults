# Release 0.2.5 — pulse-braces icon

Branch: `chore/pulse-braces-icon` (PR #42)
Authorization: Michael picked concept 5 (Pulse Braces) from the 2026-09-28 logo
workshop, then asked to merge and publish 0.2.5 to the Marketplace the same day.

Acceptance criteria:

- The listing icon and the activity-bar glyph both use the pulse-braces mark,
  legible at 32px (listing) and 24px (activity bar) on dark and light themes.
- The VSIX ships only the media files the manifest references.
- The package version and changelog identify 0.2.5. The changelog notes that
  0.2.4 was never published, so its fixes reach users in this release.
- Audit, lint, typecheck, tests, packaging, and the extension-host suite
  (stable and 1.98.2) pass, and PR CI is green before merging.
- Annotated tag `v0.2.5` is on the merged commit. The Marketplace publish step
  actually ran, the registry API reports 0.2.5, and a GitHub pre-release
  carries the VSIX.

Tasks:

- [x] Workshop eight concepts; render and compare them at 128/64/32/16px.
- [x] Replace `media/icon.png` and `media/icon-1024.png` (rendered from
  `media/icon-master.svg`) and `media/activity-icon.svg`.
- [x] Whitelist the referenced media in `.vscodeignore`; update README and PRD.
- [x] Bump to 0.2.5 and update the changelog.
- [x] Local validation: audit clean; lint and typecheck pass; 1,986 tests pass
  with 2 skipped; the VSIX has 10 files (85.5 KB), is publisher `cutler-sg`
  0.2.5, has no `extensionKind`, no maps, and no `node_modules`.
- [x] Extension-host suite: stable and 1.98.2 each pass 7 tests with 1 pending
  (a platform skip).
- [ ] PR CI green, then squash-merge.
- [ ] Tag, verify the release workflow and the Marketplace version, then
  create the GitHub pre-release.

Outstanding manual checks: view the new icon in a real VS Code window (the
Extensions list and the activity bar, on dark and light themes). The existing
platform manual checks in `docs/manual-verification.md` are unchanged.
