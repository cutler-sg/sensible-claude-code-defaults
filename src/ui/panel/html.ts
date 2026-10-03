/**
 * The panel's HTML, as a pure function of `PanelState`.
 *
 * Security posture (plan M8 Part A):
 * - CSP `default-src 'none'`; scripts and styles only with a per-render nonce.
 * - No remote content of any kind. No `<a href="http…">`: external links go
 *   through `console.open`, which the extension resolves with `openExternal`.
 * - The token never appears here. The reducer never has it; the only place the
 *   value exists on the page is the input the user typed it into, and it leaves
 *   by `postMessage` for validation and submission.
 *
 * Every colour is a VS Code theme variable, so the page matches light, dark and
 * high-contrast with no palette of its own.
 */

import { MODEL_STATUS_LABELS, type ModelsPanel, modelHealth } from "../modelPresentation.js";
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
    case "failed":
      return `<p class="feedback error" role="alert">${esc(state.message)}</p>
<button class="primary" data-action="sensibleDefaults.runHealthCheck">Check configuration</button>
<button class="link" data-action="sensibleDefaults.copyDiagnostics">Copy diagnostics</button>`;
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
  const canContinue =
    !progress.busy && (progress.shape.kind === "ok" || progress.shape.kind === "warning");
  return `${stepHeader(1, "Your Bedrock API key")}
<label for="key">Paste your key below.</label>
<div class="field">
  <input id="key" type="password" autocomplete="off" spellcheck="false" placeholder="Bedrock API key" aria-describedby="shape" ${progress.busy ? "disabled" : ""}>
  <button class="icon" id="reveal" type="button" aria-label="Show or hide the key" title="Show or hide">👁</button>
</div>
<p id="shape" class="feedback ${progress.shape.kind}" aria-live="polite">${feedback}</p>
<p id="key-problem" class="feedback error" role="alert" ${progress.problem ? "" : "hidden"}>${esc(progress.problem ?? "")}</p>
<p id="key-saving" role="status" ${progress.busy ? "" : "hidden"}>Saving securely… Check for a system keychain prompt.</p>
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
<p class="muted">Continue tests your configured models with tiny billable AWS requests. A first invocation can initiate a Marketplace subscription if your permissions allow it. Automatic checks are optional.</p>
<button class="primary" id="continue" data-msg="key.submit" ${canContinue ? "" : "disabled"}>${progress.busy ? "Saving…" : "Continue"}</button>`;
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
  const availability = state.models ? modelHealth(state.models.snapshot) : undefined;
  const verified = !availability || availability.level === "pass";
  const head = state.interruption
    ? `<p class="status ${state.interruption.level}"><span class="mark" aria-hidden="true">${state.interruption.level === "error" ? "✗" : "⚠"}</span> ${esc(state.interruption.sentence)}</p>
${state.interruption.action ? `<button class="primary" data-action="${esc(state.interruption.action.command)}">${esc(state.interruption.action.title)}</button>` : ""}`
    : `<p class="status ${verified ? "ok" : "info"}"><span class="mark" aria-hidden="true">${verified ? "✓" : "ℹ"}</span> ${availability ? esc(availability.label) : "Everything is working"}</p>
<p class="muted">${esc(whenLine(state.keySetAt, state.lastTestedAt))}</p>
<button class="primary" data-action="sensibleDefaults.testConnection">Test connection</button>`;
  const total = Object.values(state.counts).reduce((a, b) => a + b, 0);
  const problems = state.counts.error + state.counts.warning;
  return `${head}
<p class="links">
  <button class="link" data-action="sensibleDefaults.rotateToken">Replace key</button>
  <button class="link" data-action="sensibleDefaults.selectRegion">Change region</button>
</p>
<button class="link details" data-msg="details.toggle" aria-expanded="${state.detailsOpen}">${state.detailsOpen ? "▾" : "▸"} Details (${total} checks${problems > 0 ? `, ${problems} to look at` : ""})</button>
${state.models ? modelsSection(state.models) : ""}`;
}

