/**
 * The sidebar panel: a `WebviewViewProvider` that renders `PanelState` and
 * turns the page's messages into the same flow functions the palette commands
 * call (plan M8 Part A).
 *
 * The provider owns exactly two pieces of state the reducer cannot derive: the
 * user's progress through the two-step setup, and whether Details is open.
 * Everything else — the report, the stored key's timestamp, the last test —
 * comes from the host on every render.
 *
 * The token reaches the host for validation and submission. It is never put
 * in state, echoed to the page, or logged. Feedback updates preserve the
 * input element; replacing webview.html would discard the user's key.
 */

import { randomBytes } from "node:crypto";
import type * as vscode from "vscode";
import { commit, plan } from "../../config/apply.js";
import { normalizeToken, SHAPE_MESSAGES, validateTokenShape } from "../../credential/shape.js";
import type { HealthReport } from "../../health/types.js";
import { desiredFromManifest } from "../../manifest/types.js";
import type { Logger } from "../../util/log.js";
import { failureMessage, reportFailure } from "../failures.js";
import type { FlowDeps } from "../flows.js";
import { runConnectionTest, saveToken } from "../flows.js";
import { render } from "./html.js";
import {
  derive,
  type Inputs,
  type PanelState,
  parseInbound,
  type SetupProgress,
  type ShapeFeedback,
  type WebviewInbound,
  type WebviewOutbound,
} from "./state.js";

export const PANEL_VIEW_ID = "sensibleDefaults.health";
export const DETAILS_VIEW_ID = "sensibleDefaults.details";
const DETAILS_CONTEXT = "sensibleDefaults.detailsOpen";

export interface PanelDeps {
  flows: FlowDeps;
  log: Logger;
  /** The latest report and last-test stamp, read per render. */
  report: () => HealthReport | undefined;
  lastTestedAt: () => string | undefined;
  consoleUrl: () => string;
  /** `commands.executeCommand`, injected so a unit test can watch it. */
  execute: (command: string) => Thenable<unknown>;
  openExternal: (url: string) => Thenable<unknown>;
  setContext: (key: string, value: unknown) => Thenable<unknown>;
}

