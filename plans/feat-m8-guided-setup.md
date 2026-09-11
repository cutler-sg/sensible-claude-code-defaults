# Plan — M8 (guided setup: a sidebar experience a non-technical user can finish)

Source of truth: `docs/PRD.md` §5 FR-4 (credential flows), §13 (trust posture), and the first real-hardware run recorded in `plans/feat-m7-release.md`.
Depends on M7. Branch: `feat/m8-guided-setup`. Status: **Parts A–D implemented 2026-09-11; Part E is MC's manual pass on real hardware.**

## Why

The panel shipped in 0.1.0 is a diagnostics tree that happens to be the only UI. It answers "what is wrong" for an engineer. It does not answer "what do I do" for the person the PRD is actually for. Three things the screenshot from the first hardware run made plain:

- The one action everyone must take — set the key — lives in the command palette, which a non-technical user never opens. The tree's inline fix buttons only appear on a failing row, so the healthy state shows no actions at all.
- `showInputBox` is a hostile place to paste a secret: one line, no context, no "where do I get this", no statement of where it goes.
- Twenty rows of "check passed" read as a build log. What matters is the one thing that is wrong and the one button that fixes it.

The requirement, in MC's words: *simple, almost idiot-proof for non-technical users.*

## Decisions taken (2026-09-11)

- **D-1 Two steps, not three.** Paste a key, watch it test. No region prompt. Validated empirically: the `global.` inference profiles resolve from every commercial `bedrock-runtime.<region>` endpoint probed (us-east-1, ap-southeast-1, ap-northeast-1, eu-west-1, sa-east-1, af-south-1, me-central-1), and no regionless endpoint exists. The region is still a fact on the wire but no longer a decision the user must make. The extension writes `us-east-1` silently — the same fallback Claude Code itself uses when `AWS_REGION` is unset — and *Change region* becomes a text link in the healthy card for the rare user with a residency or latency reason.
- **D-2 Sidebar panel, not an editor tab.** Stays beside the user's work; the Welcome-tab pattern disappears the moment they click elsewhere.
- **D-3 Keys are self-created.** Step 1 therefore includes a *Create a key* detour that opens the exact console page and tells them which tab to use, rather than assuming a key was handed to them.

## The design: one screen, three states

A `WebviewView` in the existing `sensibleDefaults` container replaces the tree as the primary surface. The tree survives inside a collapsed "Details" disclosure at the bottom of the healthy state, so the diagnostics an engineer or support person needs are one click away and nothing is thrown away.

### State A — Not set up

```
┌──────────────────────────────────────┐
│  Claude Code isn't set up for        │
│  Amazon Bedrock yet.                 │
│                                      │
│  It takes about a minute. You'll     │
│  need an Amazon Bedrock API key.     │
│                                      │
│         [ Set up now ]               │
│                                      │
│  Already have Claude Code working?   │
│  Check my setup                      │   ← text link, runs health, jumps to C
└──────────────────────────────────────┘
```

