import { describe, expect, it, vi } from "vitest";
import manifest from "../../../package.json";
import type { JsonObject, Settings } from "../../../src/config/types.js";
import { ALL_CHECKS } from "../../../src/health/catalogue.js";
import type { CheckContext, Remediation } from "../../../src/health/types.js";
import { makeCtx, okRead, okSettings } from "../health/fixture.js";

// The catalogue is `vscode`-free by design, but `commands.ts` is not, and the
// COMMAND_IDS import below reaches it. The command stub is the right half of
// the API to stand in here.
vi.mock("vscode", async () => await import("./commandsHost.js"));

const contributed = new Set(manifest.contributes.commands.map((c) => c.command));

/**
 * Commands the platform already owns. A check may nominate one as its fix, and
 * we neither contribute nor register those — but the list is closed, because
 * "some other extension probably provides it" is how a wrench button comes to
 * do nothing at all.
 */
const BUILT_INS = new Set(["workbench.extensions.installExtension", "extension.open"]);

/**
 * The check bodies are the only place a command id is invented rather than
 * called, so the catalogue is run over contexts that reach every remediation
 * branch and the ids are read off the results.
 */
function fixCommands(): string[] {
  const found = new Set<string>();
  for (const ctx of CONTEXTS) {
    for (const check of ALL_CHECKS) {
      const result = check.run(ctx);
      if (result instanceof Promise) throw new Error(`${check.id} is async; widen this test`);
      collect(found, result.fix);
      for (const child of result.children ?? []) collect(found, child.fix);
    }
  }
  return [...found];
}

function collect(into: Set<string>, fix: Remediation): void {
  if (fix.kind === "command") into.add(fix.command);
}

const CONTEXTS: CheckContext[] = [
  makeCtx(),
  makeCtx({ read: { kind: "absent" }, permissions: { kind: "absent" } }),
  makeCtx({
    read: { kind: "malformed", raw: "{,}", error: "settings.json is not valid JSON" },
    permissions: { kind: "failed", error: "EPERM" },
  }),
  makeCtx({
    drift: [
      {
        key: "env.AWS_REGION",
        current: "eu-west-9",
        lastApplied: "us-east-1",
        recommended: "us-east-1",
      },
    ],
  }),
  makeCtx({ detection: { extension: { installed: false }, cli: { found: false } } }),
  makeCtx({
    detection: { extension: { installed: true, version: "0.0.1" }, cli: { found: false } },
  }),
  makeCtx({ platform: "win32", permissions: { kind: "unsupported" } }),
  makeCtx({ read: okRead(withRegion("eu-west-9")) }),
  makeCtx({ read: okRead(withoutRegion()) }),
];

/** `Settings` is an untyped JSON object, so `env` is narrowed by hand here. */
function envOf(settings: Settings): JsonObject {
  const env = settings.env;
  if (env === undefined || typeof env !== "object" || Array.isArray(env) || env === null) {
    throw new Error("the fixture lost its env block");
  }
  return env;
}

function withRegion(region: string): Settings {
  const settings = okSettings();
  settings.env = { ...envOf(settings), AWS_REGION: region };
  return settings;
}

function withoutRegion(): Settings {
  const settings = okSettings();
  const { AWS_REGION: _dropped, ...rest } = envOf(settings);
  settings.env = rest;
  return settings;
}

describe("check remediations", () => {
  it("reaches enough branches to be worth asserting on", () => {
    expect(fixCommands().length).toBeGreaterThan(3);
  });

  it("nominates only commands we contribute or the platform already owns", () => {
    for (const id of fixCommands()) {
      if (BUILT_INS.has(id)) continue;
      expect(id).toMatch(/^sensibleDefaults\./);
      expect([...contributed]).toContain(id);
    }
  });
});

describe("contributed configuration", () => {
  it("declares the manifest URL the extension actually falls back to", async () => {
    // Two literals for one channel: VS Code hands `getConfiguration().get` the
    // contributed default, and the code's own fallback is only reached in a
    // host that has not loaded this `package.json`. They must name the same
    // endpoint, or the fallback quietly points somewhere else.
    const { DEFAULT_MANIFEST_URL } = await import("../../../src/ui/manifestHolder.js");
    expect(
      manifest.contributes.configuration.properties["sensibleDefaults.manifestUrl"].default,
    ).toBe(DEFAULT_MANIFEST_URL);
  });

  /**
   * F13. The manifest URL is the update channel's address, and a `window`-scoped
   * setting is settable from a repository's own `.vscode/settings.json` — so
   * cloning a repository would be enough to point this window's defaults at a
   * server of the repository author's choosing, walking around every
   * transport-layer defence in `fetch.ts` at the configuration layer.
   *
   * `application` scope is the fix: the setting exists only in user settings,
   * and a workspace cannot express it at all.
   */
  it("keeps the update channel's address out of workspace settings (F13)", () => {
    expect(
      manifest.contributes.configuration.properties["sensibleDefaults.manifestUrl"].scope,
    ).toBe("application");
  });

  /**
   * Belt to that braces, and the part that survives a future scope change: an
   * untrusted workspace's value for this setting is ignored outright. The
   * extension declares `untrustedWorkspaces.supported`, so without this it runs
   * with full capability in a folder it has not vouched for.
   */
  it("restricts the manifest URL in an untrusted workspace (F13)", () => {
    expect(manifest.capabilities.untrustedWorkspaces.restrictedConfigurations).toContain(
      "sensibleDefaults.manifestUrl",
    );
  });

  it("fetches the manifest over https and nowhere else (§13 privacy)", () => {
    const url =
      manifest.contributes.configuration.properties["sensibleDefaults.manifestUrl"].default;
    expect(new URL(url).protocol).toBe("https:");
  });
});

