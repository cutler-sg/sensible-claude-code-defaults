# Plan — M4 (defaults manifest: fetch, cache, fallback, validate)

Source of truth: `docs/PRD.md` FR-3, FR-5.6 `config.stale`, §13 (privacy: exactly two outbound request categories), §15 ("bad manifest bricks all users").
Depends on M2 (`config.stale` placeholder, `BUNDLED_MANIFEST`) and M3 (`credential` policy block already in the schema).
Branch: `feat/m4-manifest`. Status: **complete, 2026-09-11.** The layer landed first; the wiring below closed it out.

## Why this is the highest-blast-radius milestone after the merge engine

The manifest is the update channel. A malformed or hostile manifest reaches every user at once and, unlike the VSIX, is not gated by a Marketplace scan. Every rule below exists to make "the manifest is wrong" a no-op rather than an outage.

## Architecture

```
src/manifest/
  types.ts      Manifest + CredentialPolicy (exists)
  bundled.ts    the VSIX copy (exists) — the floor of the fallback chain
  schema.ts     validate(unknown) → {ok, manifest} | {ok:false, problems[]}
                Hand-written, no dependency: ~120 lines, and a dependency here
                is a supply-chain edge on the update channel itself.
  fetch.ts      fetchManifest({url, timeoutMs, fetch}) → Result
  cache.ts      CacheStore over a Memento: {manifest, revision, fetchedAt, url}
  resolve.ts    resolveManifest(deps) → { manifest, source, fetchedAt, problems }
                fetched → cached → bundled, first that validates
```

## Rules (FR-3, each one a test)

- [x] **FR-3.1** Bundled copy is the floor; it is validated at build time by a test, so a bad bundle fails CI rather than a user's window.
- [x] **FR-3.2** 5 s timeout. Any failure — offline, DNS, 5xx, TLS, abort — falls back **silently**. Never a toast, never an error; it becomes an info-level `config.stale`-adjacent note ("Using saved defaults from <date>").
- [x] **FR-3.3** Cache in `globalState` with `fetchedAt`. Re-fetch at most once per hour per window; a manual "Check for updates" bypasses the throttle.
- [x] **FR-3.4** Validate **before** use. A manifest that fails the schema is discarded in favour of the cache, and the problems are logged (not shown). Validation must reject: wrong `schemaVersion`, missing/mistyped `defaults.env` values (all must be strings — Claude Code reads them as env vars), non-string entries in `permissions.deny`, `regions` not a non-empty string array, `credential.warnAfterDays >= failAfterDays`, a `consoleUrl` that is not `https:`, and any `extraKnownMarketplaces` source that is not `{source:'github',repo:'owner/name'}` or `{source:'url',url:'https://…'}`.
- [x] **FR-3.5** `minExtensionVersion` gate: if the manifest demands a newer extension, keep the previous defaults and raise a warn-level check prompting an update. Reuse `compareVersions`.
- [x] **Size and shape guards** (not in the PRD, but the update channel needs them): refuse a body over 256 KiB; require `content-type` to be JSON-ish or absent; refuse a redirect to a different origin.
- [x] **`notices`**: render at most the first 2 unexpired notices as info checks. An `expiresAt` in the past is dropped. Notice text is untrusted remote content — it is displayed, never executed, never used as a command id or URL. Cap length at 200 chars and strip control characters.

## Tasks

