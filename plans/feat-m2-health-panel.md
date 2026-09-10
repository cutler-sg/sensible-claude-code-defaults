# Plan — M2 (health runner + TreeView + core checks)

Source of truth: `docs/PRD.md` FR-1.4/1.6, FR-2.5, FR-2.7, FR-2.8, FR-5, FR-6 (subset), §13. Depends on M1 (`src/config/*`).
Branch: `feat/m2-health-panel` (from `feat/m0-scaffold` once merged, else stacked).
Status: **draft, written while M1 was in flight — re-read M1's final APIs before starting.**

## Scope

M2 = the panel a non-technical user sees, driven by checks that need only M1 + the VS Code API.
Checks that need M3 (credential) or M4 (manifest) are registered in the catalogue but return
`skipped` with a plain-language "not set up yet" label, so the tree shape is final in M2 and
later milestones only fill in check bodies.

In: `install.*`, `config.exists/parses/perms/bedrock/region/models/drift`, `plugins.*` (against
the **bundled** manifest, M4 swaps in the fetched one), commands `runHealthCheck`,
`applyDefaults` (with diff preview), `openSettings`, `restoreBackup`, `resetKey`, file watcher,
badge, notification discipline.
Out: `config.stale` (M4), all `cred.*` (M3), `selectRegion` (needs manifest regions — M4, but
the QuickPick is trivial; pull in if M4 lands first), `copyDiagnostics` (M5).

## Architecture

```
src/health/
  types.ts        CheckId, Level ('pass'|'warning'|'error'|'info'|'skipped'), CheckResult,
                  CheckContext, Check = { id, group, run(ctx) → CheckResult }
  runner.ts       runAll(checks, ctx) → HealthReport; sequential, each check try/caught →
                  error-level result "This check crashed" (never throws); previous report kept
                  for transition detection (FR-5.5)
  context.ts      builds CheckContext once per run: ReadResult, snapshot, desired (bundled
                  manifest), plan() output (drift), extension presence/version, cli version
                  (5s timeout, cached per window), platform, claudeDir
  checks/         one file per check id; pure fn of ctx, no vscode imports except
                  `vscode.extensions` which context.ts wraps → checks stay unit-testable
  labels.ts       every user-facing string in one file (FR-5.3); test asserts none contain
                  an env var name or the literal "JSON"
src/ui/
  treeProvider.ts TreeDataProvider<GroupNode|CheckNode>; codicons: pass→check, warning→warning,
                  error→error, info→info, skipped→circle-outline; contextValue per remediation
                  kind so `view/item/context` menus bind fix commands; badge = count(error)
  commands.ts     registers FR-6 subset; applyDefaults = plan() → QuickPick "Apply N changes"
                  listing `key: before → after` (secrets via redact) → commit()
  watcher.ts      fs.watch on settingsPath (+ parent dir for create/delete), 1000 ms debounce,
                  → runner. Ignore events caused by our own write (compare mtime/inode we just
                  wrote; simplest: a `suppressUntil` timestamp set by commit()).
  notify.ts       FR-5.5 gate: fire only on (a) first run & config absent, (b) previous report
                  had 0 errors and this one has >0. State in globalState (per-window is fine).
src/extension.ts  wiring only: build env (resolveClaudeDir, workspaceFolders, FileSnapshotStore),
                  register provider/commands/watcher, kick off first run *after* activation
                  returns (setImmediate) so activation stays <100 ms (§13).
```

## Tasks

- [ ] `src/health/types.ts` + `labels.ts` + `runner.ts` with tests: runner never throws, crashed
      check → error result, report counts, transition detection (healthy→fail true only once).
- [ ] `context.ts`: `detectClaudeCode()` three signals (FR-1.4) — extension via injected
      `getExtension`, CLI via `execFile('claude', ['--version'], {timeout: 5000})` (signal 2
      failing while 1 passes is **not** an error — info only), settings via `readSettings`.
      Version floor (FR-1.6) via a tiny semver compare (no dependency): `install.version` is
      warning below `minimumClaudeCodeVersion` from the bundled manifest.