describe("contributed commands", () => {
  it("offers the diagnostics command under its FR-7.1 title", () => {
    const command = manifest.contributes.commands.find(
      (entry) => entry.command === "sensibleDefaults.copyDiagnostics",
    );
    expect(command?.title).toBe("Copy Diagnostics for Support");
  });

  it("offers the manual update check under its FR-3.3 title", () => {
    const command = manifest.contributes.commands.find(
      (entry) => entry.command === "sensibleDefaults.checkForUpdates",
    );
    expect(command?.title).toBe("Check for Updated Recommendations");
  });

  it("files every command under the Sensible Defaults category (FR-6)", () => {
    for (const command of manifest.contributes.commands) {
      expect(command.category).toBe("Sensible Defaults");
      expect(command.title).not.toBe("");
    }
  });

  it("binds every menu entry to a declared command", () => {
    const menus = manifest.contributes.menus as Record<
      string,
      { command: string; when?: string; group?: string }[]
    >;
    for (const entries of Object.values(menus)) {
      for (const entry of entries) expect(contributed).toContain(entry.command);
    }
  });

  it("hides the node-argument commands from the palette", () => {
    const hidden = manifest.contributes.menus.commandPalette.map((e) => e.command);
    expect(hidden).toContain("sensibleDefaults.runFix");
    expect(hidden).toContain("sensibleDefaults.resetKey");
    for (const entry of manifest.contributes.menus.commandPalette) {
      expect(entry.when).toBe("false");
    }
  });

  it("puts the Windows launcher, refresh and apply in the view title bar", () => {
    const title = manifest.contributes.menus["view/title"];
    expect(title.map((e) => e.command)).toEqual([
      "sensibleDefaults.openClaudeTerminal",
      "sensibleDefaults.runHealthCheck",
      "sensibleDefaults.applyDefaults",
    ]);
    for (const entry of title) {
      expect(entry.group).toBe("navigation");
      expect(entry.when).toBe(
        entry.command === "sensibleDefaults.openClaudeTerminal"
          ? "isWindows && (view == sensibleDefaults.health || view == sensibleDefaults.details)"
          : "view == sensibleDefaults.details",
      );
    }
  });

  it("binds the inline fix and reset buttons to the tree's context values", () => {
    const items = manifest.contributes.menus["view/item/context"];
    const fix = items.find((e) => e.command === "sensibleDefaults.runFix");
    const reset = items.find((e) => e.command === "sensibleDefaults.resetKey");
    expect(fix?.when).toContain("viewItem == check:command");
    expect(fix?.group).toBe("inline");
    expect(reset?.when).toContain("viewItem == drift");
    expect(reset?.group).toBe("inline");
  });

  it("the primary view is a webview and the tree is the Details view (M8)", () => {
    const views = manifest.contributes.views.sensibleDefaults;
    expect(views.map((v) => v.id)).toEqual(["sensibleDefaults.health", "sensibleDefaults.details"]);
    expect(views[0]).toMatchObject({ type: "webview" });
    // The tree only appears when the panel's Details disclosure is open.
    expect(views[1]?.when).toBe("sensibleDefaults.detailsOpen");
  });

  it("shows a first-run placeholder in the tree until a report exists", () => {
    const [welcome] = manifest.contributes.viewsWelcome;
    expect(welcome?.view).toBe("sensibleDefaults.details");
    expect(welcome?.when).toBe("sensibleDefaults.hasReport == false");
    expect(welcome?.contents).toContain("Checking your Claude Code configuration");
  });

  it("the tree has nothing to say when unconfigured; the panel owns that state (FR-5.5)", () => {
    const setup = manifest.contributes.viewsWelcome.find((entry) =>
      entry.when.includes("sensibleDefaults.needsSetup"),
    );
    expect(setup?.view).toBe("sensibleDefaults.details");
    // No apply button here: the panel's "Set up now" is the one path in.
    expect(setup?.contents).not.toContain("(command:");
  });

  it("links its welcome buttons to declared commands", () => {
    for (const entry of manifest.contributes.viewsWelcome) {
      for (const [, id] of entry.contents.matchAll(/\(command:([^)\s]+)\)/g)) {
        expect(contributed).toContain(id);
      }
    }
  });
});

/**
 * A command contributed but never registered appears in the palette and does
 * nothing; one registered but never contributed throws "command not found" the
 * first time a user clicks it. Neither is a type error, and the previous
 * version of this test looked for either by grepping the source for quoted
 * `sensibleDefaults.*` strings — which matched the very `register(...)` call
 * sites it was meant to be checking, so both directions passed vacuously and
 * would have kept passing if `registerCommands` had been deleted outright.
 *
 * The list now comes from the module that registers it.
 */
describe("registered commands", () => {
  it("declares every command it registers", async () => {
    const { COMMAND_IDS } = await import("../../../src/ui/commands.js");
    const missing = [...COMMAND_IDS].filter((id) => !contributed.has(id));
    expect(missing).toEqual([]);
  });

  it("registers every command it declares", async () => {
    const { COMMAND_IDS } = await import("../../../src/ui/commands.js");
    const registered = new Set<string>(COMMAND_IDS);
    const unused = [...contributed].filter((id) => !registered.has(id));
    expect(unused).toEqual([]);
  });

  it("registers every command a check nominates as its fix", async () => {
    const { COMMAND_IDS } = await import("../../../src/ui/commands.js");
    const registered = new Set<string>(COMMAND_IDS);
    for (const id of fixCommands()) {
      if (BUILT_INS.has(id)) continue;
      expect([...registered]).toContain(id);
    }
  });
});