- [x] `schema.ts` + tests: one test per rejection above, plus a round-trip of the bundled manifest, plus a fuzz-ish table of wrong-typed fields at every path.
- [x] `fetch.ts` + tests with an injected `fetch`: 200 valid, 200 invalid JSON, 200 valid JSON that fails the schema, 304, 404, 500, timeout, DNS error, TLS error, cross-origin redirect, oversized body, non-JSON content-type. **None of these may throw.**
- [x] `cache.ts` + tests: round-trip, corrupt cache entry → treated as absent, cache from a different `url` → ignored (the setting can change).
- [x] `resolve.ts` + tests: the whole chain, including "fetched is invalid → cached wins", "cached is invalid → bundled wins", "fetched requires a newer extension → previous wins + warning", throttle honoured, manual refresh bypasses it.
- [x] `config.stale` check: info when the applied snapshot's `manifestRevision` is behind the resolved manifest's; fix = `applyDefaults`. Also an info check for "using saved/bundled defaults" naming the date (FR-3.2), and warn for the `minExtensionVersion` gate (FR-3.5). PRD §16 Q5 asks whether a >30-day-stale manifest should escalate above info: **assume no** — it is not the user's fault and there is nothing they can do about it.
- [x] New command `sensibleDefaults.checkForUpdates` (title "Check for Updated Recommendations") that bypasses the throttle, re-resolves, reruns health.
- [x] Wire into `extension.ts`: resolve once on activation (fire-and-forget, panel renders from cache immediately per §13), re-resolve on the hourly boundary when a health run happens, pass the resolved manifest into the runner instead of `BUNDLED_MANIFEST`.
- [ ] Publish the manifest itself: `manifest/defaults.json` is served from the repo's `main` via `raw.githubusercontent.com` (PRD §16 Q1 leans this way). Add a CI job that validates `manifest/defaults.json` against `schema.ts` on every push so a bad manifest cannot reach `main`.
- [ ] README "Network requests" section updated with the manifest URL and the fact that it carries no identifiers.

## Blocker found on 2026-09-11: the manifest URL 404s while the repo is private

`manifest/defaults.json` is now committed on `main` (39ccd62), but
`raw.githubusercontent.com` serves 404 to anonymous requests for a private
repository, and the extension fetches it unauthenticated by design — it holds no
GitHub credential and must not.

Verified against the live URL: `fetchManifest` returns
`{kind: "failed", reason: "http-status", status: 404}` and `resolveManifest`
falls through to `source: "bundled"` with a usable manifest, silently, exactly
as FR-3.2 requires. So nothing breaks. But every install would sit permanently
on the bundled copy, which makes the whole update channel inert — the thing M4
exists to build.

**Resolution required before any release (MC's call, one of):**
1. Make the repository public. It ships publicly anyway (D1), the PRD's §13
   trust posture explicitly wants a public repository, and this is the cheapest
   fix.
2. Serve the manifest from `cutler.sg` instead, which is already verified and
   hosting the future landing page. Changes `sensibleDefaults.manifestUrl`'s
   default and revisits Q-Y, but keeps the repo private if that is wanted.

Until one of these happens the fallback chain is doing its job and the panel
says "using built-in defaults" honestly, which is the correct behaviour for a
channel that is not yet reachable.

## Decisions taken (assumption in bold, all reversible)

- **Q-Y** GitHub raw hosting for v1 (PRD Q1). Free, versioned, auditable, and the rate limit is irrelevant at one fetch per hour per window. Revisit if install counts make it a problem.
- **Q-Z** No conditional requests (`If-None-Match`) in v1. `raw.githubusercontent.com` sends an ETag, but honouring it adds a code path for a saving that does not matter at this volume. Cache by time only.
- **Q-AA** Notices are capped at 2 and are info-level only. A remote channel that can raise an error-level item in every user's panel is a bigger lever than this project needs.
- **Q-AB** §16 Q5: a stale manifest never escalates above info.
- **Q-AC** The per-window state `resolveManifest` refuses to own lives in `src/ui/manifestHolder.ts`: the held resolution and `lastAttemptAt`, written back after every call. The holder is `vscode`-free (the URL and clock are injected), which is what makes the throttle testable by counting fetches rather than by trusting the assignment.
- **Q-AD** FR-3.2, FR-3.5 and the applied-revision check are **one** `config.stale` row with four branches, ordered by what the user can act on (extension update → apply → honest note → pass). Three rows about the manifest, only one of which is ever interesting, is three rows nobody reads.
- **Q-AE** Notices are synthesised in `runAll` and appended to the report, not registered in `ALL_CHECKS`: there are between zero and two per run and their ids are positional (`notice.0`). They render in Configuration beside `config.stale`, always at info level whatever the notice declares, and never carry a fix.
- **Q-AF** The manifest reaches the runner, the commands and the flows as a **getter**, not a value. The bug this avoids is silent: a value captured at wiring time leaves the panel checking against — and `applyDefaults` writing — the copy that shipped in the VSIX, for the life of the window.
