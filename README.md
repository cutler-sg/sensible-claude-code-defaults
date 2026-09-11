# Sensible Claude Code Defaults

[Install from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=cutler-sg.sensible-claude-code-defaults)

Sets up Claude Code to run on AWS Bedrock, then keeps checking that the setup
still works. It writes a short, fixed list of keys to your own
`~/.claude/settings.json`, keeps your Bedrock API key in your computer's
keychain, and tells you plainly when something is wrong — a missing region, an
ageing key, a setting that drifted.

<!--
  Screenshot of the health panel goes here as `media/panel.png`, captured from a
  real window rather than mocked up. Not committed yet; this comment is the
  placeholder rather than a broken image link.
-->

**An independent tool. Not affiliated with, endorsed by, or sponsored by
Anthropic, PBC.**

## Getting started

Click the wrench-and-tick icon in the activity bar on the left. The panel
that opens does the rest:

1. **Set up now.** One button.
2. **Paste your Bedrock API key.** If you don't have one yet, *Create a key*
   opens the exact page in the Amazon console and tells you which tab to use.
   The panel says where the key goes before you continue.
3. **Watch it test.** The panel asks Amazon whether the key works and tells
   you in one sentence, with one button for whatever comes next.

That is the whole setup. Afterwards the panel shows a single line — everything
working, or the one thing that isn't and the button that fixes it — with the
full list of checks behind *Details* for whoever is helping you. Every panel
action is also in the command palette under *Sensible Defaults*, for people who
prefer it.

## What this extension writes

Everything is written to your **user profile**, never inside a project folder:

| What | Where |
|---|---|
| Settings | `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`) |
| Backups (10 most recent) | `~/.claude/sensible-defaults/backups/` |
| Record of what we last wrote | `~/.claude/sensible-defaults/state.json` |

Inside `settings.json` it manages nine keys and nothing else. The rest of the
file — your own settings, their order, your indentation — is left exactly as it
was. Here is the whole list, with what the defaults that ship inside the
extension set each one to:

| The key in `settings.json` | What it is | Shipped default |
|---|---|---|
| `env.CLAUDE_CODE_USE_BEDROCK` | Talk to AWS instead of Anthropic directly | `"1"` |
| `env.AWS_REGION` | Which AWS region your Bedrock models are called in | `us-east-1` |
| `env.ANTHROPIC_DEFAULT_OPUS_MODEL` | Which model "Opus" means | `global.anthropic.claude-opus-5` |
| `env.ANTHROPIC_DEFAULT_SONNET_MODEL` | Which model "Sonnet" means | `global.anthropic.claude-sonnet-5` |
| `env.ANTHROPIC_DEFAULT_HAIKU_MODEL` | Which model "Haiku" means | `global.anthropic.claude-haiku-4-5-20251001-v1:0` |
| `env.AWS_BEARER_TOKEN_BEDROCK` | Your Bedrock API key | your key, never anything of ours |
| `permissions.deny` | Things Claude Code refuses outright, without asking you | `Bash(rm -rf:*)`, `Read(./.env)`, `Read(./.aws/**)` |
| `extraKnownMarketplaces` | Claude Code plugin marketplaces to register | nothing — the key is there so a forked manifest can add some |
| `enabledPlugins` | Claude Code plugins to turn on | nothing, for the same reason |

The model ids use Amazon's **global** inference profiles, which route each
request to whichever AWS region has capacity. That is the only form of these
models that works from every commercial region — in Singapore, Tokyo, Mumbai
and most of Asia-Pacific there is no regional alternative — and Claude Code
itself falls back to the same `global.` prefix outside the US and EU. Two
things it does not give you: a data-residency guarantee, and GovCloud. If your
organisation needs requests kept inside one geography, change the three model
ids to the `us.`, `eu.`, `au.` or `jp.` form of the same name; the health check
carries on working with whichever you pick.

Both lists are checkable: the nine keys are `MANAGED_KEYS` in
[`src/config/types.ts`](src/config/types.ts), and the values are
[`manifest/defaults.json`](manifest/defaults.json).

Before any change you get a preview listing every line that will change, and a
copy of the previous file is saved to the backups folder above. *Restore
Previous Configuration* puts any of those copies back.

**Claude Code writes some of these keys too.** Its own `/setup-bedrock` command
and its model-selection prompt write the region and the model names directly.
The extension does not fight that: when a managed value no longer matches what
it last wrote, the panel reports it — "Claude Code changed the Opus model" — and
leaves the value alone. Use *Reset to Recommended* on that row if you want the
recommended value back; nothing is overwritten until you do.

## If you use WSL, Remote-SSH, or a dev container

**The settings are written on the machine Claude Code runs on, not the machine
your screen is attached to.** This is the right thing, but it surprises people,
so here it is spelled out.

When you open a folder with *WSL*, *Remote-SSH*, or *Dev Containers*, VS Code
splits itself across two machines: the window stays on your own computer, and
everything that runs code moves to the other side — the Linux distribution, the
server you connected to, the container. Claude Code goes with it. So does this
extension.