function modelsSection(models: ModelsPanel): string {
  const { snapshot } = models;
  const scopes = [...new Set(snapshot.rows.map((row) => row.scope))];
  const groups = [
    ...new Map(snapshot.rows.map((row) => [row.catalogueId ?? row.label, row])).values(),
  ];
  const cells = groups
    .map(
      (group) =>
        `<tr><th scope="row">${esc(group.label)}${snapshot.rows.some((row) => (row.catalogueId ?? row.label) === (group.catalogueId ?? group.label) && row.configured) ? '<span class="model-note">Configured</span>' : ""}</th>${scopes
          .map((scope) => {
            const rows = snapshot.rows.filter(
              (row) =>
                (row.catalogueId ?? row.label) === (group.catalogueId ?? group.label) &&
                row.scope === scope,
            );
            return `<td>${rows.length ? rows.map((row) => `<span class="model-result ${row.status === "available" && !row.stale ? "verified" : ""}">${esc(MODEL_STATUS_LABELS[row.status])}${row.stale ? '<span class="model-note">Stale · recheck due</span>' : ""}</span>`).join("<br>") : '<span class="muted">No documented route</span>'}</td>`;
          })
          .join("")}</tr>`,
    )
    .join("");
  return `<section class="models" aria-labelledby="models-title">
<h2 id="models-title">Model availability</h2>
<p class="muted">Source region: <strong>${esc(snapshot.region ?? "not configured")}</strong>. Processing geography is shown separately.</p>
${models.problem ? `<p class="feedback error" role="alert">${esc(models.problem)}</p>` : ""}
<p role="status">${snapshot.checking ? "Checking access with AWS…" : `Credential: ${snapshot.credential === "valid" ? "verified by an invocation" : snapshot.credential === "invalid" ? "rejected by AWS" : "not yet verified"}`}</p>
${
  snapshot.rows.length
    ? `<div class="matrix-scroll" tabindex="0" role="region" aria-label="Model availability by processing geography"><table><caption>Availability for this credential and source region</caption><thead><tr><th scope="col">Model</th>${scopes.map((scope) => `<th scope="col">${esc(scopeName(scope))}</th>`).join("")}</tr></thead><tbody>${cells}</tbody></table></div>
<details data-persist="model-evidence"><summary>Model IDs and check evidence</summary>${snapshot.rows.map((row) => `<div class="model-evidence"><strong>${esc(row.label)} · ${esc(scopeName(row.scope))}</strong><code>${esc(row.modelId)}</code><p>${esc(MODEL_STATUS_LABELS[row.status])}${row.reason ? ` · ${esc(row.reason)}` : ""}</p><p class="muted">${row.checkedAt === undefined ? "Not checked" : `Checked ${esc(new Date(row.checkedAt).toISOString())}`}${row.lastSuccessAt === undefined ? "" : `<br>Last worked ${esc(new Date(row.lastSuccessAt).toISOString())}`}</p>${row.preflight ? `<p class="muted">Availability metadata: ${esc(row.preflight.status === "available" ? "Available (metadata only)" : MODEL_STATUS_LABELS[row.preflight.status])} · ${esc(new Date(row.preflight.checkedAt).toISOString())}${row.preflight.reason ? ` · ${esc(row.preflight.reason)}` : ""}</p>` : ""}</div>`).join("")}</details>`
    : "<p>Configure your models and region to check availability.</p>"
}
<p class="model-actions"><button class="secondary" data-action="sensibleDefaults.recheckModels" ${snapshot.checking ? "disabled" : ""}>${snapshot.checking ? "Checking…" : "Recheck models"}</button>${models.upgrades ? '<button class="secondary" data-action="sensibleDefaults.reviewModelUpgrade">Review available upgrade</button>' : ""}</p>
<p class="model-actions"><button class="link" data-action="sensibleDefaults.selectProcessingScopes">Processing policy</button><button class="link" data-action="sensibleDefaults.copyModelAccessRequest">Copy administrator request</button></p>
<p class="muted">${models.automatic ? "Automatic checks are enabled. Configured models are rechecked after 24 hours; alternatives after seven days." : "Automatic checks are off. Enable them to refresh stale results when VS Code opens or regains focus."}</p>
<button class="link" data-action="sensibleDefaults.configureModelChecks">${models.automatic ? "Turn off automatic checks" : "Enable automatic checks"}</button>
<p class="muted">Global profiles may process requests outside your source region. A successful check records access at that time; it does not guarantee future access.</p>
</section>`;
}

