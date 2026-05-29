# Changelog

All notable changes to QuickSync SFTP are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-05-29

Initial release.

### Features
- One-click status-bar **Sync** button and `Ctrl+Alt+S` / `Cmd+Alt+S` shortcut.
- Two modes: **Sync Changed Files** (since last sync) and **Sync All to Remote** (with confirmation).
- SSH key or password authentication.
- Per-project config at `.vscode/quicksync.json` (auto-added to `.gitignore`).

### Security
- **SSH host-key verification** with trust-on-first-use pinning; changed keys are refused with a warning. Optional `hostFingerprint` pre-pinning.
- **Strong-algorithm-only** SSH policy (downgrade-resistant KEX/cipher/MAC/host-key).
- **Secrets in the OS keychain** via VS Code `SecretStorage` — never stored in `quicksync.json`. Plaintext secrets found in config are auto-migrated and scrubbed.
- **Workspace Trust** required; reuse of a saved credential in a new workspace requires confirmation.
- **Non-overridable deny-list** blocks `.env*`, `*.pem/.key/.p12/.ppk`, `id_rsa*`, `.ssh/`, `.aws/`, `.npmrc`, credential/secret files, database dumps, and backup archives.
- **Path-traversal and symlink/junction containment** keeps uploads inside the workspace and the configured `remotePath`.
- **Atomic uploads** (temp-then-rename); single-flight lock; confirmation before mass upload/overwrite.
- Commands: **Reset Host Key** and **Clear Saved Credentials**.

### Build & release
- Bundled with esbuild.
- CI: locked install, `npm audit` gate, build-provenance attestation, checksummed releases, protected-environment publishing.
