# Manual verification — M6 Part D

The platform matrix in [PRD §10.3](PRD.md) has five rows that CI cannot reach. A
GitHub runner has no keychain prompt to click, no Windows ACL to loosen by hand,
and no second machine to be remote from. Everything here needs a human on real
hardware.

**These are not ticked by an agent.** Plan decision Q-AH: an agent claiming to
have seen a macOS Keychain prompt on hardware it does not have is precisely the
failure this file exists to prevent. Leave a box unticked rather than guessing,
and write down what you actually saw next to anything that surprised you.

## How to run any of these

Each item assumes the extension is installed on the machine under test, from a
`.vsix` built on that branch:

```bash
bun run package                  # produces sensible-claude-code-defaults-<version>.vsix
code --install-extension sensible-claude-code-defaults-<version>.vsix
```

Then open VS Code, and run **Check Configuration** from the Command Palette
(`Ctrl/Cmd+Shift+P`) unless an item says otherwise. "The panel" means the
*Sensible Defaults* icon in the activity bar.

Two conventions used below:

- **Expected** is what a pass looks like, written so a failure is recognisable.
  If you see something else, that is the finding — record it verbatim.
- Where a row names an exact panel string, the string is the assertion. A
  differently worded message with the same meaning is a **fail**: the wording is
  what a non-technical user acts on, and it is what the unit suite pins.

---

## 1. macOS (Apple Silicon)

**Verifies:** Keychain round-trip, POSIX modes, homedir resolution.
**Needs:** an M-series Mac, a real Bedrock API key.

- [ ] **1.1 — The keychain prompt appears, once.**
      With no key yet saved, run **Set Bedrock API Key** and paste a real key.
      **Expected:** macOS shows a Keychain access prompt naming *Code* (or *Visual
      Studio Code*). Approve it. Run **Check Configuration** again.
      **Expected:** no second prompt, and `cred.present` reads
      *"Your Bedrock API key is saved in this computer's keychain"*.
      A prompt on **every** health run is a fail — note whether you clicked
      *Allow* or *Always Allow* the first time, because that distinction is the
      likely cause.

- [ ] **1.2 — The key round-trips.**
      Run **Test Bedrock Connection**.
      **Expected:** *"Your Bedrock API key works"* in the panel. This proves the
      value came back out of the keychain byte-identical — a truncated or
      re-encoded key fails at Amazon, not locally.

- [ ] **1.3 — `0600` survives a Claude Code write.**
      In a terminal: `stat -f '%Sp' ~/.claude/settings.json` → expect `-rw-------`.
      Now let Claude Code write the file itself: run `claude` and use `/model` to
      change the model, which rewrites `settings.json` with the default mode.
      Check `stat` again — it will likely read `-rw-r--r--`.
      Back in VS Code, run **Check Configuration**.
      **Expected:** `stat` reads `-rw-------` again, and the panel says
      *"Your settings are private to you"*. The repair is silent by design
      (plan Q-N) — there is no button to press.

- [ ] **1.4 — The panel renders.**
      **Expected:** every row has an icon and readable text; no row reads
      *"This check couldn't run"*; the group headings *Installation*,
      *Configuration* and *Credential* are all present.

- [ ] **1.5 — The home directory is the user's.**
      Run **Copy Diagnostics for Support** and paste it somewhere.
      **Expected:** the **Settings file** row reads `/Users/<you>/.claude/settings.json`,
      and the **Remote** row reads `local`.

---

## 2. Windows 11 native

**Verifies:** `%USERPROFILE%`, DPAPI-backed SecretStorage, ACL repair, path separators.
**Needs:** Windows 11, an administrator-capable account, a real Bedrock API key.

- [ ] **2.1 — `%USERPROFILE%` resolution.**
      Run **Copy Diagnostics for Support**.
      **Expected:** the **Settings file** row reads
      `C:\Users\<you>\.claude\settings.json`, with **backslashes**. Forward
      slashes, a doubled separator (`C:\Users\you\\.claude`), or a path under
      `AppData` are all fails.

