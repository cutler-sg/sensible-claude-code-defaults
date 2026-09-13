# Preserve VS Code 1.98 compatibility

Michael confirmed that the extension must retain its existing VS Code 1.98 support floor.

- [x] Confirm main retains engines.vscode ^1.98.0 and @types/vscode ~1.98.0.
- [x] Constrain Dependabot to the compatible type release line.
- [x] Validate YAML and version boundaries (1.98 patches permitted; 1.99, 1.136 and 2.0 excluded), typecheck and VSIX packaging.
- [ ] Publish the configuration fix and close incompatible PR #28.

Acceptance: future @types/vscode updates stay below 1.99.0; compatible patches and unrelated dependency updates remain eligible. No support-floor increase or release.
