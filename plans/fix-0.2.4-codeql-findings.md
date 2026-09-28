# Resolve the first main-branch CodeQL findings before releasing 0.2.4

Branch: `fix/0.2.4-codeql-findings`
Authorization: Michael requested all fixes and merges needed to prepare the next
Marketplace release. This follows maintenance PR #39; 0.2.4 is not published.

## Acceptance criteria

- Version suffix parsing is linear and preserves normal version comparisons.
- The HTML security test detects script/style tags regardless of case.
- Regression tests fail on the old implementation, and the nonce assertion fails
  when the renderer emits an uppercase script tag without a nonce.
- Local validation and all PR checks pass; both CodeQL alerts become fixed on
  main after merging, without dismissals or scan exclusions.
- Rebuild and inspect the final 0.2.4 VSIX, retaining the VS Code 1.98 floor.

## Tasks

- [x] Investigate alerts #1 and #2 from the first main-branch CodeQL baseline.
- [x] Fix suffix parsing and the case-sensitive HTML assertion; verify regressions
  (completed 2026-09-28).
- [ ] Update release notes and validate tests, extension hosts, and packaging.
- [ ] Open/link a follow-up PR and record its CI/merge status on GitHub.

## Evidence

- Alert #1: `src/manifest/version.ts` uses `/[-+].*$/` on external version text.
  With repeated suffix markers followed by a newline and `.7`, 2k/4k/8k markers
  took approximately 5/17/68 ms and incorrectly affected the version ordering.
  A single-character delimiter search avoids the quadratic backtracking.
- Alert #2 is in a test, not the production HTML renderer: the script/style
  matcher omitted the case-insensitive flag and could skip an uppercase tag.
- PR #39's initial CodeQL check passed with no PR-context alerts. Only the first
  full main-branch analysis populated these pre-existing findings; completion
  requires checking the main-branch alert state, not only workflow success.
- Both multiline suffix cases failed against the original parser and pass with
  a single-character split limited to the version core. One million markers now
  compare correctly in approximately 1 ms without a timing-based unit assertion.
- Temporarily replacing the rendered script opening tag with `<SCRIPT>` made
  the nonce assertions fail as intended; the original renderer was restored.
- Lint/typecheck pass; the full unit suite passes 1,986 tests with two skips.
