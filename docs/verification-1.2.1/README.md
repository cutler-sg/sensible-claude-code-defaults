# Packaged desktop verification for 1.2.1

Completed on 2026-10-22 using the built stable 1.2.1 VSIX in VS Code 1.142.0
on Linux. The product bundle was checked byte-for-byte against the final
package. The fixture-only manifest dependency enabled the synthetic AWS
interceptor before product activation; no production package was modified.

## Isolation and method

The fixture lived at `/tmp/scd121-G4qmj5`, with separate portable data,
extensions, workspace, Claude settings, and harness directories. A dedicated
Xvfb display `:109` prevented focus contention with other desktop sessions.
Native mouse/keyboard input used `xdotool`; captures checked the fixture window
identity and explicitly selected that window. Native confirmation dialogs were
captured on the dedicated display. Both the fixture window and its window
manager were closed normally; Xvfb exited when its last client disconnected.

The only credential was `synthetic-desktop-model-check-token`. The existing
test harness intercepted all Bedrock requests. Electron required `--no-sandbox`
and the isolated profile used `--password-store=basic`; this does not verify
OS keyring encryption or prompts. No real profile, workspace configuration,
AWS credential, account entitlement, billing, or subscription was exercised.

## Results

| Scenario | Observed result |
| --- | --- |
| Initial setup | Short-key warning appeared; setup with the dummy key succeeded. Configured models were healthy while an optional upgrade required administrator enablement. |
| Upgrade consent | Preview showed exactly one Sonnet change and selected Cancel by default. Cancel preserved settings byte-for-byte. Apply changed only the Sonnet model ID from 5 to 5.5. |
| Backup on apply | The first backup matched the original settings byte-for-byte. Applying the upgrade in the same window preserved that backup. |
| Credential recovery | Rejected → recovered → offline showed “Could not verify Sonnet, Opus, Haiku”, with historical credential verification retained and current rows marked as connection/service failures. |
| Throttled recovery | A recovered credential followed by rate limiting retained authentication and showed inconclusive model access. |
| Newer rejection | A later rejection superseded the successful recovery and remained rejected through another offline check. |
| User drift | A custom Sonnet ID and edited unmanaged setting survived Apply byte-for-byte; Apply reported already up to date. |
| Restore | Confirmation restored the original settings byte-for-byte, backed up the replaced configuration, and cleared the snapshot's managed values. A fresh health check reported the missing settings key/configuration. |
| Undo restore | Restoring the newest backup recovered the pre-restore configuration byte-for-byte. |
| Isolation and logs | The synthetic workspace remained untouched. The extension output contained no warning/error log entries, uncaught failures, or dummy token. Health-check error counts matched the deliberately rejected/missing-configuration scenarios. |

Durable screenshots:

- [Upgrade preview and default Cancel](upgrade-preview.png).
- [Recovered credential with offline model checks](recovered-offline.png).
- [Newer rejection retained through offline checks](newer-rejection-offline.png).

The fixture's `shots/`, `ui-actions.jsonl`, `actions.jsonl`, `requests.jsonl`,
and VS Code output logs retain the full local sequence. These temporary files
are supplemental evidence and may not survive host cleanup. The three images
above and this report are committed for reviewers.

Recorded requests across the complete run:

| Synthetic scenario | Metadata | Inference |
| --- | ---: | ---: |
| Blocked upgrade | 6 | 5 |
| Available upgrade | 24 | 25 |
| Invalid credential | 4 | 0 |
| Offline | 12 | 6 |
| Throttled | 6 | 3 |

These counts include repeated checks and setup; they are not a per-check
request budget. The earlier interrupted `/tmp/scd-dependency-qa-20261022-Vgo9tF`
run is not counted as a completed pass. Two initial expectations in this run
were corrected against the documented implementation: backups occur once per
apply session, and restore clears snapshot values rather than deleting the
state file. The corrected byte-level assertions passed.

Expiry, context isolation, catalogue metadata changes, timestamp boundaries,
and restart persistence were verified by focused unit/service tests. Physical
platform, screen-reader, corporate-device, and live AWS checks remain as
described in [manual verification](../manual-verification.md).
