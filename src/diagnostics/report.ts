/**
 * The FR-7.1 diagnostics report.
 *
 * FR-7.3 is the whole design constraint: the block must be safe to paste into a
 * public GitHub issue. Two rules follow from it, and they are belt and braces
 * for each other.
 *
 * The settings document is redacted **by key** — every `SECRET_KEYS` leaf is
 * replaced outright, whatever its value looks like. That is the half that still
 * works when the registry is empty and no pattern matches, which is the state
 * on a machine where the user pasted a key by hand.
 *
 * Every other string then goes through `redact`, which is registry-first. That
 * is the half that catches the same value somewhere the key rule cannot see it:
 * an error message quoting a file, a log line, a check detail.
 *
 * Nothing here imports `vscode` — the versions, the platform, the remote
 * indicator and the settings text all arrive as data (`src/ui/diagnostics.ts`
 * is the adapter), so the whole report is assertable in a unit test. That is
 * what makes §10.4 assertion #1 a test rather than a review item.
 */

import { SECRET_KEYS } from "../config/managedKeys.js";
import type { CheckResult, HealthReport, Level, ManifestStatus } from "../health/types.js";
import type { LogLine, RecentLog } from "../util/log.js";
import { redact, redactValue } from "../util/redact.js";

/**
 * The `settings.json` as it stands, or why there is nothing to show.
 *
 * `malformed` carries the raw text rather than a parsed document, and that text
 * is the user's file — so it is scrubbed by `redact` alone, with no key rule to
 * fall back on. A malformed file is also the case most likely to have a token
 * in it in an unexpected shape, which is why the registry matters more here
 * than anywhere else in the report.
 */
export type SettingsForReport =
  | { kind: "ok"; data: unknown }
  | { kind: "absent" }
  | { kind: "malformed"; raw: string };

export interface DiagnosticsDeps {
  /** This extension's version, from `package.json`. */
  extensionVersion: string;
  /** `vscode.version`. */
  vscodeVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  /**
   * `vscode.env.remoteName` — `wsl`, `ssh-remote`, `dev-container`, or
   * undefined for a local window. The single most useful line in the report:
   * the extension host runs on the remote side, so "which home directory did
   * this write to" is answered here and nowhere else.
   */
  remoteName?: string;
  claudeCodeExtensionVersion?: string;
  claudeCliVersion?: string;
  manifest: ManifestStatus;
  settings: SettingsForReport;
  report?: HealthReport;
  log: RecentLog;
  /** When the report was produced. */
  now: Date;
  settingsPath: string;
}

/** Named in the confirmation so the user knows what they are about to paste. */
export const DIAGNOSTICS_INCLUDES = [
  "your versions and platform",
  "which recommended settings are in force",
  "your Claude Code settings file",
  "the health check results",
  "the last 50 lines from the output log",
];

export const DIAGNOSTICS_EXCLUDES = "your Bedrock API key, and anything that looks like one";

const LEVEL_TEXT: Record<Level, string> = {
  pass: "pass",
  info: "info",
  warning: "warning",
  error: "error",
  skipped: "skipped",
};

/**
 * The leaf names `redactValue` compares against.
 *
 * `SECRET_KEYS` holds dotted managed keys (`env.AWS_BEARER_TOKEN_BEDROCK`) and
 * `redactValue` walks a document seeing leaf names (`AWS_BEARER_TOKEN_BEDROCK`)
 * — so handing it the set unchanged would match nothing at all and quietly
 * reduce the key rule to the pattern net. Derived rather than written out, so a
 * key added to `SECRET_KEYS` is redacted here without a second edit.
 */
const SECRET_LEAVES: ReadonlySet<string> = new Set(
  [...SECRET_KEYS].map((key) => key.slice(key.lastIndexOf(".") + 1)),
);

export function buildDiagnostics(deps: DiagnosticsDeps): string {
  const sections = [
    "## Sensible Claude Code Defaults — diagnostics",
    "",
    `Generated ${deps.now.toISOString()}`,
    "",
    environment(deps),
    "",
    recommendations(deps.manifest),
    "",
    settingsSection(deps),
    "",
    healthSection(deps.report),
    "",
    logSection(deps.log.recent()),
    "",
    `_The Bedrock API key is replaced with ${"`«redacted»`"} everywhere above._`,
  ];
  return `${sections.join("\n")}\n`;
}

function environment(deps: DiagnosticsDeps): string {
  return table(
    ["Field", "Value"],
    [
      ["Extension", deps.extensionVersion],
      ["VS Code", deps.vscodeVersion],
      ["Platform", `${deps.platform} ${deps.arch}`],
      // Stated in both directions. "Local" is information: it rules out the
      // whole class of "the settings file you are looking at is on the other
      // machine" that a blank cell would leave open.
      ["Remote", deps.remoteName ?? "local"],
      ["Claude Code extension", deps.claudeCodeExtensionVersion ?? "not installed"],
      ["Claude Code CLI", deps.claudeCliVersion ?? "not found"],
      ["Settings file", deps.settingsPath],
    ],
  );
}