function scopeName(scope: string): string {
  return (
    (
      {
        global: "Global",
        us: "US",
        eu: "EU",
        apac: "APAC",
        au: "Australia",
        jp: "Japan",
        regional: "Regional",
        unknown: "Unclassified",
      } as Record<string, string>
    )[scope] ?? scope
  );
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
body { margin: 0; padding: 12px 16px; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); background: transparent; overflow-wrap: anywhere; }
h1 { font-size: 1.1em; font-weight: 600; margin: 4px 0 8px; }
p { margin: 8px 0; line-height: 1.45; }
.muted { color: var(--vscode-descriptionForeground); }
.step { color: var(--vscode-descriptionForeground); font-weight: 600; margin-bottom: 4px; }
.progress { display: flex; align-items: center; gap: 0; margin: 0 0 14px; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: var(--vscode-descriptionForeground); opacity: .4; }
.dot.on { background: var(--vscode-progressBar-background); opacity: 1; }
.bar { flex: 1; height: 2px; background: var(--vscode-descriptionForeground); opacity: .4; }
.bar.on { background: var(--vscode-progressBar-background); opacity: 1; }
button.primary { display: block; width: 100%; margin: 14px 0 8px; padding: 8px 12px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); font: inherit; cursor: pointer; }
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
.feedback.ok { color: var(--vscode-terminal-ansiGreen, var(--vscode-foreground)); }
.feedback.warning { color: var(--vscode-editorWarning-foreground); }
.feedback.error { color: var(--vscode-errorForeground); }
details { margin: 10px 0; }
summary { cursor: pointer; color: var(--vscode-textLink-foreground); }
details ol { padding-left: 20px; margin: 8px 0; }
details li { margin: 4px 0; }
code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 2px; }
.status { font-weight: 600; font-size: 1.05em; }
.status .mark { display: inline-block; width: 1.2em; }
.status.ok, .status.pass { color: var(--vscode-terminal-ansiGreen, var(--vscode-foreground)); }
.status.bad, .status.error { color: var(--vscode-errorForeground); }
.status.warning { color: var(--vscode-editorWarning-foreground); }
.spinner { display: inline-block; width: .9em; height: .9em; border: 2px solid var(--vscode-descriptionForeground); border-top-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; vertical-align: -.1em; }
h2 { font-size: 1.05em; margin: 0 0 8px; font-weight: 600; }
.models { margin-top: 24px; padding-top: 18px; border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); min-width: 0; }
.matrix-scroll { max-width: 100%; overflow-x: auto; margin: 14px 0; }
.matrix-scroll:focus-visible, summary:focus-visible, button.secondary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
table { width: 100%; border-collapse: collapse; font-size: .95em; }
caption { text-align: left; color: var(--vscode-descriptionForeground); padding-bottom: 8px; }
th, td { text-align: left; vertical-align: top; padding: 9px 10px; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); min-width: 100px; }
th:first-child { padding-left: 0; min-width: 105px; }
.model-note { display: block; color: var(--vscode-descriptionForeground); font-size: .9em; font-weight: normal; margin-top: 4px; }
.model-result.verified { color: var(--vscode-terminal-ansiGreen, var(--vscode-foreground)); }
.model-evidence { padding: 10px 0; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); }
.model-evidence code { display: block; margin-top: 6px; white-space: normal; overflow-wrap: anywhere; }
.model-actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
button.secondary { font: inherit; cursor: pointer; padding: 6px 10px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
button.secondary:disabled { opacity: .5; cursor: default; }
::selection { background: var(--vscode-editor-selectionBackground); }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
`;

/**
 * Wiring only. Every click posts a message; the extension decides what happens
 * and sends back a new screen or feedback for the existing key field. The
 * key stays in that field until setup advances; it is never persisted by the page.
 */
const SCRIPT = `
(function () {
  var vscode = acquireVsCodeApi();
  var root = document.getElementById('root');
  var saved = vscode.getState() || {};
  document.querySelectorAll('details[data-persist]').forEach(function (detail) {
    detail.open = !!saved[detail.dataset.persist];
    detail.addEventListener('toggle', function () { saved[detail.dataset.persist] = detail.open; vscode.setState(saved); });
  });
  function post(m) { vscode.postMessage(m); }

  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || m.type !== 'key.feedback') return;
    var feedback = document.getElementById('shape');
    var button = document.getElementById('continue');
    var problem = document.getElementById('key-problem');
    if (!feedback || !button || !problem) return;
    feedback.className = 'feedback ' + m.shape.kind;
    feedback.textContent = m.shape.kind === 'ok' ? '✓ That looks like a Bedrock key' : (m.shape.message || '');
    button.disabled = !!m.busy || (m.shape.kind !== 'ok' && m.shape.kind !== 'warning');
    button.textContent = m.busy ? 'Saving…' : 'Continue';
    document.getElementById('key').disabled = !!m.busy;
    document.getElementById('key-saving').hidden = !m.busy;
    problem.textContent = m.problem || '';
    problem.hidden = !m.problem;
  });

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
