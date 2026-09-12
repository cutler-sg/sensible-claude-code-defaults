# Sensible Claude Code Defaults — Product & Engineering Requirements

**Status:** Draft v1.2 (amended 2026-09-10 after M0/M1 verification — see §19)
**Owner:** MC
**Display name:** `Sensible Claude Code Defaults`
**Package name:** `sensible-claude-code-defaults`
**Extension ID:** `<publisher>.sensible-claude-code-defaults` (publisher TBD — see §16 Q4)
**Repository:** `$HOME/workspaces/cutler-sg/sensible-claude-code-defaults`
**Target registries:** Visual Studio Marketplace + Open VSX
**Last updated:** 2026-09-10

---

## 0A. Getting started (for the agent picking this up)

The repository is at `$HOME/workspaces/cutler-sg/sensible-claude-code-defaults`. This document lives at `docs/PRD.md` and is the source of truth; `CLAUDE.md` at the repo root is the short working agreement that points here.

Start with **M0 and M1 only** (§11). Do not scaffold the whole tree up front — build the merge engine and its tests before any UI exists, because §5 FR-2 is where the data-loss risk lives and everything else depends on it being right.

Before writing code, read §14 (closed decisions) and §17 (verified external facts). Several plausible-looking approaches — a private extension gallery, `apiKeyHelper` for the Bedrock token, writing to `settings.local.json` — have already been investigated and ruled out for concrete reasons. Re-deriving them wastes a cycle each.

## 0. How to read this document

This is written to be handed to a coding agent or engineer with no prior context. Sections 1–4 give the *why* and the architecture. Sections 5–10 are the buildable specification. Sections 11–15 cover build, release, and test. Section 16 lists decisions already made and explicitly closed, so they are not relitigated mid-build. Section 17 is a reference appendix of externally-verified facts about Claude Code — treat these as inputs, not assumptions, and re-verify against current Claude Code docs before relying on any of them in code.

---

## 1. Problem statement

Non-technical and semi-technical users are being onboarded onto Claude Code via the VS Code extension. Claude Code on AWS Bedrock requires hand-editing a JSON configuration file (`~/.claude/settings.json`) with a set of environment variables, Bedrock model identifiers, and a credential. This is:

- **Error-prone.** A malformed `settings.json` breaks Claude Code entirely with poor diagnostics.
- **Opaque.** Users cannot tell whether their configuration is correct, stale, or partially applied.
- **Unstable.** Bedrock model IDs and Anthropic's recommended defaults change faster than users will re-read a setup document.
- **Undistributable.** There is no MDM, Intune, Jamf, or endpoint-management channel available. VS Code is the only deployment surface that reaches these users.

There is currently no way to push a configuration change to this population, and no way to diagnose a broken configuration remotely.

## 2. Goals and non-goals

### 2.1 Goals

| # | Goal | Success measure |
|---|---|---|
| G1 | A user can go from "VS Code installed" to "Claude Code working on Bedrock" without editing JSON | First-run flow completes in < 3 minutes, zero file editing |
| G2 | Configuration defaults can be updated centrally without the user doing anything | New defaults reach an active user within one VS Code session of publish, without a Marketplace release |
| G3 | A user can see, in plain language, whether their Claude Code setup is healthy | Health panel shows pass/warn/fail per check with a one-click remediation where one exists |
| G4 | Credential entry and rotation are a guided flow, never a file edit | Token entered via input box; rotation is a single command |
| G5 | Support is tractable for users on machines the maintainer cannot see | "Copy diagnostics" produces a redacted, pasteable report |
| G6 | The extension never destroys a user's own configuration | Any user-modified managed key is preserved and surfaced as drift, never silently overwritten |

### 2.2 Non-goals

- **Not** an MDM or policy enforcement tool. It advises and remediates; it does not lock users out or prevent overrides.
- **Not** a Claude Code replacement or wrapper. It configures; it does not proxy, intercept, or run inference.
- **Not** a credential broker. It does not mint, exchange, or refresh AWS credentials. Users bring a Bedrock API key.
- **Not** a private/internal distribution channel. This ships publicly. Anything organisation-specific stays out of the extension (see §16, D1).
- **Not** responsible for installing Claude Code itself beyond declaring the dependency.

### 2.3 Explicitly out of scope for v1

- SSO / `awsAuthRefresh` / IAM credential flows (see §18, Q3 — likely v2)
- Vertex AI, Azure Foundry, or direct Anthropic API configuration
- Multi-profile switching (dev/prod Bedrock accounts)
- Team/workspace-level configuration sync
- Telemetry of any kind

## 3. Users

**Primary: the onboarded non-technical user.** Uses the Claude Code *panel* in VS Code, not the terminal. Does not know what a JSON file is. Will not read a README. Will not notice a status bar item. Responds to: a thing in the sidebar with a red dot, and a button that says "Fix this".

**Secondary: the semi-technical user.** Uses the integrated terminal, may have their own `~/.claude/settings.json` already, may be on WSL. Will be annoyed by anything that overwrites their work. Needs drift to be visible and reversible.

**Tertiary: the maintainer (MC).** Needs to push new defaults without a release, and to triage support requests from users on unknown machines.

Design consequence: **the panel user is the design target for UX; the terminal user is the design target for safety.**

## 4. Architecture

Three components with deliberately different update cadences. The core principle: **the slowest-to-update component holds the least-changing information.**