function recommendations(manifest: ManifestStatus): string {
  const rows: [string, string][] = [
    ["Revision", manifest.revision],
    ["Source", manifest.source],
    ["Fetched", manifest.fetchedAt ?? "never (using the copy in the extension)"],
  ];
  if (manifest.needsExtensionVersion !== undefined) {
    rows.push(["Newer manifest needs extension", manifest.needsExtensionVersion]);
  }
  return `### Recommended settings\n\n${table(["Field", "Value"], rows)}`;
}

/**
 * The whole `settings.json`, with every `SECRET_KEYS` value replaced.
 *
 * Re-serialised from the parsed document rather than quoted from the file: the
 * point of the section is what Claude Code reads, the redaction is by key, and
 * a key-based rule needs a parsed document to apply to. The user's indentation
 * is not preserved here for the same reason — this is a report, not a copy of
 * the file, and `config.parses` is the check that speaks for the file's shape.
 */
function settingsSection(deps: DiagnosticsDeps): string {
  const heading = "### Your Claude Code settings";
  switch (deps.settings.kind) {
    case "absent":
      return `${heading}\n\nThere is no settings file yet.`;
    case "malformed":
      // No key rule is available: the document did not parse, so there are no
      // keys. `redact` alone stands between the raw text and a public issue,
      // which is exactly the case the registry exists for.
      return [
        heading,
        "",
        "The settings file could not be read as JSON. It is shown as-is:",
        "",
        fence(redact(deps.settings.raw)),
      ].join("\n");
    case "ok":
      return [
        heading,
        "",
        fence(JSON.stringify(redactValue(deps.settings.data, SECRET_LEAVES), null, 2), "json"),
      ].join("\n");
  }
}

function healthSection(report: HealthReport | undefined): string {
  const heading = "### Health checks";
  if (report === undefined) {
    return `${heading}\n\nThe health checks have not finished a run yet.`;
  }
  const rows: [string, string, string][] = report.results.map((result) => [
    result.id,
    LEVEL_TEXT[result.level],
    detailOf(result),
  ]);
  const counts = `Run ${report.at} — ${summarise(report)}`;
  return [heading, "", counts, "", table(["Check", "Result", "What it said"], rows)].join("\n");
}

/**
 * The label plus the tooltip. Both are strings the panel already shows the
 * user, and both go through `redact` here rather than being trusted: a check
 * `detail` is the one field in a `CheckResult` that carries text this extension
 * did not write — a parse error, a keychain failure from the OS.
 */
function detailOf(result: CheckResult): string {
  const detail = result.detail === undefined ? "" : ` — ${result.detail}`;
  // Not escaped here: `table` runs every value through `cell`, and escaping
  // twice turns a pipe into `\\|`, which renders as a stray backslash.
  return redact(`${result.label}${detail}`);
}

function summarise(report: HealthReport): string {
  return (Object.keys(LEVEL_TEXT) as Level[])
    .filter((level) => report.counts[level] > 0)
    .map((level) => `${report.counts[level]} ${LEVEL_TEXT[level]}`)
    .join(", ");
}

/**
 * The last 50 lines, already redacted by the `Logger` on the way in. `redact`
 * runs over them again anyway: a value registered *after* a line was written —
 * a key entered mid-session, or read out of the settings file by the run that
 * produced this report — was not known when the line was buffered.
 */
function logSection(lines: readonly LogLine[]): string {
  const heading = "### Output log (last 50 lines)";
  if (lines.length === 0) return `${heading}\n\nNothing has been logged in this window yet.`;
  const body = lines.map((line) => `[${line.level}] ${redact(line.message)}`).join("\n");
  return `${heading}\n\n${fence(body)}`;
}

/**
 * A fenced block whose fence is longer than any run of backticks inside it, so
 * a settings file or a log line containing ``` cannot close the block early and
 * spill the rest of the report into the surrounding Markdown.
 */
function fence(body: string, language = ""): string {
  const longest = [...body.matchAll(/`+/g)].reduce((max, [run]) => Math.max(max, run.length), 0);
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${language}\n${body}\n${ticks}`;
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const head = `| ${headers.join(" | ")} |`;
  const rule = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map(cell).join(" | ")} |`);
  return [head, rule, ...body].join("\n");
}

/**
 * A value safe to put in a Markdown table cell. A pipe would end the cell and a
 * line break would end the row, either of which turns the rest of the report
 * into garbage — and both arrive routinely, from a path, a parse error, or a
 * check detail.
 *
 * Every character that ends a line, not just LF and CRLF. A lone CR and the two
 * Unicode separators break a row exactly as an LF does, and all three are legal
 * in a POSIX filename — so someone who can drop a file into a repo the user
 * opens controls the `cred.leak` detail that names it, and can forge whatever
 * row they like, up to a "Diagnostics verified clean" the run never produced.
 * Escaping the pipes is pointless while the row can still be broken in half.
 */
function cell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll(/\r\n|[\n\r\u2028\u2029]/gu, " ");
}