- [ ] **2.2 — DPAPI-backed SecretStorage.**
      Run **Set Bedrock API Key**, paste a real key, then **close VS Code
      entirely and reopen it**. Run **Check Configuration**.
      **Expected:** *"Your Bedrock API key is saved in this computer's keychain"* —
      the key survived a process restart. Windows shows no prompt; that is
      correct, DPAPI is silent. If the key is gone after a restart, that is the
      finding.

- [ ] **2.3 — ACL repair actually tightens a loosened file.**
      This is the one that closes plan Q-K, so do it precisely. In an
      **elevated** PowerShell:
      ```powershell
      icacls "$env:USERPROFILE\.claude\settings.json"                       # before
      icacls "$env:USERPROFILE\.claude\settings.json" /grant "*S-1-5-32-545:(R)"
      icacls "$env:USERPROFILE\.claude\settings.json"                       # loosened
      ```
      The SID `S-1-5-32-545` is `BUILTIN\Users` — used rather than the name
      because `icacls` output is localised (plan decision Q-AG).
      Now run **Check Configuration** in VS Code, then `icacls` once more.
      **Expected:** the `S-1-5-32-545` grant is **gone**, and the panel reads
      *"Your settings are private to you"*. A panel reading
      *"Windows manages file privacy differently — nothing to check here"* means
      the repair did not run at all — record that, it is a real fail rather than
      a cosmetic one.

- [ ] **2.4 — Path separators in the drift labels.**
      Edit `settings.json` by hand and change the Opus model to something else.
      Run **Check Configuration** and expand the drift row.
      **Expected:** any path shown in a label or detail uses backslashes and is
      not escaped for JSON (no `C:\\Users\\`).

- [ ] **2.5 — Non-ASCII in the profile path.**
      Only if you can easily test it: a Windows account whose username contains
      a non-ASCII character (e.g. `Müller`). Run **Check Configuration**.
      **Expected:** the panel works and the diagnostics **Settings file** row
      shows the name correctly, not as mojibake. Skip and say so if you have no
      such account — do not create one just for this.

---

## 3. Windows + WSL2

**Verifies:** the FR-1.3 promise — the extension host runs remote, and writes
land in the **WSL** home, not `C:\Users\…`.
**Needs:** Windows 11 with WSL2 and a distribution installed, plus the
*WSL* extension.

The automated coverage stops here. `test/integration-vscode/resolution.spec.ts`
proves resolution is host-local; only this item proves VS Code actually places
the host on the WSL side.

- [ ] **3.1 — The extension is running remote.**
      Open a folder inside WSL (`WSL: Connect to WSL`, then open a folder under
      `/home/...`). The bottom-left corner must read **`WSL: <distro>`**. Open
      the Extensions view and find *Sensible Claude Code Defaults*.
      **Expected:** it is listed under a heading naming the WSL distribution —
      not under *Local*. If VS Code offers an **Install in WSL** button, the
      extension is local-only and FR-1.3 is broken; stop and record that.

- [ ] **3.2 — Writes land in the WSL home.**
      Run **Apply Recommended Configuration** and accept. Then, in a **WSL**
      terminal:
      ```bash
      cat ~/.claude/settings.json     # inside the distro
      ```
      **Expected:** the file exists and contains the applied keys.

- [ ] **3.3 — Nothing was written on the Windows side.**
      In **PowerShell** (not WSL):
      ```powershell
      Get-Content "$env:USERPROFILE\.claude\settings.json"
      ```
      **Expected:** the file does not exist, **or** it exists and is unchanged —
      compare its last-write time to before step 3.2. A Windows-side file that
      just gained the keys you applied is the exact §15 "WSL homedir mismatch"
      bug; capture both paths and stop.

- [ ] **3.4 — The diagnostics say which side.**
      Run **Copy Diagnostics for Support**.
      **Expected:** the **Remote** row reads `wsl`, and the **Settings file**
      row is a `/home/...` path with forward slashes.

- [ ] **3.5 — The two sides are independent.**
      Open an ordinary **local** window (no WSL) and look at the panel.
      **Expected:** it reports on the Windows-side configuration — most likely
      *"No Bedrock API key has been set"*, because the key you set in the WSL
      window lives in the WSL keyring. Two windows disagreeing is **correct**;
      this step exists so you recognise it as correct rather than as a bug.

---

## 4. Remote-SSH

