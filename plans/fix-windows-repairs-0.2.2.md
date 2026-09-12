# Windows repairs — 0.2.2

Scope: repair ACL verification and Windows terminal launching reported on 0.2.1;
publish 0.2.2 through the unchanged pre-release workflow. No global PATH edits,
security-policy bypasses, credential changes, or CI/publishing configuration changes.

Acceptance criteria:
- Windows ACL exports decode reliably; malformed/empty/failed reads never pass.
- Native Windows tests exercise real icacls, in addition to synthetic fixtures.
- Unverifiable permissions explain the failure and offer a truthful next action.
- Users can launch the verified bundled Claude executable from the extension
  without depending on terminal-only PATH changes or an executable in the workspace.
- Existing settings and commands remain intact, including restricted-device failures.
- Full test/typecheck/lint/package checks pass locally and on the existing CI matrix.
- Version 0.2.2 is independently verified on the public Marketplace after publishing.

Tasks:
- [x] Diagnose and repair ACL decoding/validation with regression tests.
- [x] Repair Windows launch integration and actionable health-check UI.
- [x] Update release notes and corporate retest instructions; verify locally.
- [ ] Open PR, verify CI, merge the reviewed head, and publish v0.2.2.
- [ ] Verify public package identity/version and report remaining platform limits.

Evidence: corporate terminal resolves the bundled 2.1.269 executable and runs it;
upstream Launch in terminal still rejects the extension-host PATH. Permission
tooltip reports no DACL in the export; BOM-less UTF-16 is a reproduced candidate,
not yet proven to be the corporate machine's output.

Local validation: 1,968 tests passed; 2 skipped (one existing and the new native
Windows ACL test on Linux). Lint, typecheck and VSIX packaging passed. Impeccable
hardening guidance informed actionable warnings; its detector reported no findings.
The upstream Claude terminal button is not patched or overridden. The new explicit
launcher is accessible in our view and never changes process/global PATH.

PR: https://github.com/cutler-sg/sensible-claude-code-defaults/pull/30
First Windows CI pass exercised all 44 ACL tests, including native icacls,
successfully. Two older UI assertions still expected POSIX-only wording on
Windows; corrected those exact expectations. No assertion was removed or skipped.
Linux extension-host validation: 7 passed, the native Windows terminal case skipped.
