import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createSession } from "../../../../src/config/apply.js";
import { settingsPath } from "../../../../src/config/paths.js";
import { MemorySnapshotStore } from "../../../../src/config/snapshot.js";
import type { ConfigEnv } from "../../../../src/config/types.js";
import { type CheckResult, countLevels, type HealthReport } from "../../../../src/health/types.js";
import { BUNDLED_MANIFEST } from "../../../../src/manifest/bundled.js";
import type { FlowDeps } from "../../../../src/ui/flows.js";
import { judge, PanelProvider } from "../../../../src/ui/panel/provider.js";
import { window as hostWindow } from "../commandsHost.js";
import { bedrockOk, type FakeCredentialDeps, fakeCredentialDeps } from "../credentialDeps.js";

vi.mock("vscode", async () => await import("../commandsHost.js"));

const TOKEN = "ABSKQmVkcm9ja0FQSUtleUV4YW1wbGVWYWx1ZQ";
const CONSOLE = "https://console.aws.amazon.com/bedrock/home#/api-keys";

let dir: string;
let env: ConfigEnv;
let credential: FakeCredentialDeps;
let logged: string[];
let executed: string[];
let opened: string[];
let contexts: [string, unknown][];
let report: HealthReport | undefined;

const log = {
  info: (m: string) => logged.push(`info ${m}`),
  warn: (m: string) => logged.push(`warn ${m}`),
  error: (m: string) => logged.push(`error ${m}`),
};

/** A fake `WebviewView`: records the HTML the provider set and the options it chose. */
function fakeView() {
  const view = {
    webview: {
      html: "",
      cspSource: "vscode-webview://test",
      options: undefined as unknown,
      handler: undefined as ((raw: unknown) => void) | undefined,
      onDidReceiveMessage(handler: (raw: unknown) => void) {
        this.handler = handler;
        return { dispose() {} };
      },
      messages: [] as unknown[],
      async postMessage(message: unknown) {
        this.messages.push(message);
        return true;
      },
    },
    onDidDispose() {
      return { dispose() {} };
    },
  };
  return view;
}

function flows(): FlowDeps {
  return {
    env,
    session: createSession(),
    manifest: () => BUNDLED_MANIFEST,
    log: log as never,
    runHealth: async () => {},
    markWrite: () => {},
    credential,
    now: () => new Date("2026-09-11T00:00:00Z"),
  };
}

function provider(): PanelProvider {
  return new PanelProvider({
    flows: flows(),
    log: log as never,
    report: () => report,
    lastTestedAt: () => undefined,
    consoleUrl: () => CONSOLE,
    execute: async (command) => {
      executed.push(command);
    },
    openExternal: async (url) => {
      opened.push(url);
    },
    setContext: async (key, value) => {
      contexts.push([key, value]);
    },
  });
}

function check(
  id: CheckResult["id"],
  group: CheckResult["group"],
  level: CheckResult["level"],
): CheckResult {
  return { id, group, level, label: `${id}`, fix: { kind: "none" } };
}

function reportOf(...results: CheckResult[]): HealthReport {
  return { at: "2026-09-11T00:00:00Z", results, counts: countLevels(results) };
}

const UNCONFIGURED = reportOf(
  check("install.extension", "Installation", "pass"),
  check("config.exists", "Configuration", "error"),
);
const HEALTHY = reportOf(
  check("install.extension", "Installation", "pass"),
  check("config.exists", "Configuration", "pass"),
  check("cred.present", "Credential", "pass"),
);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scd-panel-"));
  env = {
    claudeDir: dir,
    workspaceFolders: [],
    snapshotStore: new MemorySnapshotStore(),
    platform: process.platform,
  };
  credential = fakeCredentialDeps();
  credential.respond = () => bedrockOk();
  logged = [];
  executed = [];
  opened = [];
  contexts = [];
  report = undefined;
});

afterEach(async () => {
  await chmod(dir, 0o700);
  await rm(dir, { recursive: true, force: true });
});

