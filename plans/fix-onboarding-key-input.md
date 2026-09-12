# Fix onboarding key entry

Branch: `fix/onboarding-key-input`

## Acceptance criteria

- A pasted or typed key survives validation and background health refreshes.
- Continue and Enter submit the current key and advance to the connection result.
- Invalid input and save failures remain actionable; no token is echoed into HTML, outbound state, or logs.
- Reproduce the 0.2.0 failure and verify the repair in a real VS Code window using synthetic credentials and isolated user/config directories.
- Demonstrate Linux desktop access and document the working display and control requirements.

## Tasks

- [x] Trace the 0.2.0 failure and inspect the available X11/VNC displays.
- [x] Reproduce the failure in the actual VS Code webview.
- [x] Preserve the input DOM during feedback updates and add lifecycle regression coverage.
- [x] Consolidate filesystem failure reporting and prevent connection tests from hiding unreadable settings.
- [x] Add opt-in Windows integrated-terminal PATH repair using the registered extension directory; preserve existing CLI installations and corporate execution controls.
- [x] Provide actionable TLS/proxy guidance without importing untrusted certificates or disabling verification.
- [x] Verify the repaired UI, run lint/typecheck/tests/package, and leave a reviewable change.

## Findings

- `key.changed` calls `paint()`, which assigns `webview.html` and destroys the input.
- The provider-only tests assert the new HTML but never execute it, so they miss input loss.
- Successful sidebar saving also awaited dismissal of a toast before advancing. The sidebar now suppresses that redundant toast, with a regression that leaves notification promises pending.
- `DISPLAY=:0` rejects this session's X11 authorization; `:99` is accessible and is the display served by the running x11vnc process on port 5900.
- T3 preview status/open both report that no automation host is available in this environment.
- The repaired VSIX retained synthetic input and surfaced a real permission-denied error on the isolated VNC desktop. No real credentials were used.
- Windows terminal repair must resolve the extension through VS Code, not pick the newest directory. It applies only to new integrated terminals; external shells require an IT-approved standalone CLI installation. No global launcher or registry/PATH writes are part of this candidate.
- Certificate errors are evidence of a trust/connection problem, not proof of a particular inspection vendor. Automatic extraction and trust of a server-supplied CA is deliberately excluded.

## Validation and handoff

- Frozen install, lint, typecheck, DOM/unit suite (1,947 passed, one existing skip) and VSIX packaging pass locally.
- Test candidate: `sensible-claude-code-defaults-0.2.1-candidate.vsix` (unpublished).
- Both input loss and the notification-dismissal stall were reproduced in real VS Code. The test directory's permissions have been restored to 0700.
- The installed 0.2.1 candidate retains the masked synthetic key and shows secure-save progress while VS Code waits on its OS keyring. A complete native credential-storage test is not claimed on this desktop.
- Native Windows, actual corporate policy and authenticated Bedrock success require the retest in `docs/corporate-device-retest.md`; Linux screen automation is not a substitute.
- CI, permissions and publishing configuration remain unchanged. No merge, release or push to main is authorized.
