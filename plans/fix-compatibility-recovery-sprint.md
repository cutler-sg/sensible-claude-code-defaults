# Compatibility and recovery reliability sprint

Branch: `fix/compatibility-recovery-sprint`

Scope: exercise existing install, upgrade, configuration-repair, and failure-recovery
paths in isolated fixtures/profiles; repair only demonstrated defects. Preserve the
VS Code `^1.98.0` support floor and `@types/vscode ~1.98.0` constraint. Do not
change dependencies, release configuration, public APIs, or user credentials.

Acceptance criteria:

- A high-impact reliability or compatibility gap is reproduced against the current
  implementation before production code changes, or the sprint documents precise
  evidence that no defect was found.
- The selected defect has a focused regression test that fails before the fix and
  passes afterward.
- Installation, upgrade, configuration repair, and recovery checks use isolated
  temporary directories/profiles and never inspect or modify real user configuration.
- Existing user-owned configuration and recovery artefacts remain preserved; writes
  retain the repository's atomicity, workspace-boundary, and `0600` guarantees.
- `engines.vscode` remains `^1.98.0` and `@types/vscode` remains `~1.98.0`.
- Typecheck, unit/integration tests, lint, VSIX packaging, and required CI pass.
- A focused PR is opened and registered with T3; releases remain manual.

Tasks:

- [x] Establish the post-`origin/main` baseline and map existing lifecycle/recovery coverage. (completed: 2026-09-21)
- [x] Reproduce the highest-impact real gap in an isolated fixture and add a failing regression test. (completed: 2026-09-21)
- [x] Implement the smallest root-cause repair and verify the targeted scenario. (completed: 2026-09-21)
- [x] Exercise fresh install, upgrade, configuration repair, and failure recovery fixtures. (completed: 2026-09-21)
- [x] Run typecheck, full tests, lint, packaging, and compatibility-constraint checks. (completed: 2026-09-21)
- [ ] Commit, push, open/register the PR, and watch required CI once with a bounded timeout.

Evidence:

- Reproduced timestamp-collision data loss: two backups at the same instant returned
  one path and the second replaced the first.
- Reproduced missing Windows protection: snapshot writes made zero calls into the
  injected ACL adapter despite `state.json` containing the bearer token.
- Targeted persistence tests: 108 passed, 1 platform skip.
- Isolated lifecycle integration: 50 passed (fresh install, manifest upgrade,
  configuration repair, malformed/write-failure recovery, backup/restore).
- Full Vitest suite: 1,971 passed, 2 platform skips.
- Extension-host integration: 7 passed, 1 Windows-only pending on both VS Code
  1.98.2 and current stable 1.138.0, using temporary Claude/user/workspace paths.
- `bun run typecheck`, `bun run lint`, and `bun run package` passed.
- `engines.vscode` remains `^1.98.0`; `@types/vscode` remains `~1.98.0`
  resolving to 1.98.0. Neither `package.json` nor `bun.lock` changed.
