# Plan — M0 + M1 (scaffold, CI, config read/merge/write engine)

Source of truth: `docs/PRD.md` §5 FR-1/FR-2, §6–§11, §14, §17. This plan covers **M0 and M1 only**.
Branch: `feat/m0-scaffold`.

## Verification against live state (2026-09-10)

Re-checked §17 before planning. Deltas from the PRD:

| PRD claim | Live state | Consequence |
|---|---|---|
| Claude Code extension floor `^1.98.0` | `anthropic.claude-code` 2.1.267 declares `^1.94.0` on both Marketplace and Open VSX | Keep our `engines.vscode` at `^1.98.0` for our own API needs, but the rationale in §7 is wrong; fix the comment |
| `AWS_REGION` required, not read from `~/.aws/config` | Since v2.1.172 Claude Code resolves `AWS_REGION` → `AWS_DEFAULT_REGION` → active AWS profile → `us-east-1` | Still write `AWS_REGION` (target users have no `~/.aws`); update §17 |
| (absent) | Claude Code now ships `/setup-bedrock`, a wizard that writes `env` (incl. `AWS_BEARER_TOKEN_BEDROCK`, region, model pins) to `~/.claude/settings.json`; startup model checks also offer to rewrite pinned model IDs into user settings | Claude Code is a **third writer of our managed keys**. The three-way merge handles it as drift, but drift on `env.ANTHROPIC_DEFAULT_*_MODEL` will be routine, not exceptional |
| Settings file format unspecified | Strict JSON: `//` comments and trailing commas are syntax errors | `JSON.parse` is correct; no JSONC parser needed. A file we can't parse is a file Claude Code can't parse either |
| `settings.json` should be `0600`, Claude Code "resets" it | Claude Code does not enforce a mode on `settings.json` (this box: `0664`); only `.credentials.json` is `0600` | FR-2.8 repair will fire after **every** Claude Code write. Repair silently; don't warn on each occurrence |
| Credential precedence (§17) | Confirmed verbatim in docs: cloud provider → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` → profiles → `/login` | D4 stands |
| Long-term Bedrock API keys for persistent setups | AWS docs: long-term keys are "for exploration only; for production use short-term keys". Long-term = an IAM user + service-specific credential with a creation-time expiry | FR-4.2 stance is still right for this audience, but README must own it; `cred.age` thresholds are weaker than the key's own expiry, which we cannot read |
| `CLAUDE_CONFIG_DIR` not mentioned | Relocates `settings.json`, plugins, credentials | FR-1.2 as written writes a file Claude Code may never read (see Q-F) |
| PAT retirement 2026-12-01, `vsce publish --azure-credential`, "All accessible organizations" | Confirmed | 12 weeks left; Entra from day one |
| Name availability | `sensible-claude-code-defaults` free on both registries; publisher/namespace `cutler`, `carrotly-ai`, `carrotly`, `cotdp` all free on both | Q4 is purely a choice, no collision |
| `enabledPlugins` values are booleans | Schema allows `boolean \| string[]` | We write `true`; merge must tolerate arrays |

§14: no decision found wrong. Challenges below are to things **outside** §14 (FR-1.2, FR-2.2 granularity, §4.2 snapshot home).

## Toolchain decisions (assumed unless overruled)

- `bun` for install/scripts (house default); `@vscode/vsce package --no-dependencies` since esbuild bundles everything, so vsce never needs `npm ls`.
- esbuild `target: node20`, `platform: node`, `format: cjs`, `external: ['vscode']`. VS Code 1.98 = Electron 34 = Node 20.18; "Node 22" in the PRD is the dev toolchain, not the runtime.
- `vitest` for unit + fs-integration tests. Everything under `src/config/` must not import `vscode` (inject `SnapshotStore`, `claudeDir`, `workspaceFolders`), so the merge engine tests run without an Electron host.
- `biome` for lint/format. `tsc --noEmit` strict.
- `@vscode/test-electron` + mocha only for the `extension.ts` smoke test (activation, command registered). Kept to one file.

## M0 — scaffold + CI (0.5 day)

- [x] Initial commit on `main`: existing `CLAUDE.md`, `docs/PRD.md`, `.gitignore`, this plan. (Needs consent: creates the remote + first push to `main`, Q-B.)
- [x] Branch `feat/m0-scaffold`.
- [x] `package.json` per §7: `publisher` placeholder until Q4; `engines.vscode ^1.98.0`; `extensionDependencies: ["anthropic.claude-code"]`; `activationEvents: ["onStartupFinished"]`; **no** `extensionKind`; `capabilities.untrustedWorkspaces.supported: true`; view container `sensibleDefaults` + view `sensibleDefaults.health`; one command `sensibleDefaults.runHealthCheck` (stub); the three `configuration` properties.
- [x] `tsconfig.json`, `esbuild.js`, `biome.json`, `vitest.config.ts`, `.vscodeignore`, `.vscode/launch.json` + `tasks.json`.
- [x] `src/extension.ts`: create output channel `Sensible Claude Code Defaults`, log activation, register the stub command. Nothing else.
- [x] `src/util/log.ts` (thin wrapper around `LogOutputChannel`; redaction boundary lands in M5 but the single choke point exists from day one).
- [x] `README.md` stub containing the D8 non-affiliation statement and the "files written / token location" section headings. `CHANGELOG.md`, `LICENSE` (MIT).
- [x] `media/icon.png` + `icon.svg`: non-orange, non-starburst placeholder that is *not* the default glyph (§5A). Final icon is M7.
- [x] `test/unit/packageJson.test.ts`: asserts no `extensionKind`, exact `extensionDependencies`, exact `activationEvents`, `main` path, `untrustedWorkspaces` — FR-1.3's explicit test.
- [x] `.github/workflows/ci.yml`: PR + push → bun install → biome → tsc → vitest → `vsce package --no-dependencies` → upload `.vsix` artifact.
- [x] `.github/workflows/release.yml`: on `v*` tag → same gates → `azure/login` (OIDC) → `vsce publish --azure-credential --pre-release` → `ovsx publish -p $OVSX_PAT`. Publish steps skipped when secrets absent so the workflow dry-runs before Q4.
- [ ] DoD: `bun run package` produces a `.vsix` that installs with `code --install-extension` and logs activation; CI green; release workflow dry-runs. Actual first publish waits on Q4 + Entra (Q-C). *(2026-09-10: `.vsix` builds clean — 10 files, no `node_modules`; lint, `tsc --noEmit`, and vitest green locally. Install-and-activate and the first CI run remain outstanding — nothing pushed yet.)*

## M1 — config engine (2 days)

Module layout (`src/config/`), all `vscode`-free:

- [x] `paths.ts` — `resolveClaudeDir(env)` (Q-F), `settingsPath`, `backupsDir`, `assertOutsideWorkspace(target, folders)` guard used by every write.
- [x] `managedKeys.ts` — `MANAGED_KEYS` const (FR-2.1), `getPath`/`setPath`/`deletePath` for dotted keys; `env` created when absent, other `env` entries untouched.
- [x] `reader.ts` — `readSettings(path)` → `{kind:'absent'} | {kind:'ok', data, style} | {kind:'malformed', raw, error}`. `style` = detected indent + trailing-newline so writes don't reformat the user's file. Root not a plain object, or `env` present but not an object → `malformed`.
- [x] `merge.ts` — pure `merge(current, snapshot, desired) → { next, changes, drift }`. One function, no I/O. Rows:

  | current vs snapshot | desired present | desired absent (removal, Q-G) |
  |---|---|---|
  | key absent | write | no-op |
  | equal to snapshot | overwrite | delete |
  | differs from snapshot | preserve + drift | preserve + drift |
  | snapshot absent, key present | preserve (drift only if ≠ desired) | preserve |
  | snapshot absent, key absent | write | no-op |

  Preserved keys are **not** adopted into the snapshot: the snapshot records only what we wrote, so a later manifest bump can never overwrite a user value we never owned. Ownership transfers only via explicit "reset to recommended" (M2).
  Equality: deep-equal; arrays order-insensitive for `permissions.deny` (Claude Code declares `uniqueItems`). Granularity for array/map keys: Q-E.
- [x] `snapshot.ts` — `SnapshotStore` interface; `FileSnapshotStore` (used by tests, and by the extension if Q-D goes my way) + `MementoSnapshotStore` adapter (10 lines, lives in `src/ui` side since it touches `vscode`).
- [x] `writer.ts` — `writeSettingsAtomic(path, data, style)`: `realpath` the target first (a symlinked `settings.json` from a dotfiles repo must not be replaced by a regular file), write temp in the *target's* directory with mode `0600`, `fsync`, `rename`, `chmod 0600` after rename (POSIX; Windows ACL deferred to M6, Q-K), temp removed on any failure. `ensureMode0600(path)`. `backupOnce(session)`, `listBackups`, `restoreBackup`, retain 10 (dir per Q-H).
- [x] `apply.ts` — two-phase orchestrator so FR-6.1's diff preview is structural, not bolted on: `plan(desired) → {changes, drift, next}` then `commit(plan)` → backup-once → write → snapshot save. `plan` on a malformed file returns `{blocked:'malformed'}` and `commit` refuses (FR-2.5).

Tests (write alongside, per CLAUDE.md):

- [x] `merge.test.ts` — every cell of the table above × three value shapes (scalar `env.*`, array `permissions.deny`, map `enabledPlugins`), plus: `enabledPlugins` value is `string[]` (schema allows it), `env` absent, `env` non-object, unmanaged keys and `$schema` untouched and order-preserved, snapshot has keys no longer in `MANAGED_KEYS`.
- [x] `reader.test.ts` — absent, ok, malformed (trailing comma, BOM, comment), root array, indent/newline detection.
- [x] `writer.test.ts` — atomicity (inject a failing rename, assert original intact and no `.tmp` left), mode `0600` after write, symlink target preserved, formatting preserved, backup rotation keeps exactly 10 newest, restore round-trip.
- [x] `paths.test.ts` — `CLAUDE_CONFIG_DIR` honoured/ignored per Q-F, `assertOutsideWorkspace` rejects a target inside any folder (§10.4 assertion #2; also rejects `.claude/settings.local.json` inside a workspace by construction).
- [x] `integration/apply.test.ts` under a temp dir — fresh install, hand-written existing config, malformed (no write, no backup), drifted, `/setup-bedrock`-style rewrite of a model pin between two applies, backup/restore round-trip.
- [x] DoD: `bun test` green (229 tests, 8 files); coverage of `src/config` 99% lines (every module 100%, `index.ts` barrel uncovered); no `vscode` import under `src/config`. Adversarial review (2026-09-10) found 17 issues, 5 critical (symlink bypass of the workspace guard, plan→commit TOCTOU, resetKeyPlan adopting user elements, prototype-chain reads in mergeMap, restore undone by next apply); all fixed with regression tests — 333 tests, 100% per module. Residual: TOCTOU is narrowed (stale-check in commit), not closed — a write between the check and the rename is still lost; a lock protocol Claude Code honours does not exist (see Q-J below).

## Open questions

Blocking M0 publish (not M0 scaffolding):
- ~~**Q-A (PRD Q4)** Publisher ID.~~ **RESOLVED 2026-09-10: `cutler-sg`**, verification domain **`cutler.sg`** (verified live: apex, DNS A 216.150.1.1, HTTPS 200, valid TLS, Vercel). `cutler-sg` confirmed free on both the VS Code Marketplace and Open VSX. Extension id is therefore `cutler-sg.sensible-claude-code-defaults`; listing homepage will be `https://cutler.sg/sensible-claude-code-defaults`. The six-month verified-publisher clock starts when the publisher account is created — do that now, before any code ships.
- **Q-B** GitHub remote: `cotdp` account, repo `cotdp/sensible-claude-code-defaults`? Consent for the one initial push to `main`.
- **Q-C** Is there an Entra tenant to federate `vsce publish --azure-credential` against? If not, PAT stopgap (Marketplace Manage, all orgs) is viable for 12 weeks only.

