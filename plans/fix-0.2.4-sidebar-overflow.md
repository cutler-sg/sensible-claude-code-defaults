# Desktop verification of 0.2.4

Branch: `fix/0.2.4-sidebar-overflow`
Authorization: Michael requested fixes and merges for the next Marketplace
release, followed by computer-use testing in VS Code on `DISPLAY=:99`.

## Acceptance criteria

- The setup guide fits a narrow sidebar without horizontal scrolling.
- Primary buttons and active progress markers remain visible in high contrast.
- The rebuilt 0.2.4 VSIX is tested in the real VS Code desktop using isolated
  user data, extensions, and `CLAUDE_CONFIG_DIR` directories.
- Screenshots document actual validation, recovery, and theme behavior.
- Synthetic credentials are the only test input; successful live Bedrock
  authentication and physical-platform checks are not claimed.
- Local validation and GitHub checks pass before merging.

## Tasks

- [x] Reproduce the console URL overflow in the installed release candidate.
- [x] Wrap long panel text and use the theme's button border and progress color.
- [x] Retest the packaged extension and record evidence and limitations.
- [x] Run lint, typecheck, the full unit suite, and production packaging.
- [x] Prepare the PR and validation handoff. CI and merge outcomes are tracked
  in the PR and session summary; merge only after GitHub checks pass.

## Evidence

At 120% VS Code zoom, a 362-pixel sidebar clips the console URL in the expanded
Create a key guide and gains a horizontal scrollbar. The URL contains a segment
longer than the available line; the panel stylesheet does not permit breaking it.
Wrapping long text also accommodates diagnostic paths without hiding content.

Dark High Contrast uses a black button background and a separate button border.
The panel removed that border and reused the button background for progress,
making the active markers invisible. The fix uses the appropriate theme tokens.

The desktop observations and secure-storage limitations are recorded in
`docs/desktop-verification-0.2.4.md`. The final suite passes 1,986 tests with two
skips; the 11-file VSIX was installed and tested after both styling changes.