/** Resolve a fake view and wait for the first paint. */
async function mount(p: PanelProvider) {
  const view = fakeView();
  p.resolveWebviewView(view as never);
  await tick();
  return view;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Assigning webview.html replaces the document, just as it does in VS Code. */
async function mountPage(p: PanelProvider) {
  const { Window } = await import("happy-dom");
  const view = fakeView();
  let page: InstanceType<typeof Window>;
  let source = "";
  Object.defineProperty(view.webview, "html", {
    get: () => source,
    set: (html: string) => {
      source = html;
      page?.close();
      // Only our own renderer's script executes here, never external content.
      page = new Window({
        settings: {
          enableJavaScriptEvaluation: true,
          suppressInsecureJavaScriptEnvironmentWarning: true,
        },
      });
      Object.defineProperty(page, "acquireVsCodeApi", {
        value: () => ({ postMessage: (message: unknown) => view.webview.handler?.(message) }),
      });
      page.document.write(html);
    },
  });
  view.webview.postMessage = async (message: unknown) => {
    view.webview.messages.push(message);
    page.dispatchEvent(new page.MessageEvent("message", { data: message }));
    return true;
  };
  p.resolveWebviewView(view as never);
  await tick();
  onTestFinished(() => page.close());
  return {
    view,
    page: () => page,
    input() {
      const input = page.document.querySelector("input");
      if (input === null) throw new Error("The key input is missing");
      return input;
    },
    button(selector: string) {
      const button = page.document.querySelector(selector);
      if (!(button instanceof page.HTMLButtonElement))
        throw new Error(`Missing button: ${selector}`);
      return button;
    },
  };
}

describe("PanelProvider: live webview lifecycle", () => {
  it("advances without waiting for a success notification to be dismissed", async () => {
    const notification = vi
      .spyOn(hostWindow, "showInformationMessage")
      .mockImplementation(() => new Promise(() => {}));
    onTestFinished(() => notification.mockRestore());
    const p = provider();
    const ui = await mountPage(p);
    await p.receive({ type: "setup.start" });
    ui.input().value = TOKEN;
    ui.input().dispatchEvent(new (ui.page().Event)("input"));
    await tick();
    ui.button("#continue").click();
    await vi.waitFor(() =>
      expect(p.current()).toMatchObject({
        kind: "setup",
        progress: { step: "result", result: { kind: "ok" } },
      }),
    );
    expect(notification).not.toHaveBeenCalled();
  });

  it("shows secure-save progress and prevents duplicate submissions while the keychain waits", async () => {
    let reject!: (error: Error) => void;
    const save = vi.spyOn(credential.store, "set").mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const p = provider();
    const ui = await mountPage(p);
    await p.receive({ type: "setup.start" });
    const pending = p.receive({ type: "key.submit", value: TOKEN });
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(ui.button("#continue").disabled).toBe(true);
    expect(ui.page().document.querySelector("#key-saving")?.hasAttribute("hidden")).toBe(false);
    await p.receive({ type: "key.submit", value: TOKEN });
    expect(save).toHaveBeenCalledTimes(1);
    reject(new Error("keychain unavailable"));
    await pending;
    expect(ui.button("#continue").disabled).toBe(false);
    expect(ui.page().document.body.textContent).toContain("couldn't be saved securely");
  });
  it("preserves input when a background health check fails", async () => {
    report = UNCONFIGURED;
    const p = provider();
    const ui = await mountPage(p);
    ui.button('[data-msg="setup.start"]').click();
    await tick();
    const key = ui.input();
    key.value = TOKEN;
    key.dispatchEvent(new (ui.page().Event)("input"));
    await tick();
    p.healthFailed("Settings access denied. Ask IT to check access.");
    await tick();
    expect(ui.input()).toBe(key);
    expect(key.value).toBe(TOKEN);
    expect(ui.page().document.querySelector("#key-problem")?.textContent).toContain(
      "access denied",
    );
  });

  it("replaces an initial failed health check with actionable recovery and can recover", async () => {
    const p = provider();
    const ui = await mountPage(p);
    p.healthFailed("Settings access denied.");
    await tick();
    expect(ui.page().document.body.textContent).toContain("Settings access denied.");
    expect(ui.button('[data-action="sensibleDefaults.runHealthCheck"]')).toBeDefined();
    report = UNCONFIGURED;
    p.healthSucceeded();
    await tick();
    expect(ui.button('[data-msg="setup.start"]')).toBeDefined();
  });
  it.each(["click", "Enter"])(
    "preserves the key through validation/refresh and submits with %s",
    async (submit) => {
      report = UNCONFIGURED;
      const p = provider();
      const ui = await mountPage(p);
      ui.button('[data-msg="setup.start"]').click();
      await tick();
      const page = ui.page();
      const key = ui.input();
      key.value = TOKEN;
      key.dispatchEvent(new page.Event("input"));
      await tick();
      expect(ui.input().value).toBe(TOKEN);
      expect(page.document.querySelector("#shape")?.textContent).toContain(
        "That looks like a Bedrock key",
      );
      p.refresh();
      await tick();
      expect(ui.page()).toBe(page);
      expect(page.document.activeElement).toBe(key);
      expect(key.value).toBe(TOKEN);
      if (submit === "click") ui.button("#continue").click();
      else key.dispatchEvent(new page.KeyboardEvent("keydown", { key: "Enter" }));
      await vi.waitFor(() =>
        expect(ui.page().document.body.textContent).toContain("Your Bedrock API key works"),
      );
      expect(credential.requests).toHaveLength(1);
      expect((await credential.store.get())?.token).toBe(TOKEN);
      expect(JSON.stringify(ui.view.webview.messages)).not.toContain(TOKEN);
      expect(ui.view.webview.html).not.toContain(TOKEN);
    },
  );

  it("keeps invalid input editable and updates feedback while typing", async () => {
    const p = provider();
    const ui = await mountPage(p);
    await p.receive({ type: "setup.start" });
    const page = ui.page();
    const key = ui.input();
    for (const value of ["AKIAIOSFODNN7EXAMPLE", "ABSK", TOKEN, ""]) {
      key.value = value;
      key.dispatchEvent(new page.Event("input"));
      await tick();
      expect(ui.page()).toBe(page);
      expect(key.value).toBe(value);
      expect(ui.button("#continue").disabled).toBe(value === "" || value.startsWith("AKIA"));
    }
    expect(credential.requests).toHaveLength(0);
  });

  it("preserves the key and shows a recoverable save failure", async () => {
    vi.spyOn(credential.store, "set").mockRejectedValue(new Error("test keychain unavailable"));
    const p = provider();
    const ui = await mountPage(p);
    await p.receive({ type: "setup.start" });
    const page = ui.page();
    const key = ui.input();
    key.value = TOKEN;
    key.dispatchEvent(new page.Event("input"));
    await tick();
    ui.button("#continue").click();
    await vi.waitFor(() =>
      expect(ui.page().document.body.textContent).toContain("couldn't be saved securely"),
    );
    expect(ui.page()).toBe(page);
    expect(key.value).toBe(TOKEN);
    expect(ui.button("#continue").disabled).toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "reports an unwritable settings directory without saving or testing the key",
    async () => {
      const p = provider();
      const ui = await mountPage(p);
      await p.receive({ type: "setup.start" });
      const key = ui.input();
      key.value = TOKEN;
      key.dispatchEvent(new (ui.page().Event)("input"));
      await tick();
      await chmod(dir, 0o500);
      ui.button("#continue").click();
      await vi.waitFor(() =>
        expect(ui.page().document.body.textContent).toContain("Your device blocked access"),
      );
      expect(ui.input()).toBe(key);
      expect(key.value).toBe(TOKEN);
      expect(await credential.store.get()).toBeUndefined();
      expect(credential.requests).toHaveLength(0);
    },
  );

  it("reports a failed snapshot save without proceeding with credential setup", async () => {
    vi.spyOn(env.snapshotStore, "save").mockRejectedValue(
      Object.assign(new Error("state write blocked"), { code: "EACCES" }),
    );
    const p = provider();
    const ui = await mountPage(p);
    await p.receive({ type: "setup.start" });
    await p.receive({ type: "key.submit", value: TOKEN });
    expect(ui.page().document.body.textContent).toContain("Your device blocked access");
    expect(await credential.store.get()).toBeUndefined();
    expect(credential.requests).toHaveLength(0);
  });

  it("refuses setup over malformed settings instead of saving a key anyway", async () => {
    await writeFile(settingsPath(dir), "broken JSON");
    const p = provider();
    const ui = await mountPage(p);
    await p.receive({ type: "setup.start" });
    await p.receive({ type: "key.submit", value: TOKEN });
    expect(ui.page().document.body.textContent).toContain("settings file is damaged");
    expect(await readFile(settingsPath(dir), "utf8")).toBe("broken JSON");
    expect(await credential.store.get()).toBeUndefined();
    expect(credential.requests).toHaveLength(0);
  });

  it("contains a failed retest and replaces the spinner with a recovery action", async () => {
    const p = provider();
    const ui = await mountPage(p);
    vi.spyOn(credential.store, "get").mockRejectedValue(new Error("keychain unavailable"));
    await expect(p.receive({ type: "setup.retest" })).resolves.toBeUndefined();
    await tick();
    expect(ui.page().document.body.textContent).toContain("That action couldn't finish");
    expect(ui.button('[data-action="sensibleDefaults.runHealthCheck"]').textContent).toBe(
      "Check configuration",
    );
    expect(ui.page().document.querySelector(".spinner")).toBeNull();
  });
});

describe("PanelProvider: resolve and paint", () => {
  it("locks the webview down: scripts on, no local resources, CSP nonce'd", async () => {
    const p = provider();
    const view = await mount(p);
    expect(view.webview.options).toEqual({ enableScripts: true, localResourceRoots: [] });
    expect(view.webview.html).toContain("default-src 'none'");
    expect(view.webview.html).toMatch(/nonce-[A-Za-z0-9+/=]{16,}/);
  });

  it("paints loading before the first report, then unconfigured, then healthy", async () => {
    const p = provider();
    const view = await mount(p);
    expect(view.webview.html).toContain('data-state="loading"');

    report = UNCONFIGURED;
    p.refresh();
    await tick();
    expect(view.webview.html).toContain('data-state="unconfigured"');

    report = HEALTHY;
    await credential.store.set({ token: TOKEN, setAt: "2026-09-08T00:00:00Z" });
    p.refresh();
    await tick();
    expect(view.webview.html).toContain('data-state="healthy"');
  });

  it("regenerates the nonce on every paint", async () => {
    const p = provider();
    const view = await mount(p);
    const first = view.webview.html.match(/nonce="([^"]+)"/)?.[1];
    p.refresh();
    await tick();
    const second = view.webview.html.match(/nonce="([^"]+)"/)?.[1];
    expect(first).toBeDefined();
    expect(second).not.toBe(first);
  });
});

