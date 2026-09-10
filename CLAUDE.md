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

## Current milestone
M0 and M1 only (see §11). Do not scaffold beyond what these need.

## Stack
TypeScript, esbuild single-file bundle, Node 22, @vscode/vsce, ovsx.
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
