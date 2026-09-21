# Platform install/repair compatibility

**Branch**: `fix/platform-install-compatibility`
**Base**: `origin/main` at merged PR #34; open PRs #35/#36 only change config
apply/restore transactions and are intentionally not part of this branch.
**Status**: Verification
**Last updated**: 2026-09-21

## Scope

Exercise install detection, Windows terminal repair/launch, permission repair,
and configuration-path handling with spaces, quotes, Unicode, and native path
semantics. Use isolated fixtures only. Fix only a demonstrated compatibility
defect; otherwise record evidence without code churn.

## Acceptance criteria

- Windows command discovery and bundled-executable launch handle safe absolute
  paths containing spaces and Unicode without shell parsing or quoting loss.
- macOS/Linux CLI detection and POSIX permission repair handle spaces and
  Unicode in isolated configuration paths.
- Windows permission repair and configuration resolution use Windows path
  semantics without touching real user profiles.
- Unsupported host/runtime cases explain the unavailable repair accurately and
  do not claim success, mutate configuration, or suggest a platform-inapplicable
  action.
- Existing Windows, macOS, Linux/no-keyring, WSL/remote-resolution, and
  workspace-boundary coverage is not duplicated.
- Any uncovered defect is reproduced by a focused failing regression before
  the smallest fix is applied.
- `engines.vscode` remains `^1.98.0`; `@types/vscode` remains `~1.98.0`; no
  dependency, public API/schema, namespace, R11/R32, or model-default changes.
- Typecheck, lint, full tests, VSIX packaging, VS Code 1.98 integration, and
  required CI pass.

## Tasks

- [x] Map existing platform, quoting, install, repair, and unsupported-runtime coverage.
- [x] Run the clean baseline and exercise uncovered cases with platform fixtures.
- [x] Reproduce the highest-impact real defect, or document precise no-defect evidence.
- [x] Add focused regression coverage and implement the minimal fix when warranted.
- [x] Run compatibility, typecheck, lint, full-test, packaging, and integration gates.
- [ ] Commit, push, open/register the focused PR, and watch CI once.

## Execution evidence

- Clean `origin/main` baseline: typecheck, lint, package, and 1,971 tests passed
  (2 skipped).
- Existing coverage already verifies shell-free Windows launch with spaces,
  apostrophes and Japanese characters; localised Windows ACL fixtures; a native
  Windows Unicode filename; POSIX/Windows path flavours; and host-local
  WSL/Remote-SSH resolution. These cases were not duplicated.
- Reproduced: Windows terminal inspection resolved the candidate executable but
  compared it only with the unresolved workspace spelling. An 8.3/junction
  workspace alias therefore allowed a bundled executable inside a Unicode,
  space-containing workspace to be treated as trusted.
- Reproduced: `Disable Claude Terminal Repair` returned early on a non-Windows
  or remote host, leaving an existing application preference enabled while
  claiming only that the repair was unavailable.
- Fixed: executable inspection now compares against literal and resolved
  workspace roots; unresolved roots fail closed through the existing blocked
  status. Unsupported hosts may clear the preference but never mutate a
  terminal environment, and the message states both facts.
- The integration profile now uses `/tmp/scd claude 日本語 O'Brien-*`, so
  every host leg exercises configuration reads and permission repair without
  shell quoting assumptions. Linux passed on VS Code 1.138.0 and explicitly on
  the supported floor, VS Code 1.98.2 (`7 passing`, `1 pending` each).
- Final local gates: targeted platform tests 44/44, full suite 1,973 passed
  with 2 skipped, typecheck, Biome, VSIX packaging, and `git diff --check`.
- Not locally executed: native Windows ACL/process behavior, macOS Keychain,
  WSL2 host placement, and Remote-SSH host placement. Windows/macOS/Linux CI
  remains the automated platform evidence; hardware-only cases remain in
  `docs/manual-verification.md`.