```
┌────────────────────────────────────────────────────────────┐
│ 1. VS Code Extension  (Marketplace + Open VSX)             │
│    cadence: weeks                                          │
│    holds: logic, UI, merge engine, credential handling,    │
│           bundled fallback defaults                        │
└───────────────┬────────────────────────────────────────────┘
                │ fetches at activation
                ▼
┌────────────────────────────────────────────────────────────┐
│ 2. Defaults Manifest  (static JSON, GitHub raw or S3)      │
│    cadence: days                                           │
│    holds: Bedrock model IDs, regions, env defaults,        │
│           recommended permission rules, marketplace refs   │
└────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────┐
│ 3. Claude Code Plugin Marketplace  (public git repo)       │
│    cadence: days                                           │
│    holds: MCP servers, hooks, slash commands, skills       │
│    delivered via extraKnownMarketplaces + enabledPlugins   │
└────────────────────────────────────────────────────────────┘
                │ all three converge on
                ▼
        ~/.claude/settings.json   (+ OS keychain for the token)
```

### 4.1 Why the split

Publishing to the Marketplace has a floor of a few minutes for the scan plus a **client-side auto-update hold of roughly two hours** for non-trusted publishers. Anything that needs to change on a same-day basis must not live in the VSIX. Model IDs change; the code that writes them does not.

Component 3 exists because MCP servers, hooks, and permission rules are exactly what Claude Code's native plugin system carries. Shipping them as a plugin means the extension writes two keys once and never touches them again, and that whole surface updates on a `git push`.

### 4.2 What the extension writes, and where

| Artefact | Location | Written by | Update path |
|---|---|---|---|
| `env` block (Bedrock enablement, region, model IDs) | `~/.claude/settings.json` | Extension | Defaults manifest |
| `permissions.allow` / `.deny` (baseline) | `~/.claude/settings.json` | Extension | Defaults manifest |
| `extraKnownMarketplaces`, `enabledPlugins` | `~/.claude/settings.json` | Extension, once | Plugin repo |
| Bedrock bearer token | OS keychain (canonical) + `env` block (derived) | Extension | User, via command |
| Last-applied snapshot | `<claudeDir>/sensible-defaults/state.json` (mode 0600) | Extension | Every apply |
| MCP servers, hooks, commands, skills | Claude Code plugin | Plugin repo | `git push` |

---

## 5. Functional requirements

### FR-1 — Activation and environment discovery

**FR-1.1** Activate on `onStartupFinished`. Never `*`. Activation must not block the window.

**FR-1.2** On activation, resolve the Claude Code home directory as `$CLAUDE_CONFIG_DIR` when that variable is set in the extension host's environment (trimmed, `~/` expanded, made absolute), otherwise `path.join(os.homedir(), '.claude')`. `os.homedir()` correctly resolves `%USERPROFILE%` on Windows and `$HOME` on macOS/Linux — do not branch on platform. *(Amended 2026-09-10: Claude Code honours `CLAUDE_CONFIG_DIR` for settings, plugins, and credentials; ignoring it would write a file Claude Code never reads.)*

**FR-1.3** The extension **must not** declare `"extensionKind": ["ui"]`. In WSL, Remote-SSH, and devcontainer scenarios the extension host must run on the same side as the Claude Code binary. Default (workspace) placement is correct. Add an explicit test for this (§14).

**FR-1.4** Detect Claude Code presence via three independent signals, in order:
1. `vscode.extensions.getExtension('anthropic.claude-code')` — is the extension installed?
2. `child_process` exec of `claude --version` with a 5s timeout — is the CLI on PATH?
3. Existence and parseability of `~/.claude/settings.json`.

Record all three; they feed separate health checks. Signal 2 failing while 1 succeeds is normal and must **not** be reported as an error — the extension bundles its own binary and does not always place one on PATH.

**FR-1.5** Declare `"extensionDependencies": ["anthropic.claude-code"]`. Note this accepts bare IDs only — **no version ranges are supported**. Version floors must be asserted at runtime (FR-1.6).

**FR-1.6** After the dependency activates, read `ext.packageJSON.version` and compare against a configurable `minimumClaudeCodeVersion`. Below the floor → warn-level health check, not a hard failure.

### FR-2 — Configuration read, merge, and write

This is the highest-risk area. A bug here destroys user data.

**FR-2.1 — Ownership model.** The extension owns a declared set of *keys*, never the file. Define:

```ts
const MANAGED_KEYS = [
  'env.CLAUDE_CODE_USE_BEDROCK',
  'env.AWS_REGION',
  'env.ANTHROPIC_DEFAULT_OPUS_MODEL',
  'env.ANTHROPIC_DEFAULT_SONNET_MODEL',
  'env.ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'env.AWS_BEARER_TOKEN_BEDROCK',
  'permissions.deny',
  'extraKnownMarketplaces',
  'enabledPlugins',
] as const;
```

Everything outside this list is read, preserved byte-for-byte in ordering where possible, and written back untouched.

