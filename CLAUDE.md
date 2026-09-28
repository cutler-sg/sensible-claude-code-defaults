# Sensible Claude Code Defaults

A public VS Code extension that manages Claude Code configuration on AWS Bedrock
for non-technical users: sensible defaults, a health-check panel, and guided
credential entry.

## Read this first
`docs/PRD.md` is the source of truth. Read it end to end before writing code.
Pay particular attention to:
- §14 — decisions already closed. Do not re-derive these.
- §17 — externally verified facts about Claude Code. Re-verify against current
  docs before coding against them; do not substitute recalled knowledge.
- §5 FR-2 — the merge engine. Highest-risk area in the project.

## Current state
The extension is published on the VS Code Marketplace as a stable release
(from 0.2.6; odd minor versions go to the pre-release channel). M0–M8
implementation has shipped; this is maintenance work, not an initial scaffold.
Use `CHANGELOG.md` and the current branch's plan in `plans/` for release scope.
Historical milestone checklists are implementation records, not the live backlog.
Manual platform checks remain in `docs/manual-verification.md`; Open VSX setup
is still pending. See `docs/releasing.md` before tagging a release.

## Stack
TypeScript, Bun, esbuild single-file bundle, Node 22+, @vscode/vsce, ovsx.
No native modules — they must match VS Code's Electron ABI.

## Hard rules
1. Never write inside a workspace folder. User profile only (`~/.claude`).
   No `.claude/settings.json`, no `.claude/settings.local.json`. Ever.
2. All writes to `settings.json` are temp-file-then-rename, mode 0600.
   A truncated settings.json breaks Claude Code for a user who cannot recover.
3. Never overwrite a managed key whose current value differs from the
   last-applied snapshot. Preserve and report as drift.
4. The Bedrock token is never logged, never in an error message, never in
   diagnostics output. All output goes through util/redact.ts.
5. Do not set `"extensionKind": ["ui"]` in package.json. The extension host
   must run on the same side as the Claude Code binary (WSL, Remote-SSH).
6. Security assertions in §10.4 are tests, not review items.

## Working style
Write the test alongside the code, not after. For FR-2.2 specifically, every
row of the merge table is a test case before the implementation lands.
