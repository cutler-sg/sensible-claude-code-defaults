# Corporate-device retest candidate

The local VSIX is version **0.2.1**, an unpublished test candidate. Install with
VS Code's **Extensions: Install from VSIX**, then **Developer: Reload Window**.
Do not install it on a device unless its software policy permits it.

## One-pass Windows checklist

- On a fresh setup, paste a Bedrock key. The green format hint must leave the
  masked input intact. Continue and Enter must show secure-save progress, then a
  connection result without requiring dismissal of a success notification.
- Complete any Windows secure-storage prompt. If storage is blocked, setup must
  retain the input and explain how to recover. Do not bypass enterprise policy.
- Confirm the key and settings work in the Claude Code sidebar and with an actual
  Claude session. A format check or `--version` alone is not proof of authentication.
- In Details → Installation, use **Enable in VS Code terminals**, or the equivalent
  command-palette command. Accept the explanation and open a new PowerShell
  terminal. Run `Get-Command claude` and `claude --version`, then try Claude Code's
  *Launch in terminal*. Repeat in a new cmd terminal with `where claude` and
  `claude --version`. Do not paste credentials into terminal commands.
- Existing CLI or `.cmd`/`.bat`/`.ps1` launchers must be left alone. A found-but-blocked
  executable must not trigger an override. Shell aliases and profile PATH changes
  can differ from the extension-host environment; terminal verification is required.
- Reload VS Code and repeat the command probe. After a Claude Code extension update,
  open a new terminal and confirm the old extension directory is no longer needed.
- Disable the terminal repair and reopen terminals. External shells and the system
  PATH must remain unchanged throughout. No Windows binaries should be injected
  into WSL/remote Linux terminals.
- With IT's help, test denied settings/history writes using a disposable settings
  directory, not your working configuration. Setup must report the failure without
  claiming success or testing a fallback region. Restore access and retry.
- Test the real corporate network. TLS errors and proxy sign-in requirements must
  get distinct guidance. Copy diagnostics if either fails; do not post credentials,
  certificate private keys, proxy credentials, or unreviewed corporate details.

## Certificate trust and proxies

Claude Code currently documents system-store trust alongside its bundled roots.
The native installer supports this; npm installations require an appropriate Node
runtime (`tls.getCACertificates`, introduced in Node 22.15). An IT-installed root
may therefore be sufficient without exporting another certificate file.
[Claude Code enterprise network configuration](https://code.claude.com/docs/en/network-config)

If IT requires `NODE_EXTRA_CA_CERTS`, use the **IT-approved public CA bundle**, not
a certificate copied from an unverified connection. Node reads that variable at
process startup, so affected processes need restarting. A Claude settings entry
does not retroactively change TLS trust in the already-running VS Code extension
host. Verify Claude and this extension's connection test separately.
[Node documentation](https://nodejs.org/api/cli.html#node_extra_ca_certsfile)

This candidate classifies TLS/proxy failures and alerts the user; it does not
automatically identify Zscaler, extract/import CAs, rewrite trust settings, set
`NODE_TLS_REJECT_UNAUTHORIZED=0`, or bypass application controls. Proxy environment
variables and issuer names alone are not proof of interception. Automatic CA
provisioning remains dependent on an explicit enterprise trust policy and approved
source; guessing would turn a connectivity repair into a trust vulnerability.

## Windows implementation boundary

The extension resolves `anthropic.claude-code` through VS Code's extension registry,
not by sorting versioned installation folders. The known relative binary path is
validated and probed with a bounded direct `--version` call. A changed package
layout fails visibly. The PATH directory is appended through the nonpersistent
terminal environment collection, never written into a random writable directory.
No executable files, shell profiles, registry entries or global PATH values are
created or changed. No separate launcher needs quoting or lifecycle management.

This uses an internal binary layout, not a public launcher contract. Anthropic's
supported route for terminal use remains the standalone CLI installation.
[Anthropic VS Code documentation](https://code.claude.com/docs/en/vs-code#run-cli-in-vs-code)

## Linux desktop evidence and limitations

- The shared desktop on `hwi` is Xvfb `DISPLAY=:99`, served by the existing VNC
  process. `:0` rejected this session's X11 authorization; access controls were not
  changed. Use `scrot` for screenshots and `xdotool` for pointer/keyboard actions.
- The real 0.2.0 webview reproduced the disappearing input and inert Continue.
- The repaired webview retained synthetic input and displayed a genuine
  permission-denied failure. The test directory's permissions were restored.
- The desktop also exposed an OS-keyring prompt and the success-notification wait.
  Only synthetic credentials were used. This is not evidence that corporate DPAPI,
  policies, real credentials or the corporate TLS path work.
- Automated DOM tests execute the actual webview script, including pending
  notifications, secure-save progress, retries and background refresh failures.
  Windows path/command cases use injected dependencies on Linux; native Windows
  terminal and corporate controls still require the checklist above.

For desktop testing, use isolated `--user-data-dir`, `--extensions-dir`, and
`CLAUDE_CONFIG_DIR` locations. Never disable X11 authorization or OS encryption to
make a test pass, and never use a real key in automated input or screenshots.
