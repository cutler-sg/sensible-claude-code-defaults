# Plan — M5 (diagnostics, output channel, redaction, leak scan)

Source of truth: `docs/PRD.md` FR-4.8, FR-4.9, FR-7, §10.4 (security assertions as tests), §13 (trust posture).
Depends on M2 (output channel, checks) and M3 (the token exists to leak).
Branch: `feat/m5-diagnostics`. Status: **delivered 2026-09-11.**

## The one thing M5 is for

Everything before this milestone assumed `util/redact.ts` would eventually do its job; it is still the identity function. M5 makes the promise true and then proves it with tests that would fail if anyone regressed it. The M2 review already found one live leak (V8 parse-error snippets), which is evidence that the structural approach — never construct the string — matters more than the filter.

## Architecture

```
src/util/redact.ts        registry + redact(s) + redactObject(v)
src/diagnostics/report.ts buildDiagnostics(deps) → markdown string
src/credential/leakScan.ts scanWorkspaceForToken(deps) → hits[]
src/health/checks/cred.leak.ts  the real check
```

## Redaction (FR-4.9)

- [x] `redact.ts` keeps a **registry of exact secret values** (the current token, and any previous value until the window closes) registered by the credential store on every change. `redact(s)` replaces every occurrence of every registered value with `«redacted»`, longest-first.
- [x] Plus **pattern** rules as a second net, for values we never held: `AKIA[0-9A-Z]{16}`, `ABSK[A-Za-z0-9+/=]{20,}`, `bedrock-api-key-[A-Za-z0-9+/=._-]{8,}`, `Authorization: Bearer \S+`, and any `"AWS_BEARER_TOKEN_BEDROCK"\s*:\s*"[^"]*"`.
- [x] `redactObject` walks JSON, redacting values under `SECRET_KEYS` by key as well as by value — key-based redaction is the one that still works when the pattern set is wrong.
- [x] The registry is memory-only and cleared on deactivate. It is never persisted (a file of known secrets is a worse artefact than the leak it prevents).

## Diagnostics (FR-7)

- [x] `buildDiagnostics` produces Markdown: extension version, VS Code version, platform+arch, remote/WSL indicator, Claude Code extension version, CLI version, manifest revision + source + fetch time, the **whole `settings.json` with every `SECRET_KEYS` value replaced**, the health results table, and the last 50 output-channel lines (kept in a ring buffer by `Logger`, already the single choke point).
- [x] `copyDiagnostics` command writes to the clipboard and shows a confirmation naming what was included and what was removed.
- [x] FR-7.3 / §10.4 #1 as a test: seed a known token into the keychain, the settings file, an output-channel line, and a check detail; assert the token appears **nowhere** in the diagnostics output, byte-for-byte, including base64 and URL-encoded forms of it.

## Leak scan (FR-4.8)

- [x] `scanWorkspaceForToken`: only when a token exists, only over open workspace folders, only files matching `.claude/settings*.json`, `.env*`, `*.json`, `*.md`, `*.sh`, `*.ps1` under a size cap (1 MiB) and a file-count cap (5000), skipping `node_modules`, `.git`, `dist`, `out`, `.venv`, and anything `.gitignore`d that is not tracked. Time-boxed to 3 s; a scan that runs out of budget reports "partial", never a false all-clear.
- [x] **Untrusted-workspace gate (§13)**: the scan reads workspace content, so it must not run in an untrusted workspace. The extension stays `untrustedWorkspaces: supported` and the scan checks `vscode.workspace.isTrusted` itself.
- [x] On a hit: `cred.leak` → error naming the file (path only), with a fix that opens the file at the offending line and, if the file is git-tracked, warns that the value is likely in history and rotation is the only real remedy.
- [x] Never write to a workspace file to "fix" a leak (hard rule 1). Offer to open it; the user removes it.

## Tasks

- [x] `redact.ts` + tests: registry, patterns, longest-first, `redactObject` by key and by value, no catastrophic backtracking (fuzz a 100 KiB line), clearing on deactivate.
- [x] `Logger` gains the ring buffer; test that it holds 50 and that every line was redacted on the way in.
- [x] `report.ts` + the §10.4 #1 assertion, plus a snapshot-ish test of the Markdown shape.
- [x] `leakScan.ts` + tests over a temp workspace: hit in `.env`, hit in a project `.claude/settings.json`, no hit, respects caps, respects the trust gate, partial result on timeout.
- [x] `cred.leak` check + tests; `copyDiagnostics` command + contributes entry.
- [x] README "Residual risk" section: subprocess inheritance (FR-4.10) and what the leak scan does and does not cover.

## Delivered

All boxes above are done, with three notes worth carrying forward.

- **`redactValue` and `__proto__`.** It assigns into its output object, so a
  `__proto__` key in a settings document lands on the prototype and disappears
  from the serialised report instead of being rendered. Fidelity loss, not a
  disclosure — the subtree is redacted on the way past either way, and
  `Object.prototype` is untouched. `managedKeys.setPath` avoids this by defining
  the key rather than assigning it; `redactValue` could do the same.
- **`SECRET_KEYS` are dotted; `redactValue` sees leaf names.** Passing the set
  straight through matches nothing and silently reduces the key rule to the
  pattern net. `report.ts` derives the leaves, and `redact.test.ts` pins that.
- **`.gitignore` was not consulted.** The plan's file rule said "anything
  `.gitignore`d that is not tracked", but an ignored-and-untracked `.env` is
  exactly the file most likely to hold a pasted key, and skipping it would have
  removed the scan's best hit. Tracked-ness is reported per hit instead, which
  is what changes the advice.

## Decisions taken

- **Q-AC** Diagnostics go to the clipboard, not a file — a file is one more artefact containing a redacted-but-still-sensitive dump.
- **Q-AD** The scan never auto-fixes. Editing a user's repo file to strip a secret is exactly the class of action hard rule 1 forbids, and rotation is the real fix anyway.
- **Q-AE** Redaction is registry-first, pattern-second. Patterns alone cannot catch a key format AWS does not document.
