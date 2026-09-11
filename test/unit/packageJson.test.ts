import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "../../package.json";

describe("package.json", () => {
  it("does not declare extensionKind (FR-1.3: host must run beside the CLI)", () => {
    expect((manifest as Record<string, unknown>).extensionKind).toBeUndefined();
  });

  it("depends on the Claude Code extension by bare id (FR-1.5)", () => {
    expect(manifest.extensionDependencies).toEqual(["anthropic.claude-code"]);
  });

  it("publishes under the verified cutler-sg identity", () => {
    // The publisher id prefixes the extension id forever and decides which
    // apex domain can be verified later; cutler.sg is the one we hold.
    expect(manifest.publisher).toBe("cutler-sg");
    expect(manifest.homepage).toBe("https://cutler.sg/sensible-claude-code-defaults");
  });

  it("activates only on startup finished (FR-1.1)", () => {
    expect(manifest.activationEvents).toEqual(["onStartupFinished"]);
  });

  it("points main at the bundled entry point", () => {
    expect(manifest.main).toBe("./dist/extension.js");
  });

  it("supports untrusted workspaces", () => {
    expect(manifest.capabilities.untrustedWorkspaces.supported).toBe(true);
  });

  it("carries the search keywords and the non-affiliation statement (§5A, D8)", () => {
    // The title is free to differentiate because search matches the full
    // display name *and* the description; the description is where the words a
    // user types have to appear. D8 puts the non-affiliation statement in the
    // Marketplace description as well as the README, so it is pinned here.
    const description = manifest.description.toLowerCase();
    for (const term of ["claude code", "bedrock", "aws"]) {
      expect(description).toContain(term);
    }
    expect(manifest.description).toContain("not affiliated with Anthropic, PBC");
  });

  it("declares categories the Marketplace recognises, and not just Other", () => {
    // The Marketplace rejects anything outside this list, and `Other` alone
    // puts the listing in the bucket nobody browses.
    const allowed = new Set([
      "AI",
      "Azure",
      "Chat",
      "Data Science",
      "Debuggers",
      "Extension Packs",
      "Education",
      "Formatters",
      "Keymaps",
      "Language Packs",
      "Linters",
      "Machine Learning",
      "Notebooks",
      "Programming Languages",
      "SCM Providers",
      "Snippets",
      "Testing",
      "Themes",
      "Visualization",
      "Other",
    ]);
    expect(manifest.categories.length).toBeGreaterThan(1);
    for (const category of manifest.categories) {
      expect(allowed).toContain(category);
    }
  });

  it("stays under the Marketplace's 30-keyword ceiling", () => {
    // Publishing fails outright with "You exceeded the number of allowed tags
    // of 30", so this is a gate rather than a style preference.
    expect(manifest.keywords.length).toBeLessThanOrEqual(30);
  });

  it("ships 0.1.0 flagged as a preview (plan Q-AI)", () => {
    expect(manifest.preview).toBe(true);
  });

  it("contributes the sensibleDefaults activity bar container", () => {
    const containers = manifest.contributes.viewsContainers.activitybar;
    expect(containers.map((c) => c.id)).toContain("sensibleDefaults");
  });

  it("every contributed icon path exists on disk", () => {
    // The activity-bar glyph was deleted as dead weight in #17 because nothing
    // greps for it: `contributes.viewsContainers[].icon` is a path VS Code
    // resolves at runtime, not an import. The listing shipped with an empty
    // sidebar entry. This is the test that would have caught it. Resolved from
    // the repo root, which is where vitest runs.
    const root = join(process.cwd());
    const paths = [
      manifest.icon,
      ...manifest.contributes.viewsContainers.activitybar.map((c) => c.icon),
    ];
    for (const rel of paths) {
      expect(existsSync(join(root, rel)), `${rel} is referenced but missing`).toBe(true);
    }
  });
});
