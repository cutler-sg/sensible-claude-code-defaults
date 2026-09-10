import * as vscode from "vscode";
import { backupsDir, createSession } from "./config/index.js";
import { readTokenFromSettings } from "./credential/writeThrough.js";
import type { CredentialContext, HealthReport } from "./health/types.js";
import { createManifestCache } from "./manifest/cache.js";
import { registerCommands } from "./ui/commands.js";
import type { CredentialFlowDeps } from "./ui/flows.js";
import { createHealthRunner } from "./ui/healthRunner.js";
import { createHost } from "./ui/host.js";
import { createManifestHolder, DEFAULT_MANIFEST_URL } from "./ui/manifestHolder.js";
import { HealthTreeProvider } from "./ui/treeProvider.js";
import { watchSettings } from "./ui/watcher.js";
import { Logger } from "./util/log.js";
import { forgetAll } from "./util/redact.js";

/** How long after our own write the watcher ignores the directory (plan Q-Q). */
const SUPPRESS_MS = 1500;

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel("Sensible Claude Code Defaults", { log: true });
  const log = new Logger(channel);
  log.info(`Sensible Claude Code Defaults ${context.extension.packageJSON.version} activated.`);

  const host = createHost(context);
  // Constructed, not resolved: §13 caps activation at 100 ms, so the first
  // fetch happens inside the deferred health run below and the panel renders
  // from the bundled copy — and, from the second window onwards, from the cache
  // the first one saved — while it is in flight.
  const manifests = createManifestHolder({
    url: () =>
      vscode.workspace.getConfiguration().get("sensibleDefaults.manifestUrl", DEFAULT_MANIFEST_URL),
    extensionVersion: String(context.extension.packageJSON.version),
    cache: createManifestCache(context.globalState),
    log,
  });
  const provider = new HealthTreeProvider();
  const view = vscode.window.createTreeView("sensibleDefaults.health", {
    treeDataProvider: provider,
    showCollapseAll: false,
  });

  let suppressUntil = 0;
  const markWrite = (): void => {
    suppressUntil = Date.now() + SUPPRESS_MS;
  };

  /**
   * The last test call, per window (plan Q-T). In memory on purpose: it says
   * what AWS answered a moment ago, and a result restored from disk after a
   * restart would vouch for a key that may since have been revoked.
   *
   * For the same reason it does not survive a change to the key it was about
   * (F5): a result is evidence about one credential, and rotating, clearing or
   * replacing that credential leaves it evidence about nothing. It is dropped
   * on every store change, and stamped with the tested key so `cred.valid` can
   * catch a change this window did not make either.
   */
  /**
   * The last completed report and the CLI version that run detected, for the
   * FR-7.1 diagnostics command. Captured from `present`, which already receives
   * every report — a second full run to obtain one would be a `claude
   * --version` probe and a permission repair for a command that only reads.
   */
  let lastReport: HealthReport | undefined;
  let lastCliVersion: string | undefined;

  let lastTest: CredentialContext["lastTest"];
  const credential: CredentialFlowDeps = {
    store: host.store,
    terminal: host.terminal,
    recordTest: (result, tokenSetAt) => {
      lastTest = {
        at: new Date().toISOString(),
        ...(tokenSetAt === undefined ? {} : { tokenSetAt }),
        result,
      };
    },
    onTokenChanged: () => {
      lastTest = undefined;
    },
  };

  const runChecks = createHealthRunner({
    env: host.env,
    // A getter, not a value: the holder re-resolves on the hourly boundary and
    // on "Check for Updated Recommendations", and a manifest captured here
    // would pin the panel to the bundled defaults for the life of the window.
    manifest: () => manifests.current(),
    platform: process.platform,
    detect: async () => {
      const detection = await host.detect();
      lastCliVersion = detection.cli.found ? detection.cli.version : undefined;
      return detection;
    },
    log,
    notified: context.globalState,
    credential: () => ({
      store: host.store,
      readFromSettings: () => readTokenFromSettings(host.env),
      ...(lastTest === undefined ? {} : { lastTest }),
    }),
    // FR-4.3 / F13: the collection is re-derived from the keychain on every
    // run, so a window that missed a change made in another one catches up
    // rather than exporting a key that has been cleared or replaced.
    terminal: host.terminal,
    onSelfWrite: markWrite,
    present: (report) => {
      lastReport = report;
      provider.setReport(report);
      view.badge =
        provider.errorCount > 0
          ? { value: provider.errorCount, tooltip: `${provider.errorCount} problem(s) to fix` }
          : undefined;
    },
  });

  /**
   * FR-3.2 / FR-3.3 / §13: paint from what we already hold, then re-resolve,
   * then repaint if the answer changed.
   *
   * In that order, never the other way round. The point of §13 is that the
   * panel is populated before the network is consulted: on a machine behind a
   * dead proxy the fetch spends its whole 5 s timeout, and painting first is
   * what stops the user watching "Checking your Claude Code configuration…" for
   * all of it. The refresh is throttled to one fetch an hour, so on every run
   * but the first of each hour it returns without touching the network — which
   * is what makes it safe to hang off every health run, including the ones a
   * file change triggers.
   */
  const runHealth = async (): Promise<void> => {
    await runChecks();
    if (await manifests.refresh()) await runChecks();
  };

  const watcher = watchSettings(host.claudeDir, host.settingsFile, () => void runHealth(), {
    suppress: () => Date.now() < suppressUntil,
  });

  const commands = registerCommands({
    env: host.env,
    session: createSession(),
    manifest: () => manifests.current().manifest,
    refreshManifest: (options) => manifests.refresh(options),
    settingsFile: host.settingsFile,
    backupsDir: backupsDir(host.claudeDir),
    log,
    runHealth,
    markWrite: () => {
      markWrite();
      // A commit may have just created ~/.claude on a fresh install; the
      // watcher was waiting on the parent directory and may have missed it.
      watcher.rearm();
    },
    credential,
    extensionVersion: String(context.extension.packageJSON.version),
    diagnostics: {
      manifest: () => manifests.current().status,
      report: () => lastReport,
      cliVersion: () => lastCliVersion,
    },
  });

  context.subscriptions.push(channel, view, commands, watcher);
  // §13: activation must add < 100 ms to startup, so the first run happens
  // after `activate` returns rather than inside it. The opt-out is read here,
  // not around the toast: someone who turns the startup check off is asking us
  // not to touch their configuration on startup at all, and "Check
  // Configuration" from the palette still works.
  setImmediate(() => {
    // FR-4.3 / plan Q-W: push a stored key into the terminal collection so new
    // terminals inherit it, and touch nothing on disk. Writing the settings
    // file on activation would be a silent change to a user's configuration
    // made before they have seen the panel, and a file whose key we removed by
    // hand is a `cred.mirrored` error with a one-click fix instead.
    //
    // A health run does this too (F13), but not when the user has opted out of
    // the startup check — and terminal injection is not the configuration
    // check they opted out of.
    void pushTokenToTerminals(host, log);
    if (!vscode.workspace.getConfiguration().get("sensibleDefaults.checkOnStartup", true)) {
      log.info("Startup health check skipped: sensibleDefaults.checkOnStartup is off.");
      return;
    }
    void runHealth();
  });
}

/**
 * A keychain that throws — Linux without libsecret — must not take activation
 * with it: `cred.present` reports that condition with a message the user can
 * act on, and it can only do so if the extension is running.
 */
async function pushTokenToTerminals(
  host: ReturnType<typeof createHost>,
  log: Logger,
): Promise<void> {
  try {
    const stored = await host.store.get();
    if (stored === undefined) return;
    host.terminal.apply(stored.token);
    log.info("Applied the saved Bedrock API key to new terminals.");
  } catch (error) {
    log.warn(
      `Could not read the system keychain: ${error instanceof Error ? error.message : "unknown failure"}`,
    );
  }
}

/**
 * Everything disposable is owned by the extension context, so the only thing to
 * tear down is the one piece of state that is not: the redaction registry.
 *
 * It holds exact token values in memory, deliberately never persisted (plan
 * Q-AE), so dropping them here is what keeps "memory-only" true for a host that
 * deactivates and reactivates an extension without restarting the process.
 */
export function deactivate(): void {
  forgetAll();
}