**FR-2.2 — Three-way merge.** Maintain a *last-applied snapshot* in `<claudeDir>/sensible-defaults/state.json` recording the exact value the extension last wrote for each managed key *(amended 2026-09-10 from `globalState`: a file next to the settings it describes is editor-agnostic — VS Code stable, Insiders, and Cursor on one machine would otherwise flag each other's applies as drift — and survives a `.vscode-server` wipe)*. For the list/map keys (`permissions.deny`, `extraKnownMarketplaces`, `enabledPlugins`) ownership is per element: the snapshot records the elements the extension wrote, user-added elements are preserved and are not drift. A managed key absent from the manifest is removed only if its current value equals the snapshot; otherwise it is preserved and reported as drift. On each apply, per key:

| Current value vs. last-applied | Meaning | Action |
|---|---|---|
| Key absent | Never configured | Write the new default |
| Equal | Ours, untouched | Overwrite with new default |
| Differs | User or CLI changed it | **Preserve.** Record as drift. Surface in health panel with "reset to recommended" |
| Last-applied absent (first run / new key) | Unknown provenance | Preserve if present, write if absent. Never overwrite blind |

Rationale: without knowing what was last applied, drift is indistinguishable from user intent. This is the Terraform state problem; the snapshot is the state file.

**FR-2.3 — Atomic writes.** Never write in place.

```ts
const tmp = path.join(dir, `.settings.json.${process.pid}.${Date.now()}.tmp`);
await fs.writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
await fs.rename(tmp, target);
```

A truncated `settings.json` does not degrade Claude Code — it breaks it, for a user who cannot recover manually.

**FR-2.4 — Backups.** Before the first write of a session (one VS Code window), copy the existing `settings.json` byte-for-byte to `<claudeDir>/sensible-defaults/backups/settings.<ISO8601>.json` at mode `0600`. Retain the 10 most recent. Expose "Restore previous configuration" as a command. Restoring drops the last-applied snapshot so the next apply cannot silently re-apply what the user rolled back. *(Amended 2026-09-10: Claude Code already owns `~/.claude/backups/`; the extension's state lives under its own `sensible-defaults/` directory alongside `state.json`.)*

**FR-2.5 — Malformed input.** If `settings.json` exists but does not parse: do **not** overwrite. Raise a fail-level health check offering (a) open the file, (b) restore from backup, (c) reset to defaults with a confirmation dialog that names the backup path.

**FR-2.6 — Never write project-scoped files.** The extension must not write to `.claude/settings.json` or `.claude/settings.local.json` in any workspace. `settings.local.json` is project-scoped, meaning a per-repo copy of a per-device credential — strictly worse than the user file. Add a lint/test asserting no write path resolves inside a workspace folder.

**FR-2.7 — File watching.** Watch `~/.claude/settings.json` and re-run health checks on change, debounced 1000ms. Claude Code rewrites this file itself (e.g. `/model` writes back a `model` key), so the panel must reflect reality without a reload.

**FR-2.8 — Permissions re-assertion.** On every health check, verify `settings.json` is mode `0600` on POSIX and re-apply if not. On Windows, verify the ACL does not grant read to `Everyone`/`Users` via inheritance and repair if so. This is a real failure mode: Claude Code rewrites the file and permissions can be reset.

### FR-3 — Defaults manifest

**FR-3.1** Bundle a copy of the manifest in the VSIX as the offline fallback.

**FR-3.2** On activation, fetch the remote manifest over HTTPS with a 5s timeout. On any failure — offline, DNS, 5xx, TLS — fall back silently to the cached copy in `globalState`, then to the bundled copy. A failed fetch is **never** a user-visible error; it becomes an info-level health check ("Using cached defaults from <date>").

**FR-3.3** Cache the fetched manifest in `globalState` with its fetch timestamp. Re-fetch at most once per hour per window.

**FR-3.4** Validate the manifest against a JSON schema before use. A manifest failing validation is discarded in favour of the cache. This is the update channel — a bad manifest must not be able to brick every user simultaneously.

**FR-3.5** Honour `minExtensionVersion`. If the manifest requires a newer extension than is installed, use the cached/bundled defaults and raise a warn-level check prompting update.

**Manifest schema (v1):**

```jsonc
{
  "schemaVersion": 1,
  "revision": "2026-09-10T00:00:00Z",     // opaque; used for change detection
  "minExtensionVersion": "0.1.0",
  "minimumClaudeCodeVersion": "2.1.0",
  "defaults": {
    "env": {
      "CLAUDE_CODE_USE_BEDROCK": "1",
      "AWS_REGION": "us-east-1",
      "ANTHROPIC_DEFAULT_OPUS_MODEL": "us.anthropic.claude-opus-...",
      "ANTHROPIC_DEFAULT_SONNET_MODEL": "global.anthropic.claude-sonnet-...",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL": "us.anthropic.claude-haiku-..."
    },
    "permissions": {
      "deny": ["Bash(rm -rf:*)", "Read(./.env)", "Read(./.aws/**)"]
    },
    "extraKnownMarketplaces": {
      "<name>": { "source": { "source": "github", "repo": "<owner>/<repo>" } }
    },
    "enabledPlugins": { "<plugin>@<name>": true }
  },
  "regions": ["us-east-1", "us-west-2", "eu-central-1", "ap-southeast-1"],
  "notices": [
    { "level": "info", "message": "…", "expiresAt": "2026-10-01T00:00:00Z" }
  ]
}
```

`notices` is a deliberate escape hatch: a way to say something to every user without shipping code.

### FR-4 — Credential management

**Verified constraint:** `apiKeyHelper` cannot be used here. It supplies the Anthropic-side credential, and cloud-provider credentials outrank it in Claude Code's precedence order — when `CLAUDE_CODE_USE_BEDROCK` is set the helper is never consulted. `awsCredentialExport` returns SigV4 triplets and a Bedrock API key does not use the AWS provider chain. **The bearer token has exactly two delivery paths: a settings-file `env` block, or the real process environment.**

**FR-4.1 — Canonical storage.** The token's source of truth is `context.secrets` (VS Code SecretStorage → OS keychain: Keychain / DPAPI / libsecret). Never `globalState`, never a workspace setting, never a plain file the extension controls.

**FR-4.2 — Entry.** `window.showInputBox({ password: true, ignoreFocusOut: true })` with:
- A `validateInput` that rejects obviously-wrong shapes (empty, contains whitespace, looks like an AWS access key ID rather than a Bedrock API key).
- Prompt text linking to the Bedrock console API keys page.
- Explicit guidance to choose a **long-term** key for a persistent setup.

**FR-4.3 — Terminal injection.** Where the token exists, inject it into integrated terminals so terminal users never read it from disk:

```ts
ctx.environmentVariableCollection.persistent = false;
ctx.environmentVariableCollection.replace('AWS_BEARER_TOKEN_BEDROCK', token);
ctx.environmentVariableCollection.replace('CLAUDE_CODE_USE_BEDROCK', '1');
```

`persistent = false` is required. A persistent collection is cached to disk by VS Code so it can be applied before extension activation, which reintroduces exactly the on-disk plaintext this avoids.

**FR-4.4 — File write-through.** `environmentVariableCollection` reaches integrated terminals only. The Claude Code **panel** spawns its binary from the extension host and inherits VS Code's process environment, which the collection does not touch. Since the panel is the primary persona's surface, the token must also be written to the `env` block of `~/.claude/settings.json`, at mode `0600`, treated as a derived artefact of the keychain value.

**FR-4.5 — Rotation.** A single command (`Claude Config: Update Bedrock Token`) that updates the keychain, rewrites the file, refreshes the terminal collection, and re-runs validation. Users must never hand-edit to rotate.

**FR-4.6 — Age tracking.** Store the token's set-date alongside it. Health check goes warn at 90 days, fail at 180 (both configurable via manifest).

**FR-4.7 — Validation.** Offer an explicit "Test connection" action making the cheapest possible Bedrock call with the configured token, region, and Haiku model ID. Distinguish and message separately: bad credential (401/403), model not enabled in account, wrong region, network/proxy failure.

**FR-4.8 — Leak scan.** Scan open workspace folders for the token value appearing in any `.claude/settings*.json`, `.env`, or tracked file. On hit: fail-level check, offer to remove the occurrence, and warn if the file is git-tracked. This is the check that earns its keep with this audience.

**FR-4.9 — Redaction.** The token must never appear in the output channel, error messages, notifications, diagnostics report, or any log. Implement a single `redact(s: string)` helper applied at the logging boundary, plus a test asserting a known token value cannot appear in diagnostics output.

**FR-4.10 — Documented residual risk.** The README must state plainly that Claude Code passes credentials via the process environment, so the token is inherited by every subprocess and MCP server it spawns. Storage hardening does not change this. The mitigations that matter are credential scope and rotation, and the extension should say so rather than imply a security property it cannot provide.

### FR-5 — Health panel

**FR-5.1 — Surface.** A custom activity-bar view container containing a `TreeView`. Not a webview for v1: the TreeView gives codicon status glyphs, inline command buttons, a count badge, native theming, and accessibility for roughly a tenth of the code. Revisit only if the first-run flow demonstrably needs more polish.

**FR-5.2 — Structure.** Grouped tree: `Installation` / `Configuration` / `Credential` / `Plugins`. Each leaf is a check with a codicon (`pass`/`warning`/`error`/`info`), a one-line plain-language label, and where applicable an inline "fix" command.

**FR-5.3 — Language.** Labels are written for someone who does not know what an environment variable is. "Claude Code can't reach AWS — your access key may have expired", not "AWS_BEARER_TOKEN_BEDROCK returned 403".

**FR-5.4 — Badge.** The view container badge shows the count of fail-level checks only. Warnings do not badge — badge fatigue defeats the purpose.

**FR-5.5 — Notification discipline.** Modal or toast notifications fire only on: (a) first run with no configuration, (b) a transition from healthy to fail. Never on warnings, never repeatedly, never on every window open. Non-technical users disengage from repeated prompts faster than any other cohort.

**FR-5.6 — Check catalogue.**

| ID | Check | Level on failure | Remediation offered |
|---|---|---|---|
| `install.extension` | Claude Code extension installed | error | Install command |
| `install.version` | Meets minimum version | warning | Open extension page |
| `install.cli` | `claude` on PATH | info | On Windows, offer opt-in integrated-terminal repair if the registered extension's bundled executable is verified and no existing CLI/launcher is found; otherwise explain the blocker. Never modify the system PATH. |
| `config.exists` | `~/.claude/settings.json` present | warning | Apply defaults |
| `config.parses` | Valid JSON | error | Open file / restore backup |
| `config.perms` | Mode 0600 / ACL sane | warning | Repair permissions |
| `config.bedrock` | `CLAUDE_CODE_USE_BEDROCK=1` | error | Apply defaults |
| `config.region` | `AWS_REGION` set and in known list | error | Region picker |
| `config.models` | Model IDs present and match manifest | warning | Apply defaults |
| `config.drift` | Managed keys diverge from recommended | info | Show diff / reset per key |
| `config.stale` | Applied manifest revision is behind current | info | Apply update |
| `cred.present` | Token in keychain | error | Entry flow |
| `cred.mirrored` | Token present in settings file | error | Re-apply |
| `cred.valid` | Test call succeeds | error | Re-enter / diagnose |
| `cred.age` | Age under threshold | warning / error | Rotation flow |
| `cred.leak` | Token not found in workspace files | error | Purge occurrence |
| `plugins.marketplace` | Marketplace registered | info | Register |
| `plugins.enabled` | Expected plugins enabled | info | Enable |

### FR-6 — Commands

All contributed under the `Claude Config:` category.

| Command ID | Title | Notes |
|---|---|---|
| `sensibleDefaults.runHealthCheck` | Check Configuration | Also the view refresh action |
| `sensibleDefaults.applyDefaults` | Apply Recommended Configuration | Shows a diff preview before writing |
| `sensibleDefaults.setToken` | Set Bedrock API Key | |
| `sensibleDefaults.rotateToken` | Update Bedrock API Key | |
| `sensibleDefaults.clearToken` | Remove Bedrock API Key | Clears keychain + file + terminal collection |
| `sensibleDefaults.testConnection` | Test Bedrock Connection | |
| `sensibleDefaults.selectRegion` | Change AWS Region | QuickPick from manifest `regions` |
| `sensibleDefaults.openSettings` | Open settings.json | |
| `sensibleDefaults.restoreBackup` | Restore Previous Configuration | QuickPick over backups |
| `sensibleDefaults.copyDiagnostics` | Copy Diagnostics for Support | |
| `sensibleDefaults.resetKey` | Reset a drifted key | Context-menu on drift nodes |

**FR-6.1 — Diff preview.** `applyDefaults` must show what will change before writing. A simple QuickPick or untitled-document diff is sufficient; silently mutating a config file is not acceptable even when correct.

### FR-7 — Diagnostics and support

**FR-7.1** `copyDiagnostics` produces a Markdown block containing: extension version, VS Code version, platform and architecture, remote/WSL indicator, Claude Code extension version, CLI version, manifest revision and fetch time, the full `settings.json` **with all values in `MANAGED_KEYS` matching credential patterns replaced by `«redacted»`**, the health check results table, and the last 50 output-channel lines.

**FR-7.2** An output channel named `Sensible Claude Code Defaults`, logging every apply, fetch, and check result. This is what users will be asked to copy.

**FR-7.3** The diagnostics block must be safe to paste into a public GitHub issue. Test this assertion (§14.4).

---

## 5A. Naming, branding, and marketplace positioning

Settled after surveying the live Marketplace listings. Treat as closed (see §14, D7).

**Names.**

| Field | Value |
|---|---|
| `displayName` | `Sensible Claude Code Defaults` |
| `name` | `sensible-claude-code-defaults` |
| `description` | `Health checks and working defaults for Claude Code on AWS Bedrock.` |
| Activity bar title | `Sensible Defaults` |
| Command category | `Sensible Defaults` |
| Namespace | `sensibleDefaults.*` |

**Why this ordering.** In the *default narrow* Extensions sidebar, titles clip at roughly 22–24 characters. `Sensible Claude Code Defaults` clips to "Sensible Claude Code…" — the surviving fragment still contains the phrase users scan for. The alternative construction `Sensible Defaults for Claude Code` clips to "Sensible Defaults fo…" and loses it entirely. Leading with "Sensible" rather than "Claude" is what stops the listing disappearing into the cluster of six extensions whose visible text begins "Claude Code…", one of which is Anthropic's own with 25M+ installs and a verified badge.

Clipping affects scanning only. Marketplace search matches the full display name and description regardless, which is why the description carries the keywords and the title is free to differentiate.

**Icon requirements.** The icon does more work than the title here.

- Must **not** use orange, a starburst, or any form resembling Anthropic's mark — both for differentiation and to stay clear of trade dress.
- Must **not** ship the default placeholder glyph. A survey of the "preflight" results shows five of twelve extensions doing exactly that; they are visually indistinguishable in the list.
- Pick a colour not already common in Claude-adjacent listings. Legibility at 32px is the only real constraint.

**Trademark posture.** Anthropic registered the CLAUDE mark in 2023, holds a substantial portfolio, and has enforced it (the Clawdbot → Moltbot rename is the live precedent). Anthropic's terms prohibit using their name or marks in connection with non-Anthropic products, or in any way implying affiliation, without written permission. This project's use is nominative — identifying the tool it configures — which is the defensible posture, but it must be made explicit rather than assumed:

- **Required:** a non-affiliation statement in both the README and the Marketplace description. Suggested wording: *"An independent tool. Not affiliated with, endorsed by, or sponsored by Anthropic, PBC."* Because the mark sits mid-phrase here rather than in a detachable trailing descriptor, this is load-bearing, not boilerplate.
- **Required:** no Anthropic logos, no trade dress, no wording implying official status.
- **Recommended before launch:** a short note to Anthropic describing what is shipping. Their published guidance for people building on Claude points to `usersafety@anthropic.com` for specific proposals. Converts an unknown into a yes or an early no, at zero cost, before installs and publisher verification accrue against the name.

**Pre-registration checks (do before creating the publisher):**

- Confirm `sensible-claude-code-defaults` is free on both the VS Code Marketplace and Open VSX.
- USPTO search for "sensible defaults" in classes 9 and 42. Note the phrase is used by Thoughtworks as an internal programme name and appears in an unrelated low-install Marketplace extension (`tw-jaseem.sensible-default`); neither is a conflict, but confirm nothing has been registered.

## 6. Repository layout

```
sensible-claude-code-defaults/
├── .github/workflows/release.yml
├── .vscode/{launch.json,tasks.json}
├── src/
│   ├── extension.ts              # activate/deactivate, wiring only
│   ├── config/
│   │   ├── paths.ts              # homedir resolution, path helpers
│   │   ├── reader.ts             # read + parse + backup
│   │   ├── writer.ts             # atomic write, permissions
│   │   ├── merge.ts              # three-way merge (FR-2.2)
│   │   └── snapshot.ts           # last-applied state in globalState
│   ├── manifest/
│   │   ├── fetch.ts              # remote fetch + cache + fallback
│   │   ├── schema.ts             # validation
│   │   └── bundled.json          # offline fallback
│   ├── credential/
│   │   ├── store.ts              # SecretStorage
│   │   ├── env.ts                # environmentVariableCollection
│   │   ├── validate.ts           # Bedrock test call
│   │   └── leakScan.ts
│   ├── health/
│   │   ├── checks/               # one file per check ID
│   │   ├── runner.ts
│   │   └── types.ts
│   ├── ui/
│   │   ├── treeProvider.ts
│   │   ├── commands.ts
│   │   └── flows.ts              # first-run, token entry, rotation
│   └── util/
│       ├── redact.ts
│       └── log.ts
├── test/
│   ├── unit/
│   └── integration/
├── media/icon.png                # 128×128
├── docs/PRD.md                   # this document — source of truth
├── esbuild.js
├── package.json
├── CLAUDE.md                     # agent working agreement, points at docs/PRD.md
├── README.md                     # this is the Marketplace listing page
├── CHANGELOG.md
└── LICENSE
```

**Constraint:** everything bundles to a single `dist/extension.js` via esbuild. Shipping raw `node_modules` is the most common trigger for the Marketplace's suspicious-content scan.

## 7. Manifest (`package.json`) essentials

```jsonc
{
  "name": "sensible-claude-code-defaults",
  "displayName": "Sensible Claude Code Defaults",
  "description": "Health checks and working defaults for Claude Code on AWS Bedrock.",
  "publisher": "<tbd>",                   // must match created publisher ID — §16 Q4
  "version": "0.1.0",
  "license": "MIT",
  "repository": { "type": "git", "url": "https://github.com/<owner>/<repo>" },
  "icon": "media/icon.png",
  "categories": ["Other"],
  "engines": { "vscode": "^1.98.0" },     // our own API floor; anthropic.claude-code 2.1.267 declares ^1.94.0
  "extensionDependencies": ["anthropic.claude-code"],
  "activationEvents": ["onStartupFinished"],
  "main": "./dist/extension.js",
  "capabilities": { "untrustedWorkspaces": { "supported": true } },
  "contributes": {
    "viewsContainers": { "activitybar": [{ "id": "sensibleDefaults", "title": "Sensible Defaults", "icon": "media/icon.svg" }] },
    "views": { "sensibleDefaults": [{ "id": "sensibleDefaults.health", "name": "Configuration Health" }] },
    "commands": [ /* per FR-6 */ ],
    "configuration": {
      "properties": {
        "sensibleDefaults.manifestUrl": { "type": "string", "default": "https://..." },
        "sensibleDefaults.autoApply": { "type": "boolean", "default": false },
        "sensibleDefaults.checkOnStartup": { "type": "boolean", "default": true }
      }
    }
  }
}
```

**Do not** set `"extensionKind": ["ui"]` (see FR-1.3).

`autoApply` defaults to **false**: the extension proposes, the user accepts. Revisit only with evidence that the confirmation step is causing abandonment.

## 8. Build and CI

- Node 22, TypeScript, esbuild, `@vscode/vsce`, `ovsx`.
- `npm run package` → validated `.vsix`.
- GitHub Actions on tag `v*`: build → test → `vsce package` → publish to Marketplace → publish to Open VSX.

**Authentication — decide before writing the workflow.** Azure DevOps retires global Personal Access Tokens on **1 December 2026**. Every tutorial describes the PAT flow; if the pipeline is built that way it will need rebuilding within weeks of launch. Use Microsoft Entra ID with workload identity federation (`vsce publish --azure-credential`) from the outset. If a PAT is used as a stopgap, it must have `Marketplace (Manage)` scope and **"All accessible organizations"** — the single-org default fails with an unhelpful error.

Open VSX uses a separate GitHub-linked token and requires a namespace created once via `ovsx create-namespace`.

## 9. Publishing runbook

**One-time (30–60 minutes, mostly browser account setup):**

1. Choose the publisher ID. It is global, effectively permanent, and prefixes the extension ID forever.
2. Create the publisher in the Marketplace management portal. **Do this immediately**, even before the first publish — verified-publisher status requires the publisher account and the domain to both be at least six months old, so the clock should start now.
3. Configure Entra ID federation (or a correctly-scoped PAT).
4. Create the Open VSX namespace.
5. Register the domain for eventual verification. Must be an apex domain — `cutler.io` qualifies, a `github.io` subdomain does not. Note that changing the publisher display name later revokes verification.

**Per release:**

```bash
npm run test
npx @vscode/vsce package                 # sanity check the .vsix locally
git tag v0.1.0 && git push --tags        # CI publishes to both registries
```

There is **no human review queue**. An automated scan runs and the listing goes live within minutes. Expect search indexing to lag the direct item URL. Client-side auto-update is held for roughly two hours for non-trusted publishers while scanning completes — plan the update cadence around this, and keep fast-moving values in the manifest rather than the VSIX.

Consider shipping the first releases with `--pre-release` and dogfooding with known users before promoting to stable.

## 10. Testing

**10.1 Unit** — merge engine (every row of the FR-2.2 table), manifest schema validation and rejection, redaction, path resolution.

**10.2 Integration** — against a temp `HOME`: fresh install, existing hand-written config, malformed config, drifted config, backup/restore round-trip.

**10.3 Platform matrix** — the long pole, and the source of most user-visible bugs:

| Platform | Must verify |
|---|---|
| macOS (Apple Silicon) | Keychain, POSIX modes, homedir |
| Windows 11 native | `%USERPROFILE%`, ACL handling, DPAPI, path separators |
| Windows + WSL2 | Extension host runs remote; writes land in the **WSL** home, not the Windows home |
| Linux | libsecret present *and absent* — SecretStorage degrades on headless/minimal systems |
| Remote-SSH | Same-side resolution |

**10.4 Security assertions** (as tests, not review items):
- A known token value never appears in diagnostics output.
- No write path resolves inside a workspace folder.
- `settings.json` is `0600` after every write.
- `environmentVariableCollection.persistent === false`.

## 11. Milestones

| M | Scope | Estimate |
|---|---|---|
| M0 | Publisher + namespace created, CI skeleton publishing a hello-world | 0.5 day |
| M1 | Read/parse/backup/atomic-write, merge engine, snapshot, unit tests | 2 days |
| M2 | Health runner + TreeView + core checks | 1.5 days |
| M3 | Credential flow: entry, keychain, write-through, terminal injection, test call | 1.5 days |
| M4 | Defaults manifest fetch/cache/fallback/validate | 1 day |
| M5 | Diagnostics, output channel, redaction, leak scan | 1 day |
| M6 | Platform matrix testing and fixes | 1–2 days, recurring |
| M7 | README, first-run polish, pre-release publish | 1 day |

**M0–M3 is a usable internal tool.** M0–M7 is something to be comfortable having strangers install. Realistically: a weekend to the former, two to three weeks part-time to the latter.

## 12. Ongoing cost

This is not ship-and-forget. Bedrock model IDs move, Claude Code's settings schema evolves, and VS Code ships monthly. Budget a few hours a month indefinitely. The architecture in §4 exists specifically to keep most of that cost in a git repo rather than a release cycle.

---

## 13. Non-functional requirements

**Performance.** Activation must add < 100ms to window startup. All I/O async. Manifest fetch is fire-and-forget with the UI rendering from cache immediately.

**Privacy.** No telemetry in v1. If added later it must be opt-in, disclosed prominently in the README, and honour `telemetry.telemetryLevel`. The extension makes exactly two categories of outbound request: the defaults manifest fetch, and the user-initiated Bedrock test call. Both documented in the README.

**Trust posture.** A new, unverified publisher asking users for an AWS credential is a legitimately suspicious thing. Counter it by construction: public repository, README stating exactly which files are written and where the token is stored, the non-affiliation statement from §5A, no obfuscation, no telemetry, no network calls beyond the two documented ones. This is also the groundwork for the verified badge later.

**Accessibility.** TreeView gives this largely for free. Ensure every check node has a meaningful `tooltip` and `accessibilityInformation`.

**Untrusted workspaces.** The extension operates on the user profile, not workspace content, so it can declare full support — but the leak scan (FR-4.8) reads workspace files and must be gated appropriately.

---

## 14. Decisions already made (do not relitigate)

**D1 — Public marketplace, not a private gallery.** VS Code's `extensionsGallery` is a single endpoint, not additive. Pointing clients at a custom gallery *replaces* the Marketplace, which would break resolution of `anthropic.claude-code` — the exact dependency the gallery was meant to serve — plus every other extension the users need. Mirroring the Marketplace to work around this conflicts with its terms. Public publishing is both cheaper and more correct.

**D2 — Nothing organisation-specific ships in the extension.** All defaults are generic AWS Bedrock guidance. Anything site-specific belongs in the manifest (which can be forked) or in managed settings (which are out of scope here).

**D3 — `settings.local.json` is not used.** It is project-scoped, so it would create one copy of a per-device credential per repository. Its gitignore protection solves a narrower problem than the one at hand.

**D4 — `apiKeyHelper` is not used.** It cannot supply a Bedrock bearer token (see FR-4 preamble).

**D5 — TreeView before webview.** Cost/benefit at v1 favours the native surface.

**D6 — MCP servers, hooks, and commands ship as a Claude Code plugin, not as extension-written config.** Different cadence, better native tooling, and it keeps the extension thin.

**D7 — Name is `Sensible Claude Code Defaults`, in that word order.** Rationale and the rejected alternatives are in §5A. Candidates eliminated: `Claude Config Doctor` (leads with the mark; also collides with the existing 30K-install "Claude Config" by Clibbits, which manages Claude *Desktop* config); `Preflight for Claude Code` (twelve existing Marketplace extensions named Preflight, three of them health-check tools); `Sensible Defaults for Claude Code` (clips badly in the default narrow sidebar); `Bedrock Defaults` (forecloses Vertex/Foundry, and nominatively uses a second mark).

**D8 — Non-affiliation is stated explicitly, not implied.** See §5A. This is a launch blocker, not a nice-to-have, given the extension asks users for a cloud credential under a name containing another company's trademark.

---

## 15. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Merge bug destroys user config | High | Backups (FR-2.4), diff preview (FR-6.1), exhaustive merge tests |
| Claude Code settings schema changes | Medium | Manifest carries the schema shape; extension code stays generic over keys |
| Token leaks via user error | High | Leak scan, 0600, redaction, README honesty about subprocess exposure |
| Bad manifest bricks all users | High | Schema validation before use, fallback chain, `minExtensionVersion` gate |
| WSL homedir mismatch | Medium | FR-1.3 + explicit test |
| PAT retirement breaks CI mid-flight | Medium | Use Entra ID federation from day one |
| Support load from unknown machines | Medium | Diagnostics as an M5 deliverable, not an afterthought |

## 16. Open questions

- **Q1** — Manifest hosting: GitHub raw (free, versioned, rate-limited) vs. S3+CloudFront (controllable, costs pennies). Leaning GitHub raw for v1.
- **Q2** — Should the extension offer to install the Claude Code plugin marketplace, or just report on it? Reporting is safer for v1.
- **Q3** — SSO / `awsAuthRefresh` support: strictly better than bearer tokens where Identity Center exists. Deferred to v2, but keep the credential layer abstract enough not to preclude it.
- **Q4 — BLOCKS M0.** Publisher ID: `cutler` vs. `carrotly-ai`. Effectively permanent, prefixes the extension ID forever, renders under the title in every listing, and determines which apex domain can be verified later (`cutler.io` vs. the carrotly domain — subdomains are not eligible). This is the last open naming decision; M0 cannot start until it is made, and the six-month verification clock does not start until the publisher exists.
- **Q5** — Should a stale manifest (> 30 days uncached) escalate above info level?

---

## 17. Appendix — reference facts

Externally verified, but re-check against current Claude Code documentation before coding against any of them.

**Bedrock configuration.** `CLAUDE_CODE_USE_BEDROCK=1` enables Bedrock. Since Claude Code v2.1.172 the region resolves `AWS_REGION` → `AWS_DEFAULT_REGION` → the active AWS profile's `region` → `us-east-1`; the extension still writes `AWS_REGION` because the target users have no `~/.aws`. *(Amended 2026-09-10.)* Model selection uses `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, and `ANTHROPIC_DEFAULT_HAIKU_MODEL` with Bedrock inference profile IDs. `AWS_BEARER_TOKEN_BEDROCK` carries a Bedrock API key.

**Credential precedence.** Cloud-provider credentials (when `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY` is set) → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `apiKeyHelper` → subscription OAuth. This is why `apiKeyHelper` is unreachable under Bedrock.

**Bedrock API keys** are scoped to Bedrock operations and cannot be used for other AWS calls — a real containment property worth surfacing to users. They do not pass through the AWS default credential provider chain. Long-term keys suit persistent setups; short-term keys expire.

**Subprocess exposure.** Claude Code passes credentials via the process environment, so shell commands and MCP servers it spawns inherit them. Storage location does not change this.

**Settings hierarchy** (highest first): enterprise managed settings → CLI arguments → `.claude/settings.local.json` (project, personal) → `.claude/settings.json` (project, shared) → `~/.claude/settings.json` (user).

**Claude Code extension.** ID `anthropic.claude-code`. Platform-specific builds (`…-darwin-arm64`, `…-win32-x64`, etc.) each bundling a native binary. Declared engine floor `^1.94.0` as of 2.1.267 (verified 2026-09-10). Available on the VS Code Marketplace and reportedly on Open VSX. The CLI installs/updates the extension itself when run in VS Code's integrated terminal, so it may already be present and may update independently of anything this extension does.

**Marketplace mechanics.** No human review. Automated scan, live in minutes. Global Azure DevOps PATs retire 2026-12-01. Verified badge requires apex-domain ownership plus six months of publisher and domain age. Non-trusted publishers' updates are held client-side about two hours.


---

## 18. Verified deltas (2026-09-10)

Facts checked against live Claude Code, AWS, and Marketplace documentation while building M0/M1. Newer-dated information wins over §17 where they disagree.

- **Claude Code now ships `/setup-bedrock`** (and a startup prompt that offers to update pinned model IDs). Both write `env.AWS_REGION`, the `ANTHROPIC_DEFAULT_*_MODEL` pins, and `AWS_BEARER_TOKEN_BEDROCK` into the user `settings.json`. Claude Code is therefore a third writer of the extension's managed keys. The merge engine treats this as drift; the health panel wording is "Claude Code changed the … model", not "you changed", and the credential flow offers to *adopt* a token found in the file (M3 plan).
- **Claude Code does not enforce mode `0600` on `settings.json`** (only on `.credentials.json`); after any Claude Code write the file is typically `0664`. FR-2.8's repair therefore runs silently on every health check and reports `pass`, never a warning — a "Repair" button would be a treadmill.
- **Settings files are strict JSON.** A `//` comment or trailing comma is a syntax error to Claude Code too, so a file the extension cannot parse is one Claude Code cannot parse either; `JSON.parse` is the correct parser.
- **Bedrock API keys.** Used as `Authorization: Bearer <key>` against `bedrock-runtime`; do not pass through the AWS provider chain. Short-term keys last ≤12 h and inherit the caller's IAM permissions (AWS's recommendation for production); long-term keys are an IAM user + service-specific credential with an expiry chosen at creation, which AWS describes as "for exploration only". The key format is undocumented. The extension cannot read a key's expiry, so `cred.age` is a proxy; the README must state the trade-off and recommend the admin cap `iam:ServiceSpecificCredentialAgeDays`.
- **Credential precedence** in §17 is confirmed verbatim in current docs (cloud provider → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` → profiles → `/login`). D4 stands.
- **`enabledPlugins` values** are `boolean | string[]` per the published settings schema; the merge engine tolerates both.
- **Registry state.** `sensible-claude-code-defaults` is free on the VS Code Marketplace and Open VSX; publisher/namespace `cutler`, `carrotly-ai`, `carrotly`, `cotdp` are all free on both.

## 19. Change log

- **2026-09-10 v1.2** — FR-1.2 honours `CLAUDE_CONFIG_DIR`; FR-2.2 snapshot moved from `globalState` to `sensible-defaults/state.json`, element-level ownership and removal semantics added; FR-2.4 backup path moved under `sensible-defaults/backups/`, restore drops the snapshot; §4.2 table and §7 engine comment corrected; §17 region and engine-floor facts corrected; §18 added. Rationale and the full decision log: `plans/feat-m0-scaffold.md`.
