# Recovery interruption reliability

Branch: `fix/recovery-interruption`

Stack: this branch is based on `fix/install-upgrade-recovery` / PR #35 because
its transactional settings-and-snapshot recovery is directly exercised here.
The focused PR for this item targets that branch; it must not duplicate PR #35.

Scope: use isolated temporary Claude configuration fixtures to exercise
cancellation, interrupted repair, rollback, repeat execution, and concurrent
windows after PR #34. Preserve user edits and every valid recovery point. Do
not change R11, R32, namespaces, model defaults, public APIs/schemas,
dependencies, or the VS Code 1.98 support floor.

Acceptance criteria:

- Cancellation before confirmation leaves settings, state, backups, and
  credential storage unchanged.
- An interrupted repair never reports completion and preserves the last valid
  live configuration, ownership snapshot, and backup recovery points.
- Rollback/restore remains undoable, forgets managed ownership only after the
  replacement succeeds, and preserves user edits made during the operation.
- Repeating apply, repair, restore, and cancellation is idempotent or creates
  only the documented per-session/forced recovery points.
- Concurrent windows cannot overwrite, hide, or prune one another's recovery
  data, including same-millisecond backups introduced by PR #34.
- Any newly demonstrated defect has a regression test that fails before the
  fix and passes afterward; otherwise the sprint records precise evidence that
  existing behavior is correct.
- `engines.vscode` remains `^1.98.0`; `@types/vscode` remains `~1.98.0`.
- Typecheck, full tests, lint, VSIX packaging, VS Code 1.98 integration, and
  required CI pass.

Tasks:

- [x] Map existing cancellation, repair, restore, repeat, and concurrency coverage.
- [x] Exercise uncovered interruption boundaries with isolated fixtures.
- [x] Reproduce the highest-impact real gap with a failing regression.
- [x] Implement at most two materially different repairs for a blocker.
- [x] Run all local compatibility and packaging gates.
- [ ] Commit, push, open/register the stacked PR, and watch CI once.

Evidence:

- Reproduced: an ownership-state failure after replacing settings left the
  restored file paired with stale ownership, allowing a later apply to undo
  the rollback; post-rename permission failures had the same split.
- Reproduced: at ten backups, the mandatory pre-restore backup pruned the
  selected oldest recovery point before it could be read.
- Repaired: interrupted restore either finishes as a consistent settings/state
  pair or restores the byte-exact pre-operation file. Concurrent user edits
  win over compensation, and failures remain visible to callers.
- Repaired: restore defers retention and preserves the selected backup so a
  concurrent window cannot lose a recovery point it already chose. PR #34's
  UUID names keep same-millisecond undo points distinct.
- Existing command coverage verifies dismissed apply/reset/region/restore
  prompts perform no write, and permission-repair failures remain reported
  without blanking the health run.
- Passed locally: typecheck, Biome, 1,982 tests (2 skipped), VSIX packaging,
  and the extension-host suite on VS Code 1.98.2 (`7 passing`, `1 pending`).