export class PanelProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private progress: SetupProgress | undefined;
  private detailsOpen = false;
  private inFlight = false;
  private showingKey = false;
  private failure: string | undefined;

  constructor(private readonly deps: PanelDeps) {}

  healthFailed(message: string): void {
    if (this.progress?.step === "key") {
      this.progress = { ...this.progress, problem: message };
    } else {
      this.failure = message;
    }
    this.refresh();
  }

  healthSucceeded(): void {
    this.failure = undefined;
    this.refresh();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.showingKey = false;
    if (this.progress?.step === "key") {
      this.progress = { ...this.progress, shape: { kind: "empty" } };
    }
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.onDidReceiveMessage((raw: unknown) => void this.receive(raw));
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    this.refresh();
  }

  /** Called by the host after every health run. */
  refresh(): void {
    void this.paint().catch((error: unknown) =>
      reportFailure(
        this.deps.log,
        failureMessage(error, "Couldn't update the setup panel. Try opening it again."),
      ),
    );
  }

  /** The state the page is showing, for tests and for the details view's context. */
  current(): PanelState {
    if (this.failure !== undefined) return { kind: "failed", message: this.failure };
    return derive(this.inputs());
  }

  private inputs(): Inputs {
    return {
      report: this.deps.report(),
      stored: this.storedStamp,
      lastTestedAt: this.deps.lastTestedAt(),
      progress: this.progress,
      consoleUrl: this.deps.consoleUrl(),
      detailsOpen: this.detailsOpen,
    };
  }

  /**
   * Only the timestamp is kept from the last `store.get()`, refreshed on each
   * paint. The reducer's `Inputs.stored` type is `Pick<StoredToken, "setAt">`
   * so the token cannot reach it by construction.
   */
  private storedStamp: { setAt: string } | undefined;

  private async paint(): Promise<void> {
    const view = this.view;
    if (view === undefined) return;
    try {
      const stored = await this.deps.flows.credential.store.get();
      this.storedStamp = stored === undefined ? undefined : { setAt: stored.setAt };
    } catch {
      // A keychain that cannot be read is `cred.present`'s job to report; here
      // it simply means "no stamp", and the panel falls through to whatever
      // the report says.
      this.storedStamp = undefined;
    }
    if (this.view !== view) return;
    const state = this.current();
    const keyProgress =
      state.kind === "setup" && state.progress.step === "key" ? state.progress : undefined;
    if (keyProgress !== undefined && this.showingKey) {
      await view.webview.postMessage({
        type: "key.feedback",
        ...keyProgress,
      } satisfies WebviewOutbound);
      return;
    }
    this.showingKey = keyProgress !== undefined;
    view.webview.html = render(state, {
      nonce: randomBytes(16).toString("base64"),
      cspSource: view.webview.cspSource,
    });
  }

  /** Exposed for the unit test, which has no webview to click. */
  async receive(raw: unknown): Promise<void> {
    const message = parseInbound(raw);
    if (message === undefined) {
      this.deps.log.warn("The panel sent a message the extension does not accept; ignored.");
      return;
    }
    try {
      if (message.type !== "ready") this.failure = undefined;
      await this.handle(message);
    } catch (error) {
      this.failure = failureMessage(
        error,
        "That action couldn't finish. Check your configuration and try again.",
      );
      this.refresh();
      await reportFailure(this.deps.log, this.failure);
    }
  }

  private async handle(message: WebviewInbound): Promise<void> {
    switch (message.type) {
      case "ready":
        return;
      case "setup.start":
      case "setup.restart":
        this.showingKey = false;
        this.progress = { step: "key", shape: { kind: "empty" } };
        return this.paint();
      case "setup.check":
        // `adoptToken` covers the `/setup-bedrock` user whose key is already
        // in the settings file; a health run then decides what to show.
        await this.deps.execute("sensibleDefaults.adoptToken");
        return;
      case "key.changed":
        if (this.progress?.step !== "key" || this.inFlight) return;
        this.progress = { step: "key", shape: judge(message.value) };
        return this.paint();
      case "key.submit":
        return this.submit(message.value);
      case "setup.retest":
        return this.test();
      case "setup.finish":
        this.progress = undefined;
        await this.deps.execute("sensibleDefaults.runHealthCheck");
        return;
      case "console.open":
        await this.deps.openExternal(this.deps.consoleUrl());
        return;
      case "details.toggle":
        this.detailsOpen = !this.detailsOpen;
        await this.deps.setContext(DETAILS_CONTEXT, this.detailsOpen);
        return this.paint();
      case "action.run":
        // Leaving setup: whatever the command does, the next health run
        // decides the state, not a stale step.
        this.progress = undefined;
        await this.deps.execute(message.command);
        return;
    }
  }

  private async submit(raw: string): Promise<void> {
    if (this.inFlight) return;
    const value = normalizeToken(raw);
    const verdict = validateTokenShape(value);
    if (verdict?.severity === "error") {
      this.progress = { step: "key", shape: judge(value) };
      return this.paint();
    }
    this.inFlight = true;
    try {
      this.progress = { step: "key", shape: judge(value), busy: true };
      await this.paint();
      // The eight non-secret keys first (plan D-1: the region is written
      // silently here, from the manifest, never asked), then the key. The
      // palette's `applyDefaults` previews the change list; here the user has
      // just read "Where does it go?" and clicked Continue, and a JSON diff is
      // the thing this audience cannot read. Hard rule 3 still holds: `commit`
      // refuses to overwrite a managed value that drifted from the snapshot.
      const problem = await this.applyDefaultsSilently();
      if (problem !== undefined) {
        this.progress = { step: "key", shape: judge(value), problem };
        return this.paint();
      }
      // Notification promises settle on dismissal, not when the toast appears.
      const mirrored = await saveToken(this.deps.flows, value, false);
      if (!mirrored) {
        this.progress = {
          step: "key",
          shape: judge(value),
          problem:
            "Your key was saved, but couldn't be copied into your settings file. Use the buttons above to sort that out, then come back.",
        };
        return this.paint();
      }
      await this.test();
    } catch (error) {
      const problem = failureMessage(error, "Something went wrong saving your key. Try again.");
      this.deps.log.error(`Saving the key from the panel failed: ${problem}`);
      this.progress = {
        step: "key",
        shape: judge(value),
        problem,
      };
      return this.paint();
    } finally {
      this.inFlight = false;
    }
  }

  private async applyDefaultsSilently(): Promise<string | undefined> {
    const flows = this.deps.flows;
    const manifest = flows.manifest();
    const planned = await plan(flows.env, desiredFromManifest(manifest));
    if (planned.kind !== "ready") {
      return "Your settings file is damaged. Use Check Configuration to repair it before continuing setup.";
    }
    if (planned.noop) return;
    flows.markWrite();
    const result = await commit(flows.env, flows.session, planned, {
      manifestRevision: manifest.revision,
    });
    this.deps.log.info(
      result.written
        ? `Panel setup wrote ${result.changes.length} recommended setting(s).`
        : `Panel setup wrote nothing (${result.reason ?? "unknown"}).`,
    );
    if (result.reason === "stale") {
      return "Your settings changed while setup was saving them. Try again.";
    }
  }

  private async test(): Promise<void> {
    this.progress = { step: "testing" };
    await this.paint();
    const stored = await this.deps.flows.credential.store.get();
    if (stored === undefined) {
      this.progress = { step: "key", shape: { kind: "empty" } };
      return this.paint();
    }
    const result = await runConnectionTest(this.deps.flows, stored);
    this.progress = { step: "result", result };
    await this.paint();
  }
}

/** The same rules as the input box's `validateInput`, as data rather than a dialog. */
export function judge(raw: string): ShapeFeedback {
  const value = normalizeToken(raw);
  if (value === "") return { kind: "empty" };
  const verdict = validateTokenShape(value);
  if (verdict === undefined) return { kind: "ok" };
  return { kind: verdict.severity, message: SHAPE_MESSAGES[verdict.problem] };
}
