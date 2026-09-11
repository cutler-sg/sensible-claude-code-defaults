/**
 * The panel's HTML, as a pure function of `PanelState`.
 *
 * Security posture (plan M8 Part A):
 * - CSP `default-src 'none'`; scripts and styles only with a per-render nonce.
 * - No remote content of any kind. No `<a href="http…">`: external links go
 *   through `console.open`, which the extension resolves with `openExternal`.
 * - The token never appears here. The reducer never has it; the only place the
 *   value exists on the page is the input the user typed it into, and it leaves
 *   by `postMessage` once.
 *
 * Every colour is a VS Code theme variable, so the page matches light, dark and
 * high-contrast with no palette of its own.
 */

import type { PanelState, SetupProgress } from "./state.js";
import { resultView } from "./state.js";

export interface RenderOptions {
  nonce: string;
  cspSource: string;
}

export function render(state: PanelState, options: RenderOptions): string {
  const { nonce, cspSource } = options;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sensible Claude Code Defaults</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main id="root" data-state="${state.kind}">
${body(state)}
</main>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

function body(state: PanelState): string {
  switch (state.kind) {
    case "loading":
      return `<p class="muted">Checking your Claude Code configuration…</p>`;
    case "unconfigured":
      return unconfigured();
    case "setup":
      return setup(state.progress, state.consoleUrl);
    case "healthy":
      return healthy(state);
  }
}

function unconfigured(): string {
  return `
<h1>Claude Code isn't set up for Amazon Bedrock yet.</h1>
<p>It takes about a minute. You'll need an Amazon Bedrock API key.</p>
<button class="primary" data-msg="setup.start">Set up now</button>
<p class="muted">Already have Claude Code working?
<button class="link" data-msg="setup.check">Check my setup</button></p>`;
}

function setup(progress: SetupProgress, consoleUrl: string): string {
  switch (progress.step) {
    case "key":
      return stepKey(progress, consoleUrl);
    case "testing":
      return `${stepHeader(2, "Checking it works")}
<p class="status"><span class="spinner" aria-hidden="true"></span> Asking Amazon…</p>`;
    case "result": {
      const view = resultView(progress.result);
      const primary =
        "message" in view.primary
          ? `<button class="primary" data-msg="${view.primary.message}">${esc(view.primary.label)}</button>`
          : `<button class="primary" data-action="${esc(view.primary.command)}">${esc(view.primary.title)}</button>`;
      const secondary = view.secondary
        ? `<button class="link" data-action="${esc(view.secondary.command)}">${esc(view.secondary.title)}</button>`
        : "";
      return `${stepHeader(2, "Checking it works")}
<p class="status ${view.ok ? "ok" : "bad"}"><span class="mark" aria-hidden="true">${view.ok ? "✓" : "✗"}</span> ${esc(view.sentence)}</p>
${view.hint ? `<p>${esc(view.hint)}</p>` : ""}
${primary}
${secondary}`;
    }
  }
}

function stepKey(progress: Extract<SetupProgress, { step: "key" }>, consoleUrl: string): string {
  const feedback = shapeLine(progress.shape);
  const canContinue = progress.shape.kind === "ok" || progress.shape.kind === "warning";
  return `${stepHeader(1, "Your Bedrock API key")}
<label for="key">Paste your key below.</label>
<div class="field">
  <input id="key" type="password" autocomplete="off" spellcheck="false" placeholder="Bedrock API key" aria-describedby="shape">
  <button class="icon" id="reveal" type="button" aria-label="Show or hide the key" title="Show or hide">👁</button>
</div>
<p id="shape" class="feedback ${progress.shape.kind}">${feedback}</p>
${progress.problem ? `<p class="feedback error">${esc(progress.problem)}</p>` : ""}
<details id="create">
  <summary>Don't have one? Create a key</summary>
  <ol>
    <li>Open the Amazon Bedrock console. <button class="link" data-msg="console.open">Open console</button></li>
    <li>In the left menu choose <b>API keys</b>.</li>
    <li>Choose the <b>Long-term API keys</b> tab, then <b>Generate</b>.</li>
    <li>Pick how long it should last, then copy the key. It is shown once — copy it before closing the page.</li>
    <li>Paste it above.</li>
  </ol>
  <p class="muted">${esc(consoleUrl)}</p>
</details>
<details>
  <summary>Where does it go?</summary>
  <p>Your computer's keychain, and <code>~/.claude/settings.json</code> so Claude Code can read it. It is never sent anywhere except Amazon.</p>
</details>
<button class="primary" id="continue" data-msg="key.submit" ${canContinue ? "" : "disabled"}>Continue</button>`;
}

function shapeLine(shape: Extract<SetupProgress, { step: "key" }>["shape"]): string {
  switch (shape.kind) {
    case "empty":
      return "";
    case "ok":
      return "✓ That looks like a Bedrock key";
    case "warning":
    case "error":
      return esc(shape.message);
  }
}

function stepHeader(n: 1 | 2, title: string): string {
  return `<p class="step">Step ${n} of 2 · ${esc(title)}</p>
<div class="progress" aria-hidden="true"><span class="dot on"></span><span class="bar ${n === 2 ? "on" : ""}"></span><span class="dot ${n === 2 ? "on" : ""}"></span></div>`;
}

function healthy(state: Extract<PanelState, { kind: "healthy" }>): string {
  const head = state.interruption
    ? `<p class="status ${state.interruption.level}"><span class="mark" aria-hidden="true">${state.interruption.level === "error" ? "✗" : "⚠"}</span> ${esc(state.interruption.sentence)}</p>
${state.interruption.action ? `<button class="primary" data-action="${esc(state.interruption.action.command)}">${esc(state.interruption.action.title)}</button>` : ""}`
    : `<p class="status ok"><span class="mark" aria-hidden="true">✓</span> Everything is working</p>
<p class="muted">${esc(whenLine(state.keySetAt, state.lastTestedAt))}</p>
<button class="primary" data-action="sensibleDefaults.testConnection">Test connection</button>`;
  const total = Object.values(state.counts).reduce((a, b) => a + b, 0);
  const problems = state.counts.error + state.counts.warning;
  return `${head}
<p class="links">
  <button class="link" data-action="sensibleDefaults.rotateToken">Replace key</button>
  <button class="link" data-action="sensibleDefaults.selectRegion">Change region</button>
</p>
<button class="link details" data-msg="details.toggle" aria-expanded="${state.detailsOpen}">${state.detailsOpen ? "▾" : "▸"} Details (${total} checks${problems > 0 ? `, ${problems} to look at` : ""})</button>`;
}

function whenLine(keySetAt: string | undefined, lastTestedAt: string | undefined): string {
  const parts: string[] = [];
  if (keySetAt) parts.push(`Key set ${ago(keySetAt)}`);
  if (lastTestedAt) parts.push(`tested ${ago(lastTestedAt)}`);
  return parts.join(" · ");
}

function ago(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const days = Math.floor(ms / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

export function esc(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const STYLE = `
:root { color-scheme: light dark; }
body { margin: 0; padding: 12px 16px; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); background: transparent; }
h1 { font-size: 1.1em; font-weight: 600; margin: 4px 0 8px; }
p { margin: 8px 0; line-height: 1.45; }
.muted { color: var(--vscode-descriptionForeground); }
.step { color: var(--vscode-descriptionForeground); font-weight: 600; margin-bottom: 4px; }
.progress { display: flex; align-items: center; gap: 0; margin: 0 0 14px; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: var(--vscode-descriptionForeground); opacity: .4; }
.dot.on { background: var(--vscode-button-background); opacity: 1; }
.bar { flex: 1; height: 2px; background: var(--vscode-descriptionForeground); opacity: .4; }
.bar.on { background: var(--vscode-button-background); opacity: 1; }
button.primary { display: block; width: 100%; margin: 14px 0 8px; padding: 8px 12px; border: none; border-radius: 2px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); font: inherit; cursor: pointer; }
button.primary:hover { background: var(--vscode-button-hoverBackground); }
button.primary:disabled { opacity: .5; cursor: default; }
button.primary:focus-visible, button.link:focus-visible, input:focus-visible, button.icon:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
button.link { background: none; border: none; padding: 0; margin: 0 12px 0 0; color: var(--vscode-textLink-foreground); font: inherit; cursor: pointer; text-decoration: underline; }
button.link:hover { color: var(--vscode-textLink-activeForeground); }
button.details { display: block; margin-top: 16px; text-decoration: none; color: var(--vscode-descriptionForeground); }
.links { margin-top: 4px; }
.field { display: flex; gap: 6px; align-items: stretch; }
input { flex: 1; min-width: 0; padding: 6px 8px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); font: inherit; }
input::placeholder { color: var(--vscode-input-placeholderForeground); }
button.icon { border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 2px; padding: 0 8px; cursor: pointer; font: inherit; }
.feedback { min-height: 1.4em; margin: 6px 0 0; }
.feedback.ok { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
.feedback.warning { color: var(--vscode-editorWarning-foreground); }
.feedback.error { color: var(--vscode-errorForeground); }
details { margin: 10px 0; }
summary { cursor: pointer; color: var(--vscode-textLink-foreground); }
details ol { padding-left: 20px; margin: 8px 0; }
details li { margin: 4px 0; }
code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 2px; }
.status { font-weight: 600; font-size: 1.05em; }
.status .mark { display: inline-block; width: 1.2em; }
.status.ok, .status.pass { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
.status.bad, .status.error { color: var(--vscode-errorForeground); }
.status.warning { color: var(--vscode-editorWarning-foreground); }
.spinner { display: inline-block; width: .9em; height: .9em; border: 2px solid var(--vscode-descriptionForeground); border-top-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; vertical-align: -.1em; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
`;

/**
 * Wiring only. Every click posts a message; the extension decides what happens
 * and sends back a whole new state. The page keeps no state of its own except
 * the text in the key field, which is never sent anywhere but `key.submit`.
 */
const SCRIPT = `
(function () {
  var vscode = acquireVsCodeApi();
  var root = document.getElementById('root');
  function post(m) { vscode.postMessage(m); }

  root.addEventListener('click', function (e) {
    var t = e.target.closest('button');
    if (!t || t.disabled) return;
    if (t.id === 'reveal') {
      var k = document.getElementById('key');
      k.type = k.type === 'password' ? 'text' : 'password';
      return;
    }
    if (t.dataset.msg === 'key.submit') {
      var v = document.getElementById('key').value;
      post({ type: 'key.submit', value: v });
      return;
    }
    if (t.dataset.msg) { post({ type: t.dataset.msg }); return; }
    if (t.dataset.action) { post({ type: 'action.run', command: t.dataset.action }); }
  });

  var key = document.getElementById('key');
  if (key) {
    key.addEventListener('input', function () { post({ type: 'key.changed', value: key.value }); });
    key.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        var c = document.getElementById('continue');
        if (c && !c.disabled) post({ type: 'key.submit', value: key.value });
      }
    });
    key.focus();
  }

  post({ type: 'ready' });
})();
`;
