import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "../../../package.json";

const ROOT = path.resolve(__dirname, "../../..");
const COMMAND_ID = /["'`](sensibleDefaults\.[A-Za-z.]+)["'`]/g;

/**
 * Both halves of this matter. A command referenced in code but not contributed
 * throws "command not found" the first time a user clicks it, and a command
 * contributed but never registered shows up in the palette and does nothing —
 * neither is caught by a type check.
 */
function referencedCommands(): Set<string> {
  const found = new Set<string>();
  for (const file of sources()) {
    for (const [, id] of readFileSync(file, "utf8").matchAll(COMMAND_ID)) {
      if (id !== undefined) found.add(id);
    }
  }
  // Contributed by the platform for the view container, not by us.
  found.delete("sensibleDefaults.health.focus");
  return found;
}

function sources(): string[] {
  const roots = [path.join(ROOT, "src/ui/commands.ts"), path.join(ROOT, "src/health/checks")];
  return roots.flatMap((entry) => {
    try {
      return statSync(entry).isDirectory() ? walk(entry) : [entry];
    } catch {
      // `src/health/checks/` lands with the check catalogue; until then there is
      // simply nothing there to cross-check.
      return [];
    }
  });
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

const contributed = new Set(manifest.contributes.commands.map((c) => c.command));

describe("contributed commands", () => {
  it("declares every command the source refers to", () => {
    const missing = [...referencedCommands()].filter((id) => !contributed.has(id));
    expect(missing).toEqual([]);
  });

  it("refers to every command it declares", () => {
    const referenced = referencedCommands();
    const unused = [...contributed].filter((id) => !referenced.has(id));
    expect(unused).toEqual([]);
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

  it("puts refresh and apply in the view title bar", () => {
    const title = manifest.contributes.menus["view/title"];
    expect(title.map((e) => e.command)).toEqual([
      "sensibleDefaults.runHealthCheck",
      "sensibleDefaults.applyDefaults",
    ]);
    for (const entry of title) {
      expect(entry.group).toBe("navigation");
      expect(entry.when).toBe("view == sensibleDefaults.health");
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

  it("shows a first-run placeholder until a report exists", () => {
    const [welcome] = manifest.contributes.viewsWelcome;
    expect(welcome?.view).toBe("sensibleDefaults.health");
    expect(welcome?.when).toBe("sensibleDefaults.hasReport == false");
    expect(welcome?.contents).toContain("Checking your Claude Code configuration");
  });
});