That means the file being managed is the one over there:

| You are using | Your settings file is | Not |
|---|---|---|
| WSL (Ubuntu, Debian, …) | `/home/<you>/.claude/settings.json` *inside the Linux distribution* | `C:\Users\<you>\.claude\settings.json` |
| Remote-SSH | `/home/<you>/.claude/settings.json` *on the server you connected to* | anything on your laptop |
| A dev container | `/home/<you>/.claude/settings.json` *inside the container* | anything on the host machine |
| No remote — an ordinary window | `~/.claude/settings.json` on your own computer | — |

A few consequences worth knowing:

- **Windows users on WSL: nothing is written to your `C:` drive.** If you go
  looking in `C:\Users\<you>\.claude` you will find nothing, or something old.
  That is expected, not a failure.
- **Each machine keeps its own settings and its own key.** Connecting to a
  second server means setting your Bedrock API key there too. They are separate
  computers, and a keychain does not travel.
- **A local window and a remote window are configuring different files.** If you
  fix something and it seems not to have applied, check which one you were in.
  VS Code shows it in the bottom-left corner: `WSL: Ubuntu`, `SSH: myserver`, or
  nothing at all for a local window.

Not sure which file you are looking at? Run *Check Configuration*, then *Copy
Diagnostics for Support* — the report names the exact path, and a **Remote** row
saying `wsl`, `ssh-remote`, `dev-container` or `local`.

## Where your Bedrock API key is stored

Your key lives in **your editor's secret storage**, which is encrypted on disk
with a key held in your operating system's keychain — Keychain on macOS, DPAPI
on Windows, the login keyring on Linux. That copy is the real one: it is what
*Set Bedrock API Key* writes, what *Update Bedrock API Key* replaces, and what
the age reminder measures.

It is also written into `~/.claude/settings.json`, readable only by you — mode
`0600` on macOS and Linux, and on Windows an access list with the broad
principals removed. That second copy is not optional and not an oversight:

- The **Claude Code panel** inside VS Code starts its program from VS Code
  itself, and a program cannot read your keychain. The settings file is the only
  place it can find the key.
- Integrated **terminals** get the key a different way — the extension hands it
  to each new terminal directly, so a terminal never reads it from disk.

*Remove Bedrock API Key* clears all three at once: secret storage, settings
file, and terminals. It does not cancel the key at Amazon — do that in the
Bedrock console if you want it to stop working everywhere.

If you already ran Claude Code's own `/setup-bedrock`, your key is in the
settings file but not in secret storage. The panel offers **Use the key from my
settings file**, which saves it without making you find it again. If the two
ever hold *different* keys, nothing is overwritten: the panel asks which one you
want.