M1 design calls (assumption in bold; say "no" to flip):
- **Q-D** Snapshot home. PRD: `globalState`. Proposal: **`~/.claude/sensible-defaults/state.json`**. Reasons: (1) `globalState` is per-editor-install — VS Code stable, Insiders, Cursor, VSCodium each hold their own, so two editors on one machine would flag each other's applies as drift; (2) a `.vscode-server` wipe or reinstall loses the state while the file it describes survives; (3) it sits next to the file it describes, editor-agnostic, user-inspectable, and it is the Terraform state file the PRD's own analogy calls for. `SnapshotStore` interface keeps either choice a one-line swap.
- **Q-E** Ownership granularity for `permissions.deny`, `enabledPlugins`, `extraKnownMarketplaces`. Whole-value equality means a user adding one deny rule freezes the entire list forever (drift). Proposal: **element-level ownership** — snapshot records the entries we wrote; apply adds/updates/removes only those; user-added entries are preserved and are not drift. Scalars keep whole-value semantics.
- **Q-F** `CLAUDE_CONFIG_DIR`: **honour it when set in the extension-host environment**, else `homedir/.claude`. Otherwise a semi-technical user with it set gets a file Claude Code never reads and a health panel that lies.
- **Q-G** Removal semantics (missing from FR-2.2): needed for `clearToken` and for managed keys dropped from a future manifest. **Delete only if current equals snapshot; otherwise preserve + drift.**
- **Q-H** Backup dir: PRD says `~/.claude/.backups/`. Claude Code already owns `~/.claude/backups/`. Proposal: **`~/.claude/sensible-defaults/backups/`**, namespaced with the state file.
- **Q-I** Confirm "Node 22" = toolchain only; bundle targets **node20**.
- **Q-J** **bun** + `vsce --no-dependencies`; fall back to npm only if vsce fights it. *(resolved: bun works.)*
- **Q-J2** Concurrent-writer window: `commit` now refuses a stale plan, but nothing locks the file between the re-read and the rename. Claude Code has no lock protocol we can honour. Options: accept (the window is milliseconds and the pre-write backup is always taken first), or take an advisory `settings.json.lock` that only *we* respect (protects two VS Code windows, not Claude Code). **Assume accept for v1; revisit if M6 platform testing shows real collisions.**
- **Q-K** Windows ACL check/repair (FR-2.8) **deferred to M6**; M1 does POSIX `0600` only, with a no-op + info log on `win32`.
- **Q-L** PRD §16 Q2 ("report on vs install the plugin marketplace") is already answered by §4.2 ("Extension, once"). Writing `extraKnownMarketplaces` + `enabledPlugins` to the user file *is* installing. Suggest closing Q2 as "install, once, via the merge engine" or removing those two keys from `MANAGED_KEYS` for v1.

Non-blocking notes for later milestones:
- `/setup-bedrock` and the startup model-pin prompt change the drift UX for M2: drift on model IDs should read as "Claude Code updated this" and the manifest should track Claude Code's built-in Bedrock defaults rather than fight them.
- `cred.valid` (M3) using the Haiku ID will false-negative on accounts without Haiku enabled; Claude Code itself avoids Haiku for background tasks on Bedrock for this reason.
- README (M7) must state the AWS "long-term keys are for exploration" position and recommend the admin cap `iam:ServiceSpecificCredentialAgeDays`.
