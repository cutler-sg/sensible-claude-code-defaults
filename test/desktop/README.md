# Synthetic model-availability desktop fixture

`harness.ts` is a separate, test-only VS Code extension. It intercepts the public
manifest and Bedrock fetches, logs only URLs/methods/scenario names, and provides
scenario-selection and evidence-expiry commands. It is excluded from the VSIX.

Use a fresh temporary directory with separate `portable`, `user-data`,
`extensions`, `workspace`, `claude`, `harness`, and `shots` directories. Never use
real credentials; the fixture accepts only `synthetic-desktop-model-check-token`.

1. Build the product VSIX and install it into that isolated extension directory.
2. Bundle this file with esbuild, externalising `vscode`, into
   `<fixture>/harness/harness.js`.
3. Give the harness package the ID `local-test.scd-model-qa`, version `0.0.1`,
   engine `^1.98.0`, main `./harness.js`, activation event `*`, and command titles
   `QA: Select Synthetic AWS Scenario` (`scdQA.scenario`) and
   `QA: Expire Model Evidence and Reload` (`scdQA.expire`).
4. In the **installed fixture copy only**, append `local-test.scd-model-qa` to
   the product's `extensionDependencies`. This forces the interceptor to activate
   before the product captures `fetch`, including when its panel restores on
   reload. Do not change the source package or shipped VSIX for this dependency.
5. Launch VS Code with `DISPLAY=:99`, `VSCODE_PORTABLE=<fixture>/portable`,
   `CLAUDE_CONFIG_DIR=<fixture>/claude`, `SCD_MODEL_QA_DIR=<fixture>`, explicit
   `--user-data-dir` / `--extensions-dir`, and
   `--extensionDevelopmentPath=<fixture>/harness`. Unset inherited
   `ELECTRON_RUN_AS_NODE` and `VSCODE_IPC_HOOK_CLI`.
6. Set up the extension through its UI with the dummy key. Select scenarios
   through the command palette; the scenario picker runs the real Recheck
   command. The expiry command changes only fixture evidence and reloads the
   window. Inspect `requests.jsonl` alongside screenshots to verify dispatch.

If no OS keyring is available, a disposable profile may use
`--password-store=basic` for its dummy key. This does not test keyring encryption.
An environment needing Electron's `--no-sandbox` must record that limitation.
Never change X11 access controls, existing sessions, or real credential stores.

The shipped package can be reinstalled repeatedly. Reapply the fixture-only
harness dependency after each reinstall. Close only the fixture's own window
through the UI when done. See `docs/model-availability-verification.md` for the
completed scenarios and measured request counts.
