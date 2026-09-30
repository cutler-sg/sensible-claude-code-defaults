/** Desktop-only fixture extension. Never included in the product VSIX. */
import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import { BUNDLED_MANIFEST } from "../../src/manifest/bundled.js";

const root = process.env.SCD_MODEL_QA_DIR;
const originalFetch = globalThis.fetch;
const scenarios = [
  "blocked-upgrade",
  "available-upgrade",
  "configured-denial",
  "invalid-credential",
  "metadata-denial",
  "offline",
  "throttled",
] as const;
type Scenario = (typeof scenarios)[number];
let scenario: Scenario = "blocked-upgrade";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  if (!root) throw new Error("Desktop QA must provide an isolated directory");
  try {
    const previous = await readFile(join(root, "scenario.txt"), "utf8");
    if (scenarios.includes(previous as Scenario)) scenario = previous as Scenario;
  } catch {
    /* Fresh fixture profile. */
  }
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (
      url.startsWith("https://raw.githubusercontent.com/cutler-sg/sensible-claude-code-defaults/")
    )
      return Response.json(BUNDLED_MANIFEST);
    if (!/^https:\/\/bedrock(-runtime)?\.[a-z0-9-]+\.amazonaws\.com\//.test(url))
      return originalFetch(input, init);
    await appendFile(
      join(root, "requests.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), scenario, url, method: init?.method })}\n`,
    );
    const token = new Headers(init?.headers).get("authorization");
    if (token !== "Bearer synthetic-desktop-model-check-token")
      return Response.json(
        {
          __type: "UnrecognizedClientException",
          message: "The security token included in the request is invalid",
        },
        { status: 403 },
      );
    if (scenario === "offline") throw new Error("Synthetic network failure");
    if (scenario === "invalid-credential")
      return Response.json(
        { __type: "UnrecognizedClientException", message: "The security token is invalid" },
        { status: 403 },
      );
    if (scenario === "throttled")
      return Response.json(
        { __type: "ThrottlingException", message: "Rate limit" },
        { status: 429 },
      );
    if (url.includes("foundation-model-availability")) {
      if (scenario === "metadata-denial")
        return Response.json(
          { __type: "AccessDeniedException", message: "Not authorized to read model availability" },
          { status: 403 },
        );
      const id = decodeURIComponent(url.split("/").at(-1) ?? "");
      return Response.json({
        modelId: id,
        authorizationStatus: "AUTHORIZED",
        entitlementAvailability:
          scenario === "blocked-upgrade" && id === "anthropic.claude-sonnet-5-5"
            ? "NOT_AVAILABLE"
            : "AVAILABLE",
        regionAvailability: "AVAILABLE",
        agreementAvailability: { status: "AVAILABLE" },
      });
    }
    if (scenario === "configured-denial" && url.includes("sonnet-5/"))
      return Response.json(
        {
          __type: "AccessDeniedException",
          message: "Not authorized to perform bedrock:InvokeModel",
        },
        { status: 403 },
      );
    return Response.json({
      content: [{ type: "text", text: "." }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  };
  context.subscriptions.push({
    dispose: () => {
      globalThis.fetch = originalFetch;
    },
  });
  context.subscriptions.push(
    vscode.commands.registerCommand("scdQA.scenario", async () => {
      const selected = await vscode.window.showQuickPick([...scenarios], {
        title: "Synthetic AWS scenario",
      });
      if (!selected) return;
      scenario = selected as Scenario;
      await writeFile(join(root, "scenario.txt"), scenario);
      await vscode.commands.executeCommand("sensibleDefaults.recheckModels");
      await appendFile(
        join(root, "actions.jsonl"),
        `${JSON.stringify({ action: "scenario", scenario, at: new Date().toISOString() })}\n`,
      );
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("scdQA.expire", async () => {
      const directory = join(
        context.globalStorageUri.fsPath,
        "..",
        "cutler-sg.sensible-claude-code-defaults",
        "model-availability",
      );
      for (const name of await readdir(directory)) {
        if (!name.endsWith(".json")) continue;
        const path = join(directory, name);
        const data = JSON.parse(await readFile(path, "utf8"));
        for (const entry of data.evidence ?? []) {
          entry.checkedAt -= 8 * 86_400_000;
          entry.lastAttemptAt -= 8 * 86_400_000;
          entry.nextCheckAt -= 8 * 86_400_000;
          if (entry.lastSuccessAt) entry.lastSuccessAt -= 8 * 86_400_000;
        }
        await writeFile(path, JSON.stringify(data));
      }
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }),
  );
  await appendFile(
    join(root, "actions.jsonl"),
    `${JSON.stringify({ action: "harness-activated", scenario, at: new Date().toISOString() })}\n`,
  );
}