Nothing else on screen. The button starts the flow. The link covers the `/setup-bedrock` user who already has a key in `settings.json` and just wants the panel to notice it (today's `adoptToken`).

### State B — Setup (two steps, one visible at a time)

```
┌──────────────────────────────────────┐
│  Step 1 of 2 · Your Bedrock API key  │
│  ●━━━━━━━━━━○                         │
│                                      │
│  Paste your key below.               │
│  ┌────────────────────────────┐ [👁] │
│  │ ••••••••••••••••••••••••••  │     │
│  └────────────────────────────┘      │
│  ✓ That looks like a Bedrock key     │   ← live shape check, from shape.ts
│                                      │
│  Don't have one? Create a key →      │   ← opens console; expands the box below
│                                      │
│  ┌ Where does it go? ─────────────┐  │
│  │ Your computer's keychain, and  │  │
│  │ ~/.claude/settings.json so     │  │
│  │ Claude Code can read it. It is │  │
│  │ never sent anywhere but Amazon.│  │
│  └────────────────────────────────┘  │
│                                      │
│                 [ Continue ]         │
└──────────────────────────────────────┘
```

*Create a key* expands inline (it does not navigate away), because the user is about to leave for a browser and needs the instructions still on screen when they come back:

```
  1. Open the Amazon Bedrock console  [ Open console ]
  2. In the left menu choose "API keys"
  3. Choose the "Long-term API keys" tab, then "Generate"
  4. Pick how long it should last, then copy the key.
     It is shown once — copy it before closing the page.
  5. Paste it above.
```

The console URL is `https://console.aws.amazon.com/bedrock/home#/api-keys/long-term/create` (from the AWS model cards' sample-code steps, verified 2026-09-11). Opened with `vscode.env.openExternal`, never as an `<a href>` inside the webview.

*Continue* is disabled until the shape check passes. On click: `store` → `mirror` (the existing flow functions) → advance to step 2. Any failure at this point (keychain unavailable, settings file unwritable) shows one sentence and one button on this step; it never advances.

```
┌──────────────────────────────────────┐
│  Step 2 of 2 · Checking it works     │
│  ●━━━━━━━━━━●                         │
│                                      │
│      ◌  Asking Amazon…               │   ← auto-runs testConnection
│                                      │
└──────────────────────────────────────┘
```

Then one of:

```
│      ✓  Your key works.              │        │  ✗  Amazon refused this key.          │
│                                      │        │                                       │
│  Claude Code is set up.              │        │  Check it in the console and paste it │
│                                      │        │  again. Keys can expire.              │
│         [ Done ]                     │        │                                       │
                                                │     [ Try a different key ]           │
                                                │     Test again                        │
```

Every `ConnectionResult` kind maps to one sentence and one primary action, using the existing `LABELS["cred.valid"]` text so the panel and the toast never disagree:

| kind | sentence | primary |
|---|---|---|
| ok | Your key works. | Done |
| ok-without-haiku | Your key works, but the small model isn't turned on for you. | Done (secondary: Which model?) |
| bad-credential | Amazon refused this key. | Try a different key |
| insufficient-permissions | Your key is valid but isn't allowed to use Claude. Whoever issued it needs to widen its permissions. | Copy what to tell them |
| model-not-enabled | Amazon accepted your key, but the Claude models aren't turned on for you. | Open the model catalog |
| wrong-region | (should not occur with `global.`; kept for a user who set a geo profile) | Change region |
| network | Couldn't reach Amazon. Check your connection and try again. | Test again |
| unknown | Amazon gave an answer we didn't understand (HTTP nnn). | Test again (secondary: Copy diagnostics) |

*Done* runs a health check and moves to state C.

### State C — Healthy (and its interruptions)

```
┌──────────────────────────────────────┐
│  ✓  Everything is working            │
│                                      │
│  Key set 3 days ago · tested today   │
│                                      │
│  [ Test connection ]  Replace key    │
│                       Change region  │
│                                      │
│  ▸ Details (18 checks)               │   ← collapsed; expands to the existing tree
└──────────────────────────────────────┘
```

Anything not-green replaces the header line and the actions with one sentence and one button, taken from the highest-severity check's label and fix:

```
│  ⚠  Your key is 92 days old          │
│                                      │
│  Replace it before it stops working. │
│         [ Replace key ]              │
│                                      │
│  ▸ Details (18 checks, 1 warning)    │
```

Priority when several checks fail: error before warning before info; within a level, credential before configuration before installation, because a missing key blocks everything else. The rest stay in Details.

### Rules applied everywhere

1. One primary button per screen. Everything else is a text link.
2. Every failure names the next click, not the cause.
3. No jargon on the primary path. "Region" gets a one-line gloss when it appears. "Inference profile", "SigV4", "IAM" never appear.
4. The key field is the only text input in the whole experience.
5. The panel opens itself on first install and whenever no key is present. It never nags when healthy.
6. Nothing in the webview can reach the network. All I/O goes through `postMessage` to the extension, which runs the same flow functions the commands do.

## Part A — the webview shell

- [x] `package.json`: change the `sensibleDefaults.health` view to `"type": "webview"`; add a second, hidden-by-default tree view `sensibleDefaults.details` for the disclosure (a webview cannot host a native tree, so Details toggles the second view's visibility via `setContext`).
- [x] `src/ui/panel/provider.ts`: `WebviewViewProvider` with `retainContextWhenHidden: false` (state is tiny and lives in the extension; rebuilding is cheap and avoids the memory cost the docs warn about).
- [x] `src/ui/panel/html.ts`: the page as a template string. CSP `default-src 'none'; style-src ${cspSource} 'nonce-…'; script-src 'nonce-…'; img-src ${cspSource}`. No remote content, no `unsafe-inline`, nonce regenerated per render. Uses VS Code's CSS variables (`--vscode-button-background` etc.) so it matches every theme with no colour of its own.
- [x] `src/ui/panel/state.ts`: a pure reducer `(report, credential, setupProgress) → PanelState` with the three states and the interruption priority above. This is where the tests live; the HTML is a function of it.
- [x] `src/ui/panel/messages.ts`: the typed message protocol both ways. Webview→extension: `setup.start`, `key.changed` (shape check only, value not logged), `key.submit`, `test.run`, `console.open`, `details.toggle`, `action.run {command}`. Extension→webview: `state {PanelState}`.
- [x] The key value crosses `postMessage` once, on submit, and is passed straight to `store`. It is never echoed back, never put in state, never logged. Redaction test: mutate the provider to include the key in the `state` message and assert a test fails.

## Part B — the flows, refactored to be UI-agnostic

- [x] Split `enterToken` in `flows.ts` into `saveToken(deps, token)` (store + mirror, no UI) and the existing input-box wrapper that calls it. The webview calls `saveToken`; the palette command is unchanged. Same for `testConnection`: the result already comes back as a value; the toast stays on the command path only.
- [x] `adoptToken` becomes the target of *Check my setup* in state A.
- [x] Silent region write: `applyDefaults` already writes `AWS_REGION` from the manifest. Confirm the setup path calls it (it must, to write the other eight keys) and that no prompt fires. The `config.region` check keeps validating the value is a real region string.

## Part C — the details disclosure

- [x] Reuse `HealthTreeProvider` unchanged on the `sensibleDefaults.details` view.
- [x] The disclosure header counts levels from `report.counts` so "18 checks, 1 warning" is derived, not maintained.

## Part D — tests

- [x] `state.test.ts`: every transition in the reducer, the interruption priority (error > warning > info; cred > config > install), and that a healthy report with zero non-pass checks yields state C with no interruption.
- [x] `html.test.ts`: render each state and assert (a) the CSP header is present with a nonce, (b) no `<a href="http`, (c) the key never appears in output for any state, (d) exactly one element has the primary-button class.
- [x] `messages.test.ts`: the reducer rejects malformed messages from the webview without throwing; an `action.run` with a command id outside the allowlist is dropped and logged.
- [x] Mutation pass, as every milestone: blind the shape check, drop the CSP, echo the key into state, break the priority order. Each must fail a named test.
- [x] Integration (`test/integration-vscode`): the view resolves, receives a `state` message on activation, and a synthetic `setup.start` produces a step-1 render. The host cannot see pixels; what it can see is the message stream.

## Part E — manual, on MC's Mac (cannot be automated)

- [ ] Fresh profile: panel opens itself on state A. *Set up now* → paste a real key → auto-test passes → state C. Time it. Target: under a minute for someone who already has the key.
- [ ] *Create a key* detour: console opens on the right page; instructions stay on screen; a key generated there pastes and passes.
- [ ] Wrong key: state B step 2 shows "Amazon refused this key" with *Try a different key*, not "didn't understand".
- [ ] Theme check: light, dark, and high-contrast. No hard-coded colours.
- [ ] Screenshots of each state for the README (`media/panel.png` is still a placeholder from M7).

## Open questions

- **Q-AL (resolved: Details only)** Where does the drift info row go? Today "Some settings have been changed since the recommended setup" is an info row with a per-key reset. In state C it is a candidate interruption at the lowest priority, with *Reset to recommended* as the action. Or it stays in Details only. Leaning: Details only — a non-technical user did not change those settings on purpose, Claude Code's own `/setup-bedrock` did, and telling them about it invites a click they don't understand.
- **Q-AM (resolved: reveal, preserve focus)** Should the panel steal focus on first install? `viewsWelcome` cannot; a webview can `show({preserveFocus:false})` from activation. Leaning: reveal but preserve focus. A panel that appears is helpful; one that grabs the cursor is not.

## Not in M8

- Full editor-tab welcome page (D-2).
- A region picker on the primary path (D-1).
- Short-term key refresh automation. The setup accepts either key type; refresh is the user's problem until there is a story for it.
