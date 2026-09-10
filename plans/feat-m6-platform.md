# Plan — M6 (platform matrix: Windows ACLs, WSL, Remote-SSH, headless Linux, macOS)

Source of truth: `docs/PRD.md` §10.3 (the platform matrix), FR-1.2, FR-1.3, FR-2.8, §15 ("WSL homedir mismatch").
Depends on M3 (the keychain is the most platform-divergent surface) and M5 (the leak scan walks the filesystem).
Branch: `feat/m6-platform`. Status: **draft, written 2026-09-11.**

## Why this is the long pole

Every deferral so far has landed here. Plan Q-K deferred Windows ACL repair; Q-X deferred the headless-Linux keychain decision to "report, don't degrade" without ever running on a headless Linux; the WSL home-directory question has an explicit test in FR-1.3 that only asserts the *manifest*, not the behaviour. This milestone is where the assumptions get executed rather than reasoned about.

The honest constraint: **this box is Linux with a desktop session.** macOS, Windows, and Remote-SSH cannot be executed here. So M6 splits in two — what can be automated in CI, and what needs MC on a real machine. Pretending otherwise would produce a green tick that means nothing.

## Part A — what CI can actually run

- [ ] **Widen the CI matrix** to `ubuntu-latest`, `macos-latest`, `windows-latest` for `lint`/`typecheck`/`test`. The unit suite is filesystem-heavy and platform-parameterised (`assertOutsideWorkspace`, `ensureMode0600`, path resolution), so most of the risk is reachable without an extension host.
- [ ] **Extension-host smoke on all three** — `xvfb-run` on Linux, bare on macOS and Windows. `@vscode/test-cli` supports all three; the Windows leg is the one most likely to surface a path or ACL bug.
- [ ] **Headless Linux leg**: a job with no desktop session and no `libsecret` installed, asserting the extension activates, the panel renders, and `cred.present` reports the keychain error rather than throwing (Q-X made this a promise; nothing has tested it).
- [ ] Fix whatever the matrix surfaces. Expect: path separators in the workspace guard, `fs.watch` semantics on Windows (the `null` filename case is already handled), `chmod` no-ops, and the 8.3 short-name gap the M1 review noted.

## Part B — Windows ACL repair (closing plan Q-K)

`ensureMode0600` returns `{kind:'unsupported'}` on win32, and `config.perms` reports `skipped`. On Windows the file inherits the user-profile ACL, which is *usually* already user-only — but "usually" is not a security property, and the token lives in that file.

- [ ] Implement `ensureWindowsAcl(file)`: read the DACL via `icacls`, detect a grant to `Everyone`, `Users`, `Authenticated Users` or `BUILTIN\Users`, and repair by removing inheritance and granting the current user only. Shell out rather than take a native dependency — no native modules (the stack rule), and `icacls` ships with Windows.
- [ ] Parse `icacls` output defensively: it is localised. Match on SIDs (`S-1-1-0` Everyone, `S-1-5-32-545` Users, `S-1-5-11` Authenticated Users) via `icacls /q /c` output, not on English names.
- [ ] `config.perms` on win32 becomes a real check: pass when the ACL is user-only, warning + repair when not, `skipped` only when `icacls` is unavailable.
- [ ] Tests: parser unit tests against captured `icacls` output (English, German, Japanese samples committed as fixtures); the repair path itself only runs in the Windows CI leg.

## Part C — the WSL / Remote-SSH question, executed

FR-1.3 says the extension must not declare `extensionKind: ["ui"]` so the host runs on the same side as the Claude Code binary. There is a test asserting the manifest, and that is the whole of the coverage.

- [ ] Add an integration assertion that `resolveClaudeDir()` under the extension host resolves to the *remote* home when `vscode.env.remoteName` is set, and that the resolved path is the one the health check actually reads. This is checkable in the Linux CI leg by faking `remoteName`.
- [ ] Document in the README that in WSL and Remote-SSH the configuration written is the remote one, because that is where Claude Code runs — the single most likely support question from a semi-technical user.

## Part D — what MC must do by hand (escalate, do not fake)

A short checklist, to be added to the PR body rather than ticked by an agent:
- [ ] macOS (Apple Silicon): keychain prompt appears once and the token round-trips; `0600` after a Claude Code write; panel renders.
- [ ] Windows 11 native: `%USERPROFILE%` resolution, DPAPI-backed SecretStorage, ACL repair actually tightens a loosened file, path separators in the drift labels.
- [ ] Windows + WSL2: the extension host runs remote; writes land in the WSL home, not `C:\Users\…`.
- [ ] Remote-SSH: same-side resolution.
- [ ] Linux with libsecret absent: the degraded message is accurate and actionable.

## What the matrix actually found

Two real defects in the workspace guard, both live on `main` before this
milestone, neither reachable from a Linux desktop. Recorded here because the
point of Part A was to execute the assumptions rather than reason about them,
and this is what execution returned.

- **Symlinked workspace root (found by the macOS leg, reproduces on Linux).**
  Every call site resolved the write *target* through `realpath` and re-checked
  it, but compared it against workspace roots exactly as VS Code reported them.
  macOS hands out `/var/...` for directories that really live at
  `/private/var/...`, so a target inside the workspace compared clean against
  the root's unresolved form and the write was allowed. Fixed by resolving both
  sides in `assertOutsideWorkspace`. Nothing macOS-specific about it: the same
  hole reproduces on Linux with a symlinked workspace directory, which is how it
  was confirmed before the fix landed.

- **8.3 short names (found by the Windows leg).** Node has two realpath
  implementations that disagree: the async `fs.realpath` used by the write path
  asks Windows and gets the long name, while `realpathSync` resolves symlinks
  but leaves a short name untouched. The guard therefore compared
  `C:\Users\runneradmin\...` against `C:\Users\RUNNER~1\...`, found no
  overlap, and permitted a write into the workspace — confirmed by a probe that
  showed the file landing there. Fixed with `realpathSync.native`. Short names
  are enabled by default on the system volume of most Windows installs, which is
  exactly where `%USERPROFILE%` and `~/.claude` live.

Both now have regression tests that fail when the fix is reverted. The Windows
one is `runIf(win32)`, because an 8.3 name cannot be manufactured elsewhere.

Beyond those, the matrix surfaced a run of test-portability faults that were
hiding platform behaviour rather than testing it — untyped symlinks (a file link
to a directory resolves to nothing on Windows, so the guard tests passed there
for want of a working link), POSIX path literals, a `chmod`-based EACCES setup
that is a no-op on Windows, and hardcoded `/` separators.

## Decisions taken

- **Q-AF** Shell out to `icacls` rather than adding a native ACL module. Native modules must match VS Code's Electron ABI (the stack rule forbids them), and a spawn of a built-in Windows tool has no ABI.
- **Q-AG** Match ACL entries by SID, never by display name. `icacls` is localised and an English-only parser silently passes on a German machine — a false all-clear on the file holding the token.
- **Q-AH** Part D stays manual and is stated as manual in the PR. An agent cannot verify a keychain prompt on hardware it does not have, and claiming otherwise is the failure mode MC reads session summaries to catch.
