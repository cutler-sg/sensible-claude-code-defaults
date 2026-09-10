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

## Network requests

## Residual risk
