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
guarantee. Here is exactly what it does and does not do.

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

**It stops after three seconds.** On a large project it will not have looked at
everything, and it says so — a row reading "we ran out of time" is not a clean
result, and the panel never reports one as if it were. If it finds a copy of
your key *and* runs out of time, it tells you both: the file it found is real,
but the list is not necessarily the whole list, and running the check again
picks up where it left off.

**It does not look inside your git history.** If the key has ever been
committed, it is in past versions of the repository and in every clone of it.
Deleting the line today does not remove it. When the scan finds your key in a
file that git is tracking, it says so and tells you to replace the key —
because replacing it is the only thing that actually works.

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

