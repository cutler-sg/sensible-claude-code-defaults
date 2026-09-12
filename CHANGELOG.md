# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.2] - 2026-09-12

### Fixed

- Windows permission exports support UTF-16 with or without an encoding marker. Empty, malformed and failed exports remain warnings, never a false all-clear.
- Permission failures include actionable diagnostics instead of a repeated "Make private" action. Repairs verify each Windows command and keep inherited access if granting the current user fails.
- Permission checks refresh without waiting for notification dismissal.

### Added

- **Sensible Defaults: Open Claude Terminal** launches the verified executable directly on Windows. Available from the Sensible Defaults view title and Command Palette, it avoids the PATH mismatch affecting Claude Code's own launcher without modifying that extension, system PATH, shell profiles or security policy.
- Native Windows ACL and terminal-process regression coverage, alongside encoding and restricted-device tests.

## [0.2.1] - 2026-09-12

### Fixed

- Key validation and background checks no longer replace the input field. Continue and Enter preserve the pasted key through save failures.
- Sidebar setup no longer waits for dismissal of a success notification before testing the connection. Secure saves show progress and prevent duplicate submissions.
- File-access, storage, keychain and watcher failures have actionable recovery messages. Failed health checks replace the loading screen; diagnostics distinguish inaccessible settings from absent settings.
- Connection tests refuse malformed or unreadable settings instead of testing a silently substituted region. Certificate and proxy-authentication failures have distinct guidance.

### Added

- Opt-in Windows integrated-terminal repair using the registered Claude Code extension's verified binary. It preserves existing commands, refreshes after extension changes, and has a disable command. No launcher files or system PATH changes.

## [0.2.0] - 2026-09-11

### Added

- **A guided setup in the sidebar.** The panel is now the whole experience for
  a non-technical user: *Set up now*, paste the key (with a live check that it
  looks like one, a show/hide toggle, and a *Create a key* walkthrough that
  opens the right console page), then watch it test. Every outcome is one
  sentence and one button. Once set up, the panel shows a single line — working,
  or the one thing to fix — with the full check list behind *Details*.
- The region is chosen for you. The recommended models use Amazon's global
  inference profiles, which work from any region, so the setup no longer asks;
  *Change region* stays as a link for anyone who needs a specific one.

### Changed

- The check tree moved behind the panel's *Details* disclosure. Nothing was
  removed; it is one click further from the person who never needed it.

## [0.1.1] - 2026-09-11

### Changed

- The recommended models now use Amazon's **global** inference profiles
  (`global.anthropic.…`) instead of the US-only ones. They work from every
  commercial region — the US-only form does not exist in Singapore, Tokyo,
  Mumbai or most of Asia-Pacific — and Claude Code itself falls back to the same
  prefix outside the US and EU. The README says what you lose (a data-residency
  guarantee, GovCloud) and how to pick a regional form instead.

### Fixed

- When *Test Bedrock Connection* hits a response it cannot classify, the Output
  channel now records the HTTP status alongside "unknown", so the next such
  report can be diagnosed from the log alone.
- The activity bar entry had no icon. The glyph file was removed as unused in
  the release prep, because nothing in the code references it — VS Code resolves
  the path at runtime. A test now checks that every icon the manifest points at
  exists on disk.

## [0.1.0] - 2026-09-11

First release, published as a pre-release. It sets up Claude Code to run on AWS
Bedrock and then keeps checking that the setup still works.

### Getting set up

- **Apply Recommended Configuration** writes a working Bedrock setup to your
  user-level `~/.claude/settings.json`: the Bedrock switch, an AWS region, the
  three model names, and a small list of actions Claude Code should refuse
  outright. Nothing is ever written inside a project folder.
- Every change is shown as a preview before it happens, and the previous file is
  copied to `~/.claude/sensible-defaults/backups/` first. **Restore Previous
  Configuration** puts any of the last ten copies back.
- Your own settings survive it. The merge touches the nine keys it manages and
  leaves the rest of the file — including its key order and indentation —
  exactly as you had it.
- **Change AWS Region** picks from the regions where the models are available.

### Your Bedrock API key

- **Set Bedrock API Key** stores the key in your editor's secret storage, backed
  by Keychain on macOS, DPAPI on Windows and the login keyring on Linux, and
  copies it into `settings.json` so the Claude Code panel can find it. Integrated
  terminals are handed the key directly and never read it from disk.
- **Test Bedrock Connection** calls Bedrock once and tells you what it found: a
  key Amazon refused, a key that works but lacks permission to use Claude, models
  that are not switched on for your account, or a region that does not have them.
  Each of those is a different sentence, because each has a different fix.
- **Update** and **Remove Bedrock API Key** rotate and clear the key everywhere
  it is held at once. If you set your key up with Claude Code's own
  `/setup-bedrock`, the panel offers to adopt it rather than making you find it
  again — and if it finds two different keys, it asks rather than choosing.
- A reminder to replace the key appears after 90 days, and becomes an error at
  180.

### Knowing something is wrong

- A **Configuration Health** panel in the activity bar checks the installation,
  the settings and the credential, and says what is wrong in a sentence you can
  act on rather than a status code.
- It notices when Claude Code changes a setting this extension manages — its
  `/setup-bedrock` command and its model prompt both do — and reports the
  difference instead of silently overwriting it. *Reset to Recommended* is there
  when you want the recommendation back.
- It watches `settings.json`, so a change made outside VS Code shows up without
  you re-running anything.
- If your settings file becomes readable by other users of the machine, it is
  quietly made private again, on Windows as well as macOS and Linux.
- After you save a key, your open project folders are checked for a copy of it —
  the `.env` a tutorial told you to create. A scan that runs out of time says so
  rather than reporting a clean bill of health, and a key found in a file that
  git is tracking comes with the only advice that works: replace the key.

### Getting help

- **Copy Diagnostics for Support** puts a full report of your setup on the
  clipboard — paths, versions, your settings file, the check results and the last
  50 log lines — with your API key and anything else resembling a credential
  replaced by `«redacted»`. It is safe to paste into a public issue.

### Staying current

- The recommended settings are fetched from a published manifest at most once an
  hour, so a new model id or region does not need an extension update. The copy
  inside the extension is the floor: if the fetch fails, the last good copy is
  used, and the panel says which one is in force.

### Notes

- Works wherever Claude Code does — including WSL, Remote-SSH and dev containers,
  where it configures the machine Claude Code actually runs on rather than the
  one your screen is attached to.
- No telemetry, no analytics, no crash reports. The two network requests it does
  make are documented in the README.
