# Plan — M7 (README, first-run polish, pre-release publish)

Source of truth: `docs/PRD.md` §5A (naming, icon, trademark posture), §8 (build/CI auth), §9 (publishing runbook), §13 (trust posture), D8 (non-affiliation is a launch blocker).
Depends on everything. Branch: `feat/m7-release`. Status: **Parts A and B done 2026-09-11; Parts C and D blocked on MC's account work.**

## The framing

A new, unverified publisher asking non-technical users for an AWS credential is a legitimately suspicious thing, and §13 says to counter it by construction rather than by assurance. M7 is where the README stops being a stub and starts being the argument for trusting the extension. Everything in it must be checkable by a reader.

## Part A — the README, which is also the Marketplace listing page

- [x] **Above the fold**: what it does in two sentences, a screenshot of the panel, and the non-affiliation statement verbatim: *"An independent tool. Not affiliated with, endorsed by, or sponsored by Anthropic, PBC."* (D8 — load-bearing, because the mark sits mid-phrase in the name rather than in a detachable trailing descriptor.)
- [x] **What this extension writes** — already drafted in M2; verify it still matches the managed key list.
- [x] **Where your Bedrock API key is stored** — drafted in M3; must include FR-4.10 plainly: Claude Code passes credentials through the process environment, so every subprocess and MCP server it spawns inherits the token. Storage hardening does not change that; scope and rotation do.
- [x] **Network requests** — exactly two, both named with their URLs: the defaults manifest fetch, and the user-initiated Bedrock test call. No telemetry, and say so.
- [x] **Residual risk** — the leak scan's coverage and its limits; that a token already committed to git is in history and rotation is the only remedy.
- [x] **Uninstalling** — what is left behind (`~/.claude/sensible-defaults/`, the keychain entry) and how to remove it. A tool that writes to a config directory owes the reader an exit.
- [x] A short "why does this exist" that does not oversell: it configures, it does not proxy or run inference.

## Part B — icon and listing (§5A)

- [x] Replace the M0 placeholder. Constraints from §5A: no orange, no starburst, nothing resembling Anthropic's mark (differentiation *and* trade dress), not the default glyph, legible at 32px, a colour uncommon in Claude-adjacent listings. The current teal check-mark satisfies the letter of this; M7 decides whether it is good enough to ship or wants one deliberate pass.
- [x] `galleryBanner` colour + theme, `categories`, and a description that carries the search keywords while the title stays differentiated (§5A: search matches the full name and description regardless of sidebar clipping).
- [x] `CHANGELOG.md` written for humans, not commit-message dumps.

## Part C — publishing, which is mostly account work MC must do

Blocked on MC, and stated as blocked rather than worked around:
- [x] **Create the `cutler-sg` publisher in the Marketplace management portal.** *(MC, 2026-09-11.)* The verified badge needs the publisher account *and* the domain to be six months old; `cutler.sg` is verified live already, so the publisher account is the clock that has not started. Do this before anything else in M7.
- [ ] **Entra ID workload identity federation** — *repo side done 2026-09-11 (PR #12): managed identity not app registration, environment-bound credential, `allow-no-subscriptions`, one-shot `marketplace-identity` workflow prints the Azure DevOps profile id. Identity created 2026-09-11: RG `rg-sensible-claude-code-defaults` (southeastasia), UAMI `mi-marketplace-publish`, subscription `2b23a6e4-…`, tenant `87d76215-…`. Environment secrets `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` set on `marketplace-publish`. **Gotcha:** GitHub now presents the OIDC subject with numeric ids appended — `repo:cutler-sg@327464684/sensible-claude-code-defaults@1363995028:environment:marketplace-publish` — and Entra does exact matching, so the credential needs that exact string; the plain `repo:owner/name:environment:x` form from the docs fails with AADSTS700213. Both forms are registered. Identity workflow run succeeded and printed the Azure DevOps profile id; MC adds it as Contributor under Members.* Original note: for `vsce publish --azure-credential` (§8). Global Azure DevOps PATs retire 2026-12-01, ~11 weeks out; building the pipeline on a PAT means rebuilding it almost immediately. If a PAT is used as a stopgap it needs `Marketplace (Manage)` scope and **"All accessible organizations"** — the single-org default fails with an unhelpful error.
- [ ] **Open VSX namespace** via `ovsx create-namespace cutler-sg`, plus its GitHub-linked token.
- [ ] Register `cutler.sg` for eventual domain verification against the publisher.

## Part D — first release

- [ ] Ship `0.1.0` as `--pre-release` and dogfood it with known users before promoting (§9). There is no human review queue; the automated scan puts it live in minutes, and client-side auto-update is held ~2 hours for non-trusted publishers.
- [ ] Verify the `.vsix` one more time by hand: no `node_modules`, no source maps, the bundled manifest present, `extensionKind` absent.
- [ ] Tag `v0.1.0`; the release workflow publishes to both registries once the secrets exist.
- [ ] **Recommended before launch** (§5A): a short note to `usersafety@anthropic.com` describing what is shipping. Converts an unknown into a yes or an early no at zero cost, before installs and publisher verification accrue against the name. This is MC's call and MC's send.

## Decisions taken

- **Q-AI** Ship pre-release first, always. The first real install is the only test of the first-run flow that counts, and a pre-release channel makes a bad first version cheap to replace.
- **Q-AJ** The README states residual risk plainly rather than implying a security property the extension cannot provide (§13, FR-4.10). An audience that cannot evaluate the claim is exactly the audience owed the honest version.
- **Q-AK** No telemetry in v1, and the README says so as a commitment rather than an omission. Adding it later would require the opt-in, the disclosure and honouring `telemetry.telemetryLevel` (§13).