**Verifies:** same-side resolution on a second machine.
**Needs:** any Linux host you can SSH into, plus the *Remote - SSH* extension.

- [ ] **4.1 — The extension is running on the server.**
      Connect (`Remote-SSH: Connect to Host…`) and open a folder. Bottom-left
      reads **`SSH: <host>`**. In the Extensions view, *Sensible Claude Code
      Defaults* is listed under the **SSH: `<host>`** heading.
      **Expected:** installed on the remote, not offered as *Install in SSH*.

- [ ] **4.2 — It resolves the server's home.**
      Run **Copy Diagnostics for Support**.
      **Expected:** **Remote** reads `ssh-remote`; **Settings file** is the
      *server's* home (`/home/<remote-user>/.claude/settings.json`), not your
      laptop's. If your local and remote usernames match, check the path is
      right for the remote machine's layout — a macOS laptop would say
      `/Users/...`, so a `/home/...` path is itself evidence.

- [ ] **4.3 — Writes land on the server.**
      Run **Apply Recommended Configuration**, accept, then in the remote
      terminal: `cat ~/.claude/settings.json`.
      **Expected:** the applied keys are there. Then check your **laptop's** own
      `~/.claude/settings.json` is untouched.

- [ ] **4.4 — A key set remotely stays remote.**
      Run **Set Bedrock API Key** on the remote window. Then open a local window.
      **Expected:** the local panel does **not** report a saved key. As with
      3.5, the disagreement is the correct behaviour.

---

## 5. Linux with libsecret absent

**Verifies:** plan Q-X's promise — *report, don't degrade*. The extension must
still activate and say something actionable when there is no keyring.
**Needs:** a headless Linux box, VM, or container with no desktop session and
`libsecret` not installed. A Docker container running VS Code's CLI works; so
does an SSH connection to a server with no GUI (which makes this a natural
follow-on from item 4).

To confirm the machine is genuinely in the state under test:

```bash
ls /usr/lib/*/libsecret-1.so.0 2>/dev/null || echo "libsecret absent"
echo "${DBUS_SESSION_BUS_ADDRESS:-no session bus}"
```

- [ ] **5.1 — The extension activates anyway.**
      Open the panel.
      **Expected:** the panel renders with its rows. A keychain that throws must
      not take activation with it — an extension that failed to activate cannot
      report anything, which is the whole point of Q-X. An empty panel, or the
      extension missing from the Extensions view's *running* state, is a fail.

- [ ] **5.2 — The message is accurate.**
      Look at the credential rows.
      **Expected:** `cred.present` reads *"This computer's keychain can't be
      opened, so your key can't be checked"*. It must **not** read
      *"No Bedrock API key has been set"* — that sentence says the user has not
      done something, when in fact the machine cannot answer the question.

- [ ] **5.3 — The message is actionable.**
      Read the row's detail text as if you were the semi-technical user in
      PRD §4.
      **Expected:** it tells you the keychain is the problem, not your key.
      Judgement call, and the point of having a human do it: if you would not
      know what to do next after reading it, that is the finding — write down
      what you *would* have wanted it to say.

- [ ] **5.4 — Nothing crashes on the paths that need a key.**
      Run **Check Configuration** twice, then **Copy Diagnostics for Support**.
      **Expected:** no error toast, and the diagnostics land on the clipboard
      with the credential rows reporting the keychain failure. (If the box has
      no clipboard, skip this and say so.)

- [ ] **5.5 — No key is written anywhere as a fallback.**
      **Expected:** there is no plaintext key file anywhere outside
      `~/.claude/settings.json`. Specifically check `~/.config/Code/` and
      `~/.vscode-server/`:
      ```bash
      grep -rl 'AWS_BEARER_TOKEN_BEDROCK' ~/.config/Code ~/.vscode-server 2>/dev/null
      ```
      **Expected:** no output. Degrading to a plaintext store when the keychain
      is unavailable would be a security regression, not a convenience.

---

## Recording the result

Paste the completed list into the M6 pull request body with your findings inline
under the items that failed or surprised you. Items you **skipped** stay
unticked with a one-line reason — an unticked box with a reason is information;
a ticked box that nobody verified is worse than no checklist at all.