- [ ] Checks, each with a unit test on a fake ctx:
  - `install.extension` error + fix `workbench.extensions.installExtension` with `anthropic.claude-code`
  - `install.version` warning + fix `extension.open`
  - `install.cli` info only
  - `config.exists` warning + fix applyDefaults
  - `config.parses` error + fixes: openSettings / restoreBackup (FR-2.5; **never** auto-write)
  - `config.perms` warning; `ensureMode0600` repair runs **silently** inside the check on POSIX
    (Claude Code rewrites the file as 0664 on every `/model` etc. — see M0 plan verification
    table); result is `pass` with detail "repaired" so the user never sees churn; win32 → skipped
  - `config.bedrock` error unless `env.CLAUDE_CODE_USE_BEDROCK` is `"1"`/`"true"`
  - `config.region` error unless set and in manifest `regions`; fix → selectRegion if present else applyDefaults
  - `config.models` warning if any of the three `ANTHROPIC_DEFAULT_*_MODEL` absent or ≠ manifest
    **and not drifted** (a drifted pin is the user's/Claude Code's choice → reported by `config.drift`, not here)
  - `config.drift` info, one child node per drifted key with `resetKey` fix; label for model pins:
    "Claude Code changed the <Opus/Sonnet/Haiku> model" (it does this via `/setup-bedrock` and the
    startup pin prompt), for others "You changed …"
  - `plugins.marketplace` / `plugins.enabled` info, fix applyDefaults (§4.2 "install once") — or
    dropped entirely if plan Q-L resolves to removing those keys from MANAGED_KEYS
  - `cred.*`, `config.stale` → `skipped` placeholders with honest labels
- [ ] `ui/treeProvider.ts`: groups always present in fixed order; leaf `tooltip` = detail +
      remediation hint; `accessibilityInformation.label` = "<group>: <label>, <level>";
      `viewsWelcome` contribution for the empty/first-run state with an "Apply recommended
      configuration" button link; badge = error count (FR-5.4)
- [ ] `ui/commands.ts`: `runHealthCheck`, `applyDefaults` (diff QuickPick → commit → rerun),
      `openSettings`, `restoreBackup` (QuickPick newest-first with relative time; confirm modal
      naming the backup; then rerun), `resetKey(key)` — implemented as `plan({[key]: desired[key]})`
      with the snapshot **pre-seeded to current** for that key so merge treats it as ours → this is
      the only path that transfers ownership (M1 plan note). `package.json` contributes all of
      them + `view/title` (refresh, apply) + `view/item/context` (fix, reset) menus.
- [ ] `ui/watcher.ts` with debounce + self-write suppression; test the debounce with fake timers.
- [ ] `ui/notify.ts` FR-5.5 with tests on the gate logic (pure function over prev/next report).
- [ ] `extension.ts` wiring; activation timing assertion in the integration smoke test
      (`@vscode/test-electron`, one file): activates, view registers, `runHealthCheck` executes
      against a temp `CLAUDE_CONFIG_DIR`, no notification on second run.
- [ ] README: fill "What this extension writes" (now true) — list of managed keys in plain words.
- [ ] DoD: all checks unit-tested on fake ctx; `labels.ts` lint test; `bun test` green; VSIX
      installs; manual walkthrough on this box against a temp `CLAUDE_CONFIG_DIR`: fresh → apply →
      edit a model pin by hand → drift shows → reset → pass.

## Decisions to confirm before starting (assumption in bold)

- **Q-M** `cred.*` placeholders shown as `skipped` in M2 (tree shape stable) rather than hidden.
- **Q-N** `config.perms` repairs silently and reports `pass`, never warns, on POSIX. PRD says
  warning + "Repair" button; with Claude Code resetting the mode on every write, a button is
  a treadmill. Warning only if the repair itself fails (EPERM).
- **Q-O** Fix actions are `view/item/context` inline buttons (codicon `wrench`) rather than a
  child "Fix this" node — one click, no expand.
- **Q-P** `applyDefaults` diff preview is a multi-step QuickPick (summary → confirm), not an
  untitled-document diff; the diff document is nicer for the semi-technical user but the panel
  user is the design target (§3). Revisit in M7.
- **Q-Q** Watcher uses `fs.watch` on the parent dir (handles atomic-rename writers like
  Claude Code itself and us) not `vscode.workspace.createFileSystemWatcher` (that API is
  workspace-scoped and unreliable outside open folders).
- **Q-R** First-run toast (FR-5.5a) fires only when `config.exists` fails **and** the Claude
  Code extension is installed — no point prompting to configure a tool that isn't there.

## Notes carried from M0/M1 planning

- Drift on model pins is routine (Claude Code writes them) — wording and the `config.models`
  interaction above are the response.
- Q-L (marketplace keys) changes the `Plugins` group: if the keys leave MANAGED_KEYS the group
  becomes report-only (read `extraKnownMarketplaces`/`enabledPlugins`, never write).