describe("PanelProvider: the two-step setup", () => {
  it("Set up now opens step 1 with Continue disabled", async () => {
    report = UNCONFIGURED;
    const p = provider();
    const view = await mount(p);
    await p.receive({ type: "setup.start" });
    expect(view.webview.html).toContain("Step 1 of 2");
    expect(view.webview.html).toMatch(/id="continue"[^>]*disabled/);
  });

  it("live shape feedback enables Continue for a plausible key and names a wrong one", async () => {
    report = UNCONFIGURED;
    const p = provider();
    const view = await mount(p);
    await p.receive({ type: "setup.start" });
    const html = view.webview.html;
    await p.receive({ type: "key.changed", value: "AKIAIOSFODNN7EXAMPLE" });
    expect(view.webview.messages.at(-1)).toMatchObject({
      type: "key.feedback",
      shape: { kind: "error", message: expect.stringContaining("looks like an AWS access key ID") },
    });
    await p.receive({ type: "key.changed", value: TOKEN });
    expect(view.webview.messages.at(-1)).toMatchObject({
      type: "key.feedback",
      shape: { kind: "ok" },
    });
    expect(view.webview.html).toBe(html);
  });

  it("submit writes the defaults and the key, tests it, and lands on Done", async () => {
    report = UNCONFIGURED;
    const p = provider();
    const view = await mount(p);
    await p.receive({ type: "setup.start" });
    await p.receive({ type: "key.submit", value: `  ${TOKEN}\n` });

    // The key: keychain, terminals, settings file.
    expect((await credential.store.get())?.token).toBe(TOKEN);
    expect(credential.terminal.applied).toEqual([TOKEN]);
    const settings = JSON.parse(await readFile(settingsPath(dir), "utf8"));
    expect(settings.env.AWS_BEARER_TOKEN_BEDROCK).toBe(TOKEN);
    // The eight non-secret keys, written silently — the region among them (D-1).
    expect(settings.env.AWS_REGION).toBe(BUNDLED_MANIFEST.defaults.env.AWS_REGION);
    expect(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(
      BUNDLED_MANIFEST.defaults.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    );
    // The test ran, once, with the key, and the panel shows the ok outcome.
    expect(credential.requests).toHaveLength(1);
    expect(credential.requests[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(credential.recorded[0]).toMatchObject({ kind: "ok" });
    expect(view.webview.html).toContain('data-msg="setup.finish"');
    expect(view.webview.html).toContain("Your Bedrock API key works");
  });

  it("a refused key lands on Try a different key, and restart clears the field state", async () => {
    report = UNCONFIGURED;
    credential.respond = () =>
      new Response('{"Message":"Authentication failed: Please make sure your API Key is valid."}', {
        status: 403,
      });
    const p = provider();
    const view = await mount(p);
    await p.receive({ type: "setup.start" });
    await p.receive({ type: "key.submit", value: TOKEN });
    expect(view.webview.html).toContain("wouldn't accept");
    expect(view.webview.html).toContain('data-msg="setup.restart"');
    await p.receive({ type: "setup.restart" });
    expect(view.webview.html).toContain("Step 1 of 2");
  });

  it("refuses to submit a key the shape check rejects outright", async () => {
    report = UNCONFIGURED;
    const p = provider();
    const view = await mount(p);
    await p.receive({ type: "setup.start" });
    await p.receive({ type: "key.submit", value: "AKIAIOSFODNN7EXAMPLE" });
    expect(await credential.store.get()).toBeUndefined();
    expect(credential.requests).toHaveLength(0);
    expect(view.webview.html).toContain("Step 1 of 2");
  });

  it("Done leaves setup and asks for a health run", async () => {
    report = UNCONFIGURED;
    const p = provider();
    await mount(p);
    await p.receive({ type: "setup.start" });
    await p.receive({ type: "key.submit", value: TOKEN });
    await p.receive({ type: "setup.finish" });
    expect(executed).toEqual(["sensibleDefaults.runHealthCheck"]);
    expect(p.current().kind).not.toBe("setup");
  });

  it("Open console goes through openExternal with the manifest's URL", async () => {
    report = UNCONFIGURED;
    const p = provider();
    await mount(p);
    await p.receive({ type: "console.open" });
    expect(opened).toEqual([CONSOLE]);
  });

  it("Check my setup runs adoptToken", async () => {
    report = UNCONFIGURED;
    const p = provider();
    await mount(p);
    await p.receive({ type: "setup.check" });
    expect(executed).toEqual(["sensibleDefaults.adoptToken"]);
  });
});

describe("PanelProvider: the token never leaves", () => {
  it("never puts the key in the page, the log, or the state during setup", async () => {
    report = UNCONFIGURED;
    const p = provider();
    const view = await mount(p);
    await p.receive({ type: "setup.start" });
    await p.receive({ type: "key.changed", value: TOKEN });
    expect(view.webview.html).not.toContain(TOKEN);
    await p.receive({ type: "key.submit", value: TOKEN });
    expect(view.webview.html).not.toContain(TOKEN);
    expect(JSON.stringify(p.current())).not.toContain(TOKEN);
    expect(logged.join("\n")).not.toContain(TOKEN);
  });

  it("keeps only the timestamp from the keychain in the healthy state", async () => {
    // The healthy state reads the store on every paint. A `...stored` spread
    // there would carry the token into `PanelState`, and from there into any
    // future message to the page. This is the pin the mutation pass demanded.
    report = HEALTHY;
    await credential.store.set({ token: TOKEN, setAt: "2026-09-08T00:00:00Z" });
    const p = provider();
    await mount(p);
    const state = p.current();
    expect(state.kind).toBe("healthy");
    expect(state).toMatchObject({ keySetAt: "2026-09-08T00:00:00Z" });
    // Not in the state, and not anywhere on the provider either: the only
    // copy of the token lives in the keychain.
    expect(JSON.stringify(p)).not.toContain(TOKEN);
  });
});

describe("PanelProvider: healthy state and Details", () => {
  it("toggles Details through a context key so the tree view can show", async () => {
    report = HEALTHY;
    await credential.store.set({ token: TOKEN, setAt: "2026-09-08T00:00:00Z" });
    const p = provider();
    const view = await mount(p);
    await p.receive({ type: "details.toggle" });
    expect(contexts).toEqual([["sensibleDefaults.detailsOpen", true]]);
    expect(view.webview.html).toContain('aria-expanded="true"');
    await p.receive({ type: "details.toggle" });
    expect(contexts.at(-1)).toEqual(["sensibleDefaults.detailsOpen", false]);
  });

  it("runs an allowlisted action and drops the rest", async () => {
    report = HEALTHY;
    await credential.store.set({ token: TOKEN, setAt: "2026-09-08T00:00:00Z" });
    const p = provider();
    await mount(p);
    await p.receive({ type: "action.run", command: "sensibleDefaults.testConnection" });
    await p.receive({ type: "action.run", command: "workbench.action.terminal.sendSequence" });
    await p.receive({ type: "eval", code: "1" });
    expect(executed).toEqual(["sensibleDefaults.testConnection"]);
    expect(logged.filter((l) => l.includes("does not accept"))).toHaveLength(2);
  });
});

describe("judge", () => {
  it("mirrors validateInput as data", () => {
    expect(judge("")).toEqual({ kind: "empty" });
    expect(judge("   ")).toEqual({ kind: "empty" });
    expect(judge(TOKEN)).toEqual({ kind: "ok" });
    expect(judge("AKIAIOSFODNN7EXAMPLE").kind).toBe("error");
    expect(judge("ABSKshort").kind).toBe("warning");
  });
});
