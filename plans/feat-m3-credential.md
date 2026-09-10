# Plan — M3 (credential flow: entry, keychain, write-through, terminal injection, test call)

Source of truth: `docs/PRD.md` FR-4 (all), FR-5.6 `cred.*` rows, FR-6 token commands, §10.4, §17.
Depends on M1 (`apply`/`merge` for write-through) and M2 (health runner + tree; `cred.*` placeholders
become real). Manifest (M4) supplies `cred.age` thresholds — until then read them from the bundled copy.
Branch: `feat/m3-credential`.
Status: **draft, written before M2 started.** Re-read M2's `CheckContext` before starting.

## Verified facts that shape M3 (2026-09-10, AWS + Claude Code docs)

- A Bedrock API key is sent as `Authorization: Bearer <key>`; env var `AWS_BEARER_TOKEN_BEDROCK`.
  It does **not** go through the AWS provider chain, so `awsCredentialExport`/`apiKeyHelper` are out (D4).
- Two kinds: **short-term** (≤12 h, inherits the caller's IAM permissions, AWS's recommendation for
  production) and **long-term** (IAM user + service-specific credential, expiry chosen at creation,
  AWS: "for exploration only"). We cannot read a key's expiry from the key. → `cred.age` is a
  proxy; the README must own the trade-off and recommend the admin cap
  `iam:ServiceSpecificCredentialAgeDays`.
- Key **format is not documented** by AWS. Long-term keys observed in the wild are long base64-ish
  strings starting `ABSK`; short-term keys start `bedrock-api-key-`. Validation must be
  *shape-based and permissive*: reject empty / whitespace / `AKIA…`+20 chars (an access key ID) /
  `aws_secret…` / anything < 20 chars; accept everything else. Never reject a real key.
- Claude Code's `/setup-bedrock` wizard **also** writes `AWS_BEARER_TOKEN_BEDROCK` into the user
  `env` block. So the file may already hold a token we didn't set → `cred.mirrored` must handle
  "file has a token, keychain doesn't" by offering to *adopt* it (import into keychain, take
  ownership via `resetKeyPlan`), not by flagging it as broken.
- Bedrock `InvokeModel` requires `bedrock:InvokeModel`; the cheapest authenticated call that also
  proves the model is enabled is `POST /model/<haiku-id>/invoke` with `max_tokens: 1`. Cheaper
  still, and permission-free for the *credential* check alone: `GET /foundation-models` on the
  control plane (`bedrock.<region>.amazonaws.com`) with the bearer — but bearer auth is only
  documented for `bedrock-runtime`, so use `invoke` and classify by status.
- `environmentVariableCollection.persistent = false` is the documented way to keep the collection
  out of VS Code's on-disk cache (§10.4 assertion #4).

## Architecture

```
src/credential/
  store.ts     TokenStore over SecretStorage (structurally typed, no vscode import):
               get(): {token, setAt} | undefined; set(token, now); clear().
               Stored as one JSON secret {token, setAt} under key `sensibleDefaults.bedrockToken`
               so age travels with the value (FR-4.6) and one keychain entry = one prompt on
               Linux libsecret unlock.
  shape.ts     validateTokenShape(s) → undefined | 'empty' | 'whitespace' | 'looks-like-access-key'
               | 'too-short'. Pure. Messages live in health/labels.ts.
  env.ts       TerminalEnv wrapper: apply(token) / clear(); asserts `persistent === false` at
               construction (§10.4 #4 as a runtime invariant, plus a test).
  writeThrough.ts  sync(env, session, token|undefined) → uses apply.plan/commit with
               desired = { 'env.AWS_BEARER_TOKEN_BEDROCK': token, 'env.CLAUDE_CODE_USE_BEDROCK': '1' }.
               Token undefined → removal (merge Q-G). Drift on the token key = "someone put a
               different token in the file" → surfaced by cred.mirrored with adopt/overwrite choice.
  validate.ts  testConnection({token, region, haikuModel, fetch}) → classified result:
               ok | bad-credential(401/403 with UnrecognizedClient/AccessDenied) |
               model-not-enabled(403 AccessDenied naming the model, or 400 ValidationException
               "model identifier is invalid"/"not enabled") | wrong-region(400/404 with
               "not supported in region" or DNS fail on the regional host) | network(timeout,
               ENOTFOUND, proxy 407, TLS) | unknown(status, redacted body). 10 s timeout via
               AbortController. Uses global `fetch` (Node 20 in the host). Injected `fetch` for tests.
  leakScan.ts  → M5 (not here).
src/health/checks/cred.*.ts   fill the M2 placeholders:
  cred.present   keychain has token → pass; else error, fix setToken. If the *file* has a token
                 and keychain doesn't → warning "Found a key in your settings file — import it?"
                 fix adoptToken.
  cred.mirrored  keychain token === file `env.AWS_BEARER_TOKEN_BEDROCK` → pass; file missing it
                 → error fix reapply (sync); file differs → warning, fix: choose "use the one in
                 the file" (adopt) or "use the one I entered" (overwrite via resetKeyPlan).
  cred.valid     last testConnection result (cached per window, re-run on demand + after
                 set/rotate) → pass/error with the classified plain-language label; `skipped`
                 "Not tested yet — click to test" until the user runs it once (never auto-call
                 AWS on every health run: §13 says two outbound request categories, both
                 documented; the test call is *user-initiated*).
  cred.age       setAt → warn ≥ manifest.credential.warnAfterDays (90), error ≥ failAfterDays (180).
  cred.leak      stays `skipped` until M5.
src/ui/flows.ts  setToken / rotateToken / clearToken / adoptToken / testConnection flows:
  setToken:   inputBox(password, ignoreFocusOut, prompt with console link + "choose a long-term
              key for a persistent setup; AWS recommends short-term keys for production — see
              README") → store.set → env.apply → writeThrough.sync → offer "Test connection now?"
              → rerun health.
  rotateToken: same as setToken; label differs; old value never shown.
  clearToken: confirm modal → store.clear → env.clear → writeThrough.sync(undefined) → rerun.
  adoptToken: read file value → store.set(now) → env.apply → resetKeyPlan for the token key →
              commit → rerun. (Age = adoption time, honest but conservative.)
  testConnection: progress notification → validate → result toast only when user-initiated;
              health node updated either way.
```

