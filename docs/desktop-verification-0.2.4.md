# 0.2.4 Linux desktop verification

Tested on 2026-09-28 using the packaged VSIX in VS Code 1.139.1, with Claude Code
2.1.283, on the existing Xvfb desktop at `DISPLAY=:99`. All interaction used
`xdotool`; screenshots used `scrot`. The editor ran at 120% zoom on a 1920×1080
display with disposable user data, extensions, and Claude configuration.

## Findings fixed

- The Create a key guide caused horizontal scrolling in a 362-pixel sidebar.
  Long URLs and diagnostic text now wrap without clipping.
- Dark High Contrast hid the active progress markers and primary button edges.
  The panel now uses the theme's progress color and button border.

Both fixes were rebuilt, installed from the VSIX, and retested in the desktop.
The installed JavaScript bundle matched the production build byte for byte.

## Observed behavior

| Journey | Result |
| --- | --- |
| Installation and activation | The Extensions UI shows 0.2.4 installed from VSIX. The Claude Code dependency installs automatically. |
| Fresh setup | Set up now opens step 1 with the masked key input focused and Continue disabled. |
| Invalid input | A synthetic AWS access key ID produces the specific wrong-key guidance and cannot continue. Typing does not discard the input. |
| Inline guide and keyboard | Tab/Space expands Create a key, with a visible focus indicator. The full console URL fits the narrow sidebar. |
| Plausible input | A synthetic Bedrock-shaped key enables Continue while remaining masked. Enter submits it. |
| Denied settings write | Removing write access to the disposable configuration directory produces actionable permission guidance and retains the input. Permissions were restored afterwards. |
| Retry and real network rejection | Continue retries without retyping. Amazon rejects the synthetic key; the panel shows the specific rejection and Try a different key returns to a focused, empty input. |
| Health and Details | Check Configuration renders all 18 check rows, with the rejected credential identified. Settings are readable and mode `0600`. |
| Region | Change region offers the supported choices. After confirming replacement, the isolated settings and the row tooltip both show `ap-southeast-1`. Cancelling leaves the original region alone. |
| Themes | Dark Modern, Light Modern, and Dark High Contrast render the guide, validation, focus, buttons, and progress correctly after the fixes. |

## Test boundaries

The initial editor launch inherited VS Code's global runtime arguments, which
selected plaintext secret storage despite isolated user data. That run is not
evidence of encrypted storage. The retest also isolated `argv.json` with
`VSCODE_PORTABLE` and selected `gnome-libsecret`. VS Code then reported that the
OS keyring was unavailable, while its SecretStorage fallback still allowed the
synthetic setup and connection-rejection flows to run. No security setting was
relaxed to make that pass. The extension's keychain-present row reflects a
successful SecretStorage read and does **not** prove persistent OS encryption in
this environment.

- [?] Verify encrypted credential persistence across a full editor restart
  (blocked: this desktop session has no available OS keyring).
- [?] Verify a successful Bedrock connection and an authenticated Claude session
  (blocked: no real credential was used in this automated desktop test).
- Physical Windows/macOS, corporate policy, remote-host, and screen-reader
  checks remain in [manual verification](manual-verification.md) and the
  [corporate-device checklist](corporate-device-retest.md).
- The external Amazon console was not opened in the user's browser session.

VS Code initially disabled the extension in Restricted Mode with its Claude Code
dependency. Trusting only the empty disposable workspace enabled it normally.
The final UI run used an empty editor window. Existing desktop sessions and real
credential/configuration files were not modified.

## Evidence and automated validation

Screenshots and test logs are saved locally under `out/desktop-qa-0.2.4/` and
delivered with the session response. Selected final screenshots:

- `final-dark.png`, `final-light.png`, `final-high-contrast.png`
- `final-write-recovery.png`, `final-rejected-key.png`, `final-details.png`

Lint, typecheck, and the full unit suite pass: 1,986 tests passed, two skipped.
The VSIX contains 11 files. CI and merge results are recorded on the accompanying
pull request and in the session handoff. This verification does not publish a
Marketplace release.
