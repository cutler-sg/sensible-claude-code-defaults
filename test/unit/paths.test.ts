import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertOutsideWorkspace,
  backupsDir,
  resolveClaudeDir,
  settingsPath,
  snapshotPath,
  stateDir,
} from "../../src/config/paths.js";
import { ConfigError } from "../../src/config/types.js";

const HOME = "/home/u";

describe("resolveClaudeDir (plan Q-F)", () => {
  it("defaults to <home>/.claude when CLAUDE_CONFIG_DIR is unset", () => {
    expect(resolveClaudeDir({}, HOME)).toBe(path.join(HOME, ".claude"));
  });

  it("honours CLAUDE_CONFIG_DIR when set", () => {
    expect(resolveClaudeDir({ CLAUDE_CONFIG_DIR: "/opt/claude" }, HOME)).toBe(
      path.resolve("/opt/claude"),
    );
  });

  it("ignores an empty or whitespace-only CLAUDE_CONFIG_DIR", () => {
    expect(resolveClaudeDir({ CLAUDE_CONFIG_DIR: "" }, HOME)).toBe(path.join(HOME, ".claude"));
    expect(resolveClaudeDir({ CLAUDE_CONFIG_DIR: "   " }, HOME)).toBe(path.join(HOME, ".claude"));
  });

  it("trims surrounding whitespace", () => {
    expect(resolveClaudeDir({ CLAUDE_CONFIG_DIR: "  /opt/claude  " }, HOME)).toBe(
      path.resolve("/opt/claude"),
    );
  });

  it("expands a leading ~/ the way a shell would", () => {
    expect(resolveClaudeDir({ CLAUDE_CONFIG_DIR: "~/cfg/claude" }, HOME)).toBe(
      path.resolve(path.join(HOME, "cfg/claude")),
    );
  });

  it("expands a bare ~", () => {
    expect(resolveClaudeDir({ CLAUDE_CONFIG_DIR: "~" }, HOME)).toBe(path.resolve(HOME));
  });

  it("does not expand a tilde that is part of a name", () => {
    expect(resolveClaudeDir({ CLAUDE_CONFIG_DIR: "/opt/~claude" }, HOME)).toBe(
      path.resolve("/opt/~claude"),
    );
  });

  it("resolves a relative CLAUDE_CONFIG_DIR to an absolute path", () => {
    expect(path.isAbsolute(resolveClaudeDir({ CLAUDE_CONFIG_DIR: "cfg" }, HOME))).toBe(true);
  });

  it("reads process.env by default", () => {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/tmp/from-process-env";
    try {
      expect(resolveClaudeDir()).toBe(path.resolve("/tmp/from-process-env"));
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previous;
      }
    }
  });
});

describe("derived paths (plan Q-D / Q-H)", () => {
  const claudeDir = "/home/u/.claude";

  // These are `path.join`, so the separator is whatever the host uses. The
  // claim under test is the *shape* — which directory each artefact lands in —
  // not that a Windows box spells it with forward slashes.
  it("puts settings.json at the root of the Claude dir", () => {
    expect(settingsPath(claudeDir)).toBe(path.join(claudeDir, "settings.json"));
  });

  it("namespaces our state under sensible-defaults", () => {
    expect(stateDir(claudeDir)).toBe(path.join(claudeDir, "sensible-defaults"));
    expect(snapshotPath(claudeDir)).toBe(path.join(claudeDir, "sensible-defaults", "state.json"));
  });

  it("keeps backups out of Claude Code's own ~/.claude/backups", () => {
    expect(backupsDir(claudeDir)).toBe(path.join(claudeDir, "sensible-defaults", "backups"));
    expect(backupsDir(claudeDir)).not.toBe(path.join(claudeDir, "backups"));
  });
});

describe("assertOutsideWorkspace (FR-2.6, §10.4 assertion #2)", () => {
  const folders = ["/home/u/proj", "/home/u/other"];

  it("accepts a path with no workspace folders at all", () => {
    expect(() => assertOutsideWorkspace("/home/u/.claude/settings.json", [])).not.toThrow();
  });

  it("accepts the user settings file", () => {
    expect(() => assertOutsideWorkspace("/home/u/.claude/settings.json", folders)).not.toThrow();
  });

  it("rejects a target equal to a workspace folder", () => {
    expect(() => assertOutsideWorkspace("/home/u/proj", folders)).toThrow(ConfigError);
  });

  it("rejects a target inside a workspace folder", () => {
    expect(() => assertOutsideWorkspace("/home/u/proj/settings.json", folders)).toThrow(
      /Refusing to write inside a workspace folder/,
    );
  });

  it("rejects a project-scoped .claude/settings.local.json by construction", () => {
    expect(() =>
      assertOutsideWorkspace("/home/u/proj/.claude/settings.local.json", folders),
    ).toThrow(ConfigError);
  });

  it("rejects a target inside the second folder, not just the first", () => {
    expect(() => assertOutsideWorkspace("/home/u/other/.claude/settings.json", folders)).toThrow(
      ConfigError,
    );
  });

  it("rejects a non-normalised path that traverses back into a workspace", () => {
    expect(() => assertOutsideWorkspace("/home/u/.claude/../proj/x.json", folders)).toThrow(
      ConfigError,
    );
  });

  it("throws with code WRITE_INSIDE_WORKSPACE", () => {
    try {
      assertOutsideWorkspace("/home/u/proj/x.json", folders);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).code).toBe("WRITE_INSIDE_WORKSPACE");
    }
  });

  it("accepts a sibling directory sharing a name prefix", () => {
    expect(() => assertOutsideWorkspace("/home/u/proj2/settings.json", folders)).not.toThrow();
  });

  it("accepts the home dir when a workspace folder is a subdirectory of it", () => {
    expect(() =>
      assertOutsideWorkspace("/home/u/.claude/settings.json", ["/home/u/proj"]),
    ).not.toThrow();
  });

  it("ignores empty folder entries", () => {
    expect(() => assertOutsideWorkspace("/home/u/.claude/settings.json", [""])).not.toThrow();
  });

  it("compares case-insensitively on win32", () => {
    expect(() =>
      assertOutsideWorkspace("C:\\Users\\U\\Proj\\settings.json", ["C:\\users\\u\\proj"], "win32"),
    ).toThrow(ConfigError);
  });

  it("is case-sensitive on posix", () => {
    expect(() =>
      assertOutsideWorkspace("/home/u/PROJ/settings.json", ["/home/u/proj"], "linux"),
    ).not.toThrow();
  });

  it("accepts a path on a different win32 drive", () => {
    expect(() =>
      assertOutsideWorkspace("D:\\claude\\settings.json", ["C:\\users\\u\\proj"], "win32"),
    ).not.toThrow();
  });
});
