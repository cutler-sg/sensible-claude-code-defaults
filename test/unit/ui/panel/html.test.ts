import { describe, expect, it } from "vitest";
import { countLevels } from "../../../../src/health/types.js";
import { esc, render } from "../../../../src/ui/panel/html.js";
import type { PanelState } from "../../../../src/ui/panel/state.js";

const NONCE = "n0nc3+test/==";
const CSP = "vscode-webview://abc";
const CONSOLE = "https://console.aws.amazon.com/bedrock/home#/api-keys";
const SECRET = "ABSKQmVkcm9ja0FQSUtleUV4YW1wbGVWYWx1ZQ";

const healthy: PanelState = {
  kind: "healthy",
  keySetAt: "2026-09-08T00:00:00Z",
  lastTestedAt: "2026-09-11T00:00:00Z",
  interruption: undefined,
  counts: countLevels([]),
  detailsOpen: false,
};

const STATES: PanelState[] = [
  { kind: "loading" },
  { kind: "unconfigured" },
  { kind: "setup", progress: { step: "key", shape: { kind: "empty" } }, consoleUrl: CONSOLE },
  {
    kind: "setup",
    progress: { step: "key", shape: { kind: "warning", message: "short" }, problem: "nope" },
    consoleUrl: CONSOLE,
  },
  { kind: "setup", progress: { step: "testing" }, consoleUrl: CONSOLE },
  {
    kind: "setup",
    progress: { step: "result", result: { kind: "ok", model: "m" } },
    consoleUrl: CONSOLE,
  },
  {
    kind: "setup",
    progress: { step: "result", result: { kind: "bad-credential", status: 403 } },
    consoleUrl: CONSOLE,
  },
  {
    kind: "setup",
    progress: { step: "result", result: { kind: "unknown", status: 502 } },
    consoleUrl: CONSOLE,
  },
  healthy,
  {
    ...healthy,
    interruption: {
      level: "warning",
      sentence: "Your key is 92 days old",
      action: { command: "sensibleDefaults.rotateToken", title: "Replace key" },
    },
  },
  { ...healthy, detailsOpen: true },
];

const html = (state: PanelState) => render(state, { nonce: NONCE, cspSource: CSP });

describe("render: security posture, every state", () => {
  it.each(STATES.map((s) => [s.kind + ("progress" in s ? `/${s.progress.step}` : ""), s]))(
    "%s carries a nonce'd CSP with default-src 'none'",
    (_name, state) => {
      const out = html(state);
      expect(out).toMatch(/Content-Security-Policy/);
      expect(out).toContain("default-src 'none'");
      expect(out).toContain(`'nonce-${NONCE}'`);
      // Every script and style tag is nonce'd; none is bare.
      for (const tag of out.match(/<(script|style)\b[^>]*>/g) ?? []) {
        expect(tag).toContain(`nonce="${NONCE}"`);
      }
    },
  );

  it("never contains a navigable external link", () => {
    for (const state of STATES) {
      expect(html(state)).not.toMatch(/<a\s[^>]*href=["']https?:/i);
    }
  });

  it("puts the console URL on screen as text, not as a link", () => {
    const out = html(STATES[2] as PanelState);
    expect(out).toContain(esc(CONSOLE));
    expect(out).toContain('data-msg="console.open"');
  });

  it("has exactly one primary button in every state that has any", () => {
    for (const state of STATES) {
      const count = (html(state).match(/class="primary"/g) ?? []).length;
      expect(count, state.kind).toBeLessThanOrEqual(1);
    }
    // And the states that must have one, do.
    expect(html({ kind: "unconfigured" })).toContain('class="primary"');
    expect(html(healthy)).toContain('class="primary"');
  });

  it("the key field is the only text input in the whole experience", () => {
    for (const state of STATES) {
      const inputs = html(state).match(/<input\b/g) ?? [];
      const expected = state.kind === "setup" && state.progress.step === "key" ? 1 : 0;
      expect(inputs.length, state.kind).toBe(expected);
    }
    expect(html(STATES[2] as PanelState)).toMatch(/<input[^>]*type="password"/);
  });

  it("escapes what it interpolates", () => {
    const out = html({
      ...healthy,
      interruption: {
        level: "error",
        sentence: `<img src=x onerror="alert(1)">`,
        action: undefined,
      },
    });
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
  });

  it("never renders a token, even if one were smuggled into state", () => {
    // Belt and braces: the reducer cannot produce this, but the renderer must
    // not be the thing that would leak it if it could.
    const smuggled = { ...healthy, keySetAt: SECRET } as PanelState;
    // `ago()` parses it as a date and fails, so the literal never appears.
    expect(html(smuggled)).not.toContain(SECRET);
  });
});

describe("render: what each state says", () => {
  it("unconfigured: one button, one link, no jargon", () => {
    const out = html({ kind: "unconfigured" });
    expect(out).toContain("Set up now");
    expect(out).toContain("Check my setup");
    expect(out).not.toMatch(/inference|IAM|SigV4|env\b/i);
  });

  it("step 1 disables Continue until the shape check passes", () => {
    const empty = html(STATES[2] as PanelState);
    expect(empty).toMatch(/id="continue"[^>]*disabled/);
    const ok = html({
      kind: "setup",
      progress: { step: "key", shape: { kind: "ok" } },
      consoleUrl: CONSOLE,
    });
    expect(ok).not.toMatch(/id="continue"[^>]*disabled/);
    const warn = html(STATES[3] as PanelState);
    expect(warn).not.toMatch(/id="continue"[^>]*disabled/);
  });

  it("step 1 shows a submit problem when there is one", () => {
    expect(html(STATES[3] as PanelState)).toContain("nope");
  });

  it("step 2 shows the outcome sentence and the right primary", () => {
    expect(html(STATES[5] as PanelState)).toContain('data-msg="setup.finish"');
    expect(html(STATES[6] as PanelState)).toContain('data-msg="setup.restart"');
    expect(html(STATES[7] as PanelState)).toContain("HTTP 502");
  });

  it("healthy: everything working, three actions, details closed", () => {
    const out = html(healthy);
    expect(out).toContain("Everything is working");
    expect(out).toContain('data-action="sensibleDefaults.testConnection"');
    expect(out).toContain('data-action="sensibleDefaults.rotateToken"');
    expect(out).toContain('data-action="sensibleDefaults.selectRegion"');
    expect(out).toContain('aria-expanded="false"');
  });

  it("an interruption replaces the header and its button", () => {
    const out = html(STATES[9] as PanelState);
    expect(out).toContain("Your key is 92 days old");
    expect(out).toContain('class="primary" data-action="sensibleDefaults.rotateToken"');
    expect(out).not.toContain("Everything is working");
  });
});