**None of this stops the key being read by what Claude Code starts.** That is
the first item under [Residual risk](#residual-risk), and it is the part worth
reading.

## Network requests

This extension makes exactly two outbound requests, and no others. It sends no
telemetry, no analytics, and no crash reports — not "none yet", but a deliberate
commitment: adding any would mean an opt-in, a disclosure here, and honouring
your `telemetry.telemetryLevel`.

**1. It fetches the recommended settings.**

```
GET https://raw.githubusercontent.com/cutler-sg/sensible-claude-code-defaults/main/manifest/defaults.json
```

At most once an hour per window, and whenever you run *Check for Updated
Recommendations*. It sends nothing but the request — no key, no identifier, no
query string, and nothing about you or your machine. The reply is the table of
recommended values above. If it fails, or takes longer than five seconds, the
last good copy is used, and failing that the copy inside the extension; the
panel says which one it is using rather than pretending the channel worked.

**2. It tests your Bedrock API key, when you ask it to.**

```
POST https://bedrock-runtime.<your region>.amazonaws.com/model/<model id>/invoke
```

Only when you click *Test Bedrock Connection*. This is the only time the
extension sends your key anywhere. It goes to Amazon's Bedrock endpoint for your
configured region and nowhere else, sends a one-character message, asks for a
single token of output, and reports only whether it worked. Nothing about the
answer — including any error text Amazon returns — is logged or shown to you
verbatim.

Neither request is proxied by anything of ours: the extension has no proxy
configuration of its own and uses the editor's own network stack, so your
`http.proxy` settings apply.

## Residual risk

Two things this extension cannot fix, stated plainly rather than left for you to
discover.

### Every program Claude Code starts inherits your key

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

### The project scan finds some copies of your key, not all of them

When a key is saved, the panel checks your open project folders for a copy of it
— the case where a tutorial told you to paste it into a `.env` and it is now on
its way to a git remote. A clean result is worth something, but it is not a
guarantee. Here is exactly what it does and does not do. The whole of it is
[`src/credential/leakScan.ts`](src/credential/leakScan.ts), if you would rather
read the code than take this on trust.

**It looks at** the places a key actually gets pasted, inside the folders you
currently have open:

- files named `.env` or `.env.something`, and `.envrc`
- files ending in `.json`, `.md`, `.txt`, `.yaml`, `.yml`, `.toml`, `.sh`,
  `.ps1`, `.bat`, `.cmd` or `.bak` — the last one because a settings file
  copied before editing becomes `settings.json.bak`
- `Dockerfile`, and `Dockerfile.anything`
- the shell profiles: `.zshrc`, `.bashrc`, `.bash_profile`, `.zprofile` and
  `.profile`

**It does not look at** anything else — your source files, your notebooks, your
editor's own settings, your shell history, your terminal scrollback, or any
folder you do not have open in this window. It ignores files larger than 1 MB.

**It skips some folders.** `node_modules`, `.git` and `.venv` are skipped
wherever they appear. `dist` and `out` are skipped only when they sit directly
inside a folder you have open, because that is where build output lives — a
`dist` or `out` further down is an ordinary source folder and is read normally.

**It stays inside the folders you opened.** It does not follow shortcuts or
symbolic links out of a folder. If a folder you opened is itself a shortcut to
somewhere else, the scan reads the real location it points at and names files
by where they actually are.

**It stops after three seconds, or 5,000 files.** On a large project it will not
have looked at everything, and it says so — a row reading "we ran out of time"
is not a clean result, and the panel never reports one as if it were. If it
finds a copy of your key *and* runs out of time, it tells you both: the file it
found is real, but the list is not necessarily the whole list, and running the
check again picks up where it left off.

**It does not look inside your git history.** If the key has ever been
committed, it is in past versions of the repository and in every clone of it.
Deleting the line today does not remove it, and neither does deleting the
branch. When the scan finds your key in a file that git is tracking, it says so
and tells you to replace the key — because replacing it is the only thing that
actually works.

**It never edits your files.** Nothing in this extension writes inside a project
folder, ever. If your key is found, you are shown which file, and you remove it.

**It does not run in a folder you have not trusted.** Reading your project files
is the one thing this extension does that touches your code, so in a restricted
window it does not read them at all, and the panel says the folder was not
checked rather than pretending it was clean.

## Getting help

*Copy Diagnostics for Support* puts a report on your clipboard describing your
setup: your versions and platform, which recommended settings are in force, your
`~/.claude/settings.json`, the health check results, and the last 50 lines from
the extension's output log. **Your Bedrock API key — and anything else that looks
like a credential — is replaced with `«redacted»` before it reaches the
clipboard**, so the report is safe to paste into a public issue. Nothing is
written to a file: the report exists only on your clipboard until you paste it.

Questions and bugs both go to
[GitHub issues](https://github.com/cutler-sg/sensible-claude-code-defaults/issues).
**A way for your key to end up somewhere it should not be is the one thing that
does not go in a public issue** — email security@cutler.sg instead; the scope is
in [SECURITY.md](SECURITY.md).

## Uninstalling

Uninstalling the extension removes the extension. It does not undo what the
extension wrote, so here is the rest of it.

**Do this first, while the extension is still installed:** run *Remove Bedrock
API Key*. That is the only convenient way to get the key out of your editor's
secret storage — VS Code does not clear an extension's secrets when you
uninstall it ([microsoft/vscode#123817](https://github.com/microsoft/vscode/issues/123817),
still open), and there is no per-extension item you can go and delete by hand on
any platform: the secrets live encrypted inside VS Code's own state, and the
only thing in your macOS Keychain, Windows DPAPI store or Linux keyring is the
key that decrypts all of them, shared by every extension. If you have already
uninstalled, reinstall, run the command, and uninstall again.

Then, at your leisure:

- **`~/.claude/settings.json` keeps the nine keys**, your Bedrock API key among
  them. Nothing removes them for you. Delete the `env` entries you no longer
  want, or restore a backup before you uninstall.
- **`~/.claude/sensible-defaults/` stays.** It holds `state.json` and up to ten
  backups of your previous settings — and a backup taken after you set your key
  contains that key in plain text. `rm -rf ~/.claude/sensible-defaults` when you
  are done with them.
- **The cached copy of the recommended settings** sits in VS Code's own
  extension storage. It contains nothing about you and goes when VS Code cleans
  up the extension's data.
- **Your project folders have nothing to clean up.** The extension never wrote
  anything inside one.

## Why this exists

Claude Code on Bedrock needs half a dozen environment variables to be right at
once, in a file most people have no reason to open, and the failure modes all
look the same from the outside: it just does not work. This extension writes
those variables, keeps your key somewhere better than a shell profile, and
turns "it does not work" into a sentence naming which one of them is wrong.

That is the whole of it. It is not a proxy and it is not a gateway: your
requests go from Claude Code straight to AWS, it never sees a prompt or a
response, and it runs no inference of its own. It configures a tool that
somebody else wrote, and says so.

MIT licensed. The source is at
[github.com/cutler-sg/sensible-claude-code-defaults](https://github.com/cutler-sg/sensible-claude-code-defaults) —
every claim on this page is a file in it.