Redaction: M5 owns `util/redact.ts`, but M3 must register the token with it now (a
`redact.register(token)` / `unregister` pair called on every store change), so no log line from M3
can ever contain the value. The M5 test (§10.4 #1) then has something to bite on.

## Tasks

- [ ] `credential/shape.ts` + tests: table of accept/reject strings incl. real-shaped `ABSK…`,
      `bedrock-api-key-…`, `AKIA` + 16 uppercase, secret-key-looking 40-char base64, whitespace
      inside, leading/trailing whitespace (trim, accept), empty.
- [ ] `credential/store.ts` + tests on a fake SecretStorage (Map-backed, async): round-trip,
      setAt preserved, clear, corrupt JSON in the secret → treated as absent (and cleared),
      legacy plain-string secret (in case a future version changes shape) → migrated with setAt = now.
- [ ] `credential/env.ts` + tests on a fake collection: `persistent` set false before any replace;
      apply sets both vars; clear deletes both; constructing with a collection whose `persistent`
      can't be set false throws.
- [ ] `credential/writeThrough.ts` + integration test against a temp home: set → file has token
      at 0600; rotate → file updated, snapshot updated; clear → key removed, `CLAUDE_CODE_USE_BEDROCK`
      untouched; file token hand-edited → sync reports drift and does not overwrite.
- [ ] `credential/validate.ts` + tests with a fake `fetch`: each classification, timeout, no
      token in the error message (assert `!msg.includes(token)`), redacted body truncation.
- [ ] `cred.*` checks + tests on fake ctx (per M2 pattern).
- [ ] `ui/flows.ts` + `commands.ts` additions: `setToken`, `rotateToken`, `clearToken`,
      `testConnection`, `adoptToken` (new, not in PRD FR-6 — proposed). `package.json` contributes.
- [ ] `extension.ts` wiring: on activation, if keychain has a token → `env.apply` (terminal users
      get it in every new terminal); **never** auto-write the file on activation (autoApply=false).
- [ ] README: fill "Where your Bedrock API key is stored" (keychain canonical; mirrored in
      `~/.claude/settings.json` at 0600 because the panel can't read the keychain; inherited by
      every subprocess Claude Code spawns — FR-4.10) and "Network requests" (manifest fetch +
      user-initiated test call only). State the AWS long-term-key position and the admin cap.
- [ ] §10.4 assertions as tests: `persistent === false` (env.test), token never in
      `testConnection` errors (validate.test); the diagnostics assertion lands in M5.
- [ ] Manual walkthrough on this box against a temp `CLAUDE_CONFIG_DIR`, with a real short-term
      key if one is available (MC's AWS), else the fake-fetch path only — record which in the PR.
- [ ] DoD: `bun test` green; VSIX installs; set → mirrored → test → rotate → clear all pass in
      the Extension Development Host; Linux without libsecret degrades to an actionable
      `cred.present` error ("VS Code can't reach your system keychain") rather than a crash.

## Decisions to confirm before starting (assumption in bold)

- **Q-S** Adopt-from-file is in scope (new command `adoptToken`). `/setup-bedrock` makes
  "token in file, not in keychain" the *common* first-run state for anyone who tried the CLI
  wizard first. Without adoption the extension would nag them to re-enter a key they already have.
- **Q-T** `cred.valid` never auto-runs; it is `skipped` until the user clicks. The alternative
  (auto-test after set/rotate only) is acceptable — say which.
- **Q-U** Test call = `InvokeModel` on the **Haiku** ID with `max_tokens: 1`, per PRD. Known
  weakness: accounts without Haiku enabled get `model-not-enabled` although Sonnet works.
  Mitigation: if Haiku returns model-not-enabled, retry once with the Sonnet ID and report
  "works, but the small model isn't enabled — Claude Code will use Sonnet for background tasks".
- **Q-V** Age thresholds come from the manifest (`credential.warnAfterDays`/`failAfterDays`) —
  this is a **manifest schema addition** for M4; bundled copy carries 90/180.
- **Q-W** On activation we push the token into the terminal collection but do not touch the file.
  If the file's token is missing (user deleted it) that is a `cred.mirrored` error with a one-click
  fix, not a silent write.
- **Q-X** Headless/libsecret-absent Linux: SecretStorage throws on `get` → catch once, mark
  `keychainUnavailable`, and offer "store in settings file only" as an explicit degraded mode?
  **No for v1** — report the error and stop; degraded mode is a policy decision for MC.

## Risks specific to M3

- Token shape validation rejecting a real key: mitigated by permissive rules + an "Use it anyway"
  escape on the input box (`validateInput` returns a warning-severity `InputBoxValidationMessage`,
  not an error, for the `too-short` case).
- Two writers of the token key (us + `/setup-bedrock`): handled by drift + adopt, never by
  overwrite.
- The test call is the *only* place the extension sends the token anywhere. Keep it in one
  function, one host pattern (`bedrock-runtime.<region>.amazonaws.com`), with the URL built from
  validated region + model ID and no proxy config of our own (Node honours `HTTPS_PROXY` via
  VS Code's `http.proxy` settings when `http.proxySupport` is on — note in README).
