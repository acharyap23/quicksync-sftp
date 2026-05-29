# QuickSync SFTP

A secure, native SFTP client for VS Code — browse and edit your server, sync files
manually or on save, with a transfer queue, diff-before-overwrite, and an optional
FileZilla-style dual-pane view. Safe by default: nothing auto-uploads unless you turn
it on, and secrets are never pushed or stored in your project.

## Interfaces

- **QuickSync sidebar (primary)** — a native tree view of your remote server in the
  activity bar. Browse folders, open & edit files, upload/download, rename, delete,
  create files/folders, multi-select.
- **Transfers view** — a live queue showing each upload's progress, speed, ETA and
  state, with cancel/retry.
- **Dual-Pane Explorer (optional)** — a FileZilla-style local↔remote panel
  (`QuickSync: Open Dual-Pane Explorer`) with navigation, filter, multi-select and
  drag-to-upload. CSP-locked webview.
- **Manual controls** — status-bar button, `Ctrl+Alt+S` / `Cmd+Alt+S`, editor-title
  and Explorer right-click commands.

## Security model (read this)

QuickSync is built to be safe against a hostile network and a hostile repository:

- **Host-key verification (anti-MITM):** the server's SHA-256 fingerprint is pinned
  on first connect; a changed key is **refused**. Set `hostFingerprint` to pre-pin.
- **Strong algorithms only** — downgrade-resistant KEX/cipher/MAC/host-key policy.
- **Secrets in the OS keychain** via `SecretStorage` — never in `quicksync.json`.
  Plaintext secrets found in config are migrated out and scrubbed (rotate them if
  they were ever committed).
- **Workspace Trust required**; reuse of a saved credential in a new workspace needs
  confirmation; the dual-pane and all sync paths are disabled in untrusted workspaces.
- **Non-overridable deny-list** — `.env*`, `*.pem/.key/.p12/.ppk`, `id_rsa*`, `.ssh/`,
  `.aws/`, `.npmrc`, credentials/secrets, DB dumps and backup archives are **never**
  uploaded, even manually.
- **Deployment safety scan** — warns about other sensitive files (server configs,
  certs, embedded private keys / cloud tokens) with Upload / Skip / Always-Ignore.
- **Atomic uploads** (temp-then-rename), path-traversal & symlink/junction containment,
  confirmation before mass upload/overwrite, conflict detection when editing remote files.
- **No telemetry.** Data goes only to the server you configure.

> ⚠️ Client-side checks can't confine an over-privileged SSH account. Harden the server
> too — see [Server-side hardening](#server-side-hardening-strongly-recommended).

## Setup

1. Install dependencies and package (see Development below) or install the `.vsix`.
2. Open your project and **Trust** the workspace.
3. Command Palette → **QuickSync: Create Config File** → edit `.vscode/quicksync.json`
   (auto-added to `.gitignore`):
   ```json
   {
     "host": "your-server.com",
     "port": 22,
     "username": "deploy",
     "privateKeyPath": "~/.ssh/id_rsa",
     "remotePath": "/var/www/html",
     "ignore": ["dist", "*.log", "tmp"]
   }
   ```
   Do **not** put a `password`/`passphrase` here — you'll be prompted securely and the
   value goes to the OS keychain. Optionally set `hostFingerprint` (e.g. `SHA256:…`).
4. Open the **QuickSync** sidebar and click **Connect**, or press `Ctrl+Alt+S`. On first
   connect, verify the displayed fingerprint out-of-band before trusting it.

## Commands

| Command | Action |
|---|---|
| Sync Current File / Selected File(s) / Folder / Workspace | Upload via the transfer queue |
| Compare with Remote | Diff local vs remote (size/mtime/SHA-256 + VS Code diff) |
| Open Dual-Pane Explorer | FileZilla-style local↔remote panel |
| Remote: Connect / Disconnect / Refresh | Manage the connection / tree |
| Remote: New File / New Folder / Rename / Delete / Download / Upload Here | File ops |
| Reset Host Key | Forget a pinned key (after a verified rotation) |
| Clear Saved Credentials | Delete stored password/passphrase |
| Clear Safety "Always Ignore" List | Reset per-workspace safety choices |

## Settings

| Setting | Default | Description |
|---|---|---|
| `quicksync.showStatusBar` | `true` | Show the status-bar sync button |
| `quicksync.autoSync` | `off` | `off` / `currentFile` / `workspaceChanges` — auto-upload on save |
| `quicksync.autoSyncDebounce` | `1000` | Debounce (ms) before auto-sync uploads |
| `quicksync.autoUpload` | `false` | Auto-upload files opened **from** the remote on save (no prompt) |
| `quicksync.concurrentTransfers` | `1` | Parallel uploads in the queue (1 = sequential) |
| `quicksync.compareBeforeOverwrite` | `false` | Compare/confirm before overwriting on single-file sync |
| `quicksync.enterpriseMode` | `false` | Require confirmations; enforce host-fingerprint pinning (no TOFU) |

Secrets (`password`, `passphrase`) are **not** settings — they live in the OS keychain.

## Server-side hardening (strongly recommended)

Confine the deployment account so uploads can't escape the target directory:

1. Create a least-privilege `deploy` user — never deploy as `root`.
2. Chroot it in `/etc/ssh/sshd_config`:
   ```
   Match User deploy
       ChrootDirectory /var/www
       ForceCommand internal-sftp
       AllowTcpForwarding no
   ```
   `ChrootDirectory` must be root-owned and not writable by the user; put the writable
   web root one level below (e.g. `/var/www/html`).
3. Install only the public key for `deploy`; disable its password auth.

With this, even a crafted `remotePath` cannot escape `/var/www`.

## Development

```bash
npm ci            # locked install
npm run build     # bundle with esbuild
npx @vscode/vsce package
```

CI runs `npm audit` and produces a checksummed, provenance-attested release on tags.

## Notes

- Auto-sync is **off** by default; sensitive files are never auto-uploaded.
- Built on [`ssh2-sftp-client`](https://www.npmjs.com/package/ssh2-sftp-client).
- Security reports: see [SECURITY.md](SECURITY.md).
