# Sensible Claude Code Defaults

A VS Code extension that sets up and continuously health-checks a working Claude
Code configuration on AWS Bedrock. It writes a small, well-defined set of keys to
your user-level `~/.claude/settings.json`, keeps your Bedrock API key in the OS
keychain, and tells you plainly when something is wrong — a missing region, an
ageing credential, a setting that drifted.

## Independence

An independent tool. Not affiliated with, endorsed by, or sponsored by Anthropic, PBC.

## What this extension writes

Everything is written to your **user profile**, never inside a project folder:

| What | Where |
|---|---|
| Settings | `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`) |
| Backups (10 most recent) | `~/.claude/sensible-defaults/backups/` |
| Record of what we last wrote | `~/.claude/sensible-defaults/state.json` |

Inside `settings.json` it manages a short, fixed list of keys and leaves the rest
of the file — including your own settings, ordering, and indentation — untouched:

- **Use AWS Bedrock** — tells Claude Code to talk to AWS instead of Anthropic directly.
- **AWS region** — which AWS region your Bedrock models are called in.
- **Opus / Sonnet / Haiku model** — which model each of the three sizes maps to.
- **Bedrock API key** — your credential. Kept in your operating system's keychain;
  the copy here is what Claude Code actually reads.
- **Blocked actions** — a small baseline list of things Claude Code should refuse
  to do without asking.
- **Plugin marketplaces** and **enabled plugins** — registered once, so plugin
  updates arrive without the extension touching your settings again.

Before any change you get a preview listing every line that will change, and a
copy of the previous file is saved to the backups folder above. `Restore Previous
Configuration` puts any of those copies back.

**Claude Code writes some of these keys too.** Its own `/setup-bedrock` command
and its model-selection prompt write the region and the model names directly. The
extension does not fight that: when a managed value no longer matches what it last
wrote, the panel reports it — "Claude Code changed the Opus model" — and leaves the
value alone. Use *Reset to Recommended* on that row if you want the recommended
value back; nothing is overwritten until you do.

## Where your Bedrock API key is stored

Your key lives in **your operating system's keychain** — Keychain on macOS,
Credential Manager on Windows, the login keyring on Linux. That copy is the
real one: it is what *Set Bedrock API Key* writes, what *Update Bedrock API Key*
replaces, and what the age reminder measures.

It is also written into `~/.claude/settings.json`, at mode `0600` (readable only
by you). That second copy is not optional and not an oversight:

- The **Claude Code panel** inside VS Code starts its program from VS Code
  itself, and a program cannot read your keychain. The settings file is the only
  place it can find the key.
- Integrated **terminals** get the key a different way — the extension hands it
  to each new terminal directly, so a terminal never reads it from disk.

*Remove Bedrock API Key* clears all three at once: keychain, settings file, and
terminals. It does not cancel the key at Amazon — do that in the Bedrock console
if you want it to stop working everywhere.

If you already ran Claude Code's own `/setup-bedrock`, your key is in the
settings file but not the keychain. The panel offers **Use the key from my
settings file**, which saves it to the keychain without making you find it again.
If the two ever hold *different* keys, nothing is overwritten: the panel asks
which one you want.

### What this does not protect against

Claude Code passes credentials to everything it starts through the process
environment. **Every program Claude Code launches — every tool, every MCP
server, every command it runs on your behalf — inherits your Bedrock API key.**
Storing the key in a keychain does not change that, and no setting in this
extension can.

What actually limits the damage is the key itself: how much it is allowed to do,
and how long it lasts.

- Give the key access to Bedrock and nothing else.
- Prefer a key with an expiry. AWS recommends short-term keys for production
  use; a long-term key is more convenient for a setup you want to keep working,
  which is why this extension accepts either.
- Replace it periodically. The panel reminds you after 90 days and insists after
  180.
- If you administer the AWS account, cap key lifetime centrally with
  `iam:ServiceSpecificCredentialAgeDays` rather than relying on people to rotate.

## Network requests

This extension makes exactly two kinds of outbound request, and no others. It
sends no telemetry, analytics, or crash reports.

| Request | When | What is sent |
|---|---|---|
| Test your Bedrock API key | Only when you click *Test Bedrock Connection* | Your key, to Amazon, over HTTPS |
| Fetch the recommended settings *(not yet — a later update)* | On startup and when you re-check | Nothing but the request itself |

Today the recommended settings ship inside the extension, so the test call is
the only request it makes at all.

The test call is the only time the extension sends your key anywhere. It goes to
Amazon's Bedrock endpoint for your configured region and nowhere else, asks for
a single token of output, and reports only whether it worked. Nothing about the
answer — including any error text Amazon returns — is logged or shown to you
verbatim.

Both requests honour VS Code's proxy settings (`http.proxy`,
`http.proxySupport`); the extension has no proxy configuration of its own.

