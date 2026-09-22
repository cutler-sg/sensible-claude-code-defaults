# Install and upgrade recovery reliability

Branch: `fix/install-upgrade-recovery`

Scope: exercise first install and extension upgrade behavior against isolated
temporary Claude configuration fixtures. Cover valid pre-existing user settings,
partial-write remnants, permission failures, and stale backups. Repair only a
reproduced defect. Build on PR #34 without changing R11, R32, namespace
boundaries, model defaults, public APIs, schemas, dependencies, or the VS Code
1.98 support floor.

Acceptance criteria:

- First install preserves every user-owned setting and writes only missing
  managed defaults after an explicit apply.
- Upgrade preserves user drift, reads legacy backups, and safely advances the
  last-applied snapshot.
- Partial-write remnants cannot replace or corrupt the live configuration and
  have an actionable recovery path.
- Permission failures preserve the original settings, snapshot, and available
  backups without reporting a write that did not complete.
- Stale and unrelated backup files do not hide, overwrite, or evict valid
  recovery points; legacy timestamp-only backups remain usable.
- The highest-impact demonstrated gap has a regression test that fails before
  the fix and passes afterward, or the sprint records evidence that no defect
  exists.
- `engines.vscode` remains `^1.98.0`; `@types/vscode` remains `~1.98.0`.
- Typecheck, full tests, lint, VSIX packaging, VS Code 1.98 integration, and
  required CI pass.

Tasks:

- [x] Establish the post-PR #34 baseline and map existing scenario coverage.
- [x] Exercise the five acceptance scenarios with temporary fixtures and identify a real gap.
- [x] Add a focused failing regression test and confirm the root cause.
- [x] Implement the smallest repair and rerun the targeted scenarios.
- [x] Run all local compatibility and packaging gates.
- [ ] Commit, push, open/register the PR, and watch CI once with a bounded timeout.

Evidence:

- Reproduced: a snapshot-store `EACCES` after `settings.json` was replaced left
  managed values live without ownership, so the next manifest revision
  preserved the extension's own old value as user drift.
- Repaired: failed state writes restore the prior bytes (or first-install
  absence); post-rename failures keep a settings/snapshot pair aligned; a
  concurrent user edit is never rolled back.
- Existing coverage exercised pre-existing drift, atomic-write remnants,
  permission repair, legacy timestamp-only backups, stale/unrelated backup
  filtering, retention, and restore recovery.
- Passed locally: typecheck, Biome, 1,976 tests (2 skipped), VSIX packaging, and
  the extension-host suite on VS Code 1.98.2 (`7 passing`, `1 pending`).
