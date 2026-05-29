# QuickSync SFTP

A minimal VS Code extension that adds a one-click **Sync** button to your status bar for SFTP uploads. No auto-on-save — you sync only when you decide to.

## Features

- **One-click status bar button** (`☁ Sync`) — uploads files changed since the last sync.
- **Keyboard shortcut**: `Ctrl+Alt+S` (Windows/Linux) or `Cmd+Alt+S` (Mac).
- **Two modes**:
  - `QuickSync: Sync Changed Files` — only files modified since last sync (fast).
  - `QuickSync: Sync All to Remote` — full upload (asks for confirmation).
- **SSH key or password** authentication — secrets are stored in the OS keychain, never in the project.
- **Verified, encrypted transport** — SSH host-key pinning and a strong-algorithm-only policy.
- **Ignore list** plus a built-in, non-overridable deny-list for secrets and junk files.

## Security model (read this)

QuickSync is built to be safe against a hostile network and a hostile repository:

- **Host-key verification (anti-MITM).** On the first connection to a server you confirm its SHA-256 fingerprint and it is *pinned*. If the key ever changes, the connection is **refused** with a warning — there is no silent trust.
- **Strong algorithms only.** Weak ciphers/KEX/MACs are not offered, blocking downgrade attacks.
- **Secrets in the OS keychain.** Passwords and key passphrases are stored via VS Code `SecretStorage` (Keychain / DPAPI / libsecret) — **never** written to `quicksync.json`. If an old config still contains a plaintext secret, it is migrated to the keychain and stripped from the file automatically (rotate that secret if it was ever committed).
- **Workspace trust.** The extension does nothing in untrusted workspaces, and reusing a saved credential in a *different* workspace requires explicit confirmation.
- **Secret deny-list.** `.env*`, `*.pem/.key/.p12/.ppk`, `id_rsa*`, `.ssh/`, `.aws/`, `.npmrc`, `.netrc`, `credentials*`, `secrets*`, database dumps and backup archives are **always** skipped, regardless of your `ignore` list.
- **Confirmation before mass upload / overwrite**, atomic uploads (temp-then-rename), and a single-flight lock.

> ⚠️ **Client-side controls cannot confine a server-side account.** The only reliable way to guarantee uploads can't escape your deployment directory is to harden the server — see [Server-side hardening](#server-side-hardening-strongly-recommended) below.

## Installation (local development)

1. Copy this folder somewhere permanent, e.g. `~/vscode-extensions/quicksync-sftp`.
2. Install the runtime dependency from the committed lockfile:
   ```bash
   npm ci
   ```
3. Install the VS Code extension packager (one-time):
   ```bash
   npm install -g @vscode/vsce
   ```
4. Package the extension into a `.vsix` file:
   ```bash
   vsce package
   ```
   This produces something like `quicksync-sftp-0.1.0.vsix`.
5. Install it in VS Code:
   - Open VS Code → Extensions panel → `…` menu → **Install from VSIX…** → pick the file.
   - Or from terminal: `code --install-extension quicksync-sftp-0.1.0.vsix`

## First-time setup

1. Open your project folder in VS Code (and **Trust** it).
2. Command Palette (`Ctrl+Shift+P`) → **QuickSync: Create Config File**. This writes a template to `.vscode/quicksync.json` and adds it to `.gitignore`.
3. Edit the generated `.vscode/quicksync.json`:
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
   **Do not put a `password` or `passphrase` here.** For password auth, leave `privateKeyPath` out — you'll be prompted securely on first sync and the value goes to the OS keychain. For an encrypted key, you'll likewise be prompted for the passphrase.
4. Click the **☁ Sync** button (or press `Ctrl+Alt+S`). On the first connect, verify the displayed fingerprint against your server (`ssh-keyscan -t ed25519 your-server.com | ssh-keygen -lf -`) before trusting it.

## Config options

| Key | Description |
|---|---|
| `host` | SFTP server hostname (**required**) |
| `port` | Port (default `22`) |
| `username` | SSH username (**required**; avoid `root`) |
| `privateKeyPath` | Path to SSH private key (`~` is expanded). Omit to use password auth. |
| `remotePath` | Base directory on the server (**required**; must be absolute, no `..`) |
| `hostFingerprint` | *(optional)* Expected SHA-256 host fingerprint to pin up front (e.g. `SHA256:…`). If set, it is authoritative. |
| `ignore` | Array of names/globs to skip (e.g. `"dist"`, `"*.log"`). Matched per path-segment; `*` and `?` supported. |

Secrets (`password`, `passphrase`) are **not** config keys — they live in the OS keychain.

## Commands

| Command | What it does |
|---|---|
| `QuickSync: Sync Changed Files` | Upload files modified since the last sync this session |
| `QuickSync: Sync All to Remote` | Full upload (with confirmation) |
| `QuickSync: Create Config File` | Generate the template and `.gitignore` entry |
| `QuickSync: Reset Host Key` | Forget the pinned host key (use only after verifying a legitimate key rotation) |
| `QuickSync: Clear Saved Credentials` | Delete the stored password/passphrase and revoke this workspace's authorization |

## Server-side hardening (strongly recommended)

QuickSync validates paths client-side, but a malicious or misconfigured server, or an overly powerful SSH account, can still let uploads land outside your intended directory. Confine the deployment account on the server:

1. **Create a dedicated, least-privilege deploy user** — never deploy as `root`:
   ```bash
   sudo adduser --disabled-password --gecos "" deploy
   sudo mkdir -p /var/www/html && sudo chown root:root /var/www
   ```
2. **Chroot it to the deployment root** with SFTP-only access. In `/etc/ssh/sshd_config`:
   ```
   Match User deploy
       ChrootDirectory /var/www
       ForceCommand internal-sftp
       AllowTcpForwarding no
       X11Forwarding no
       PermitTunnel no
   ```
   > `ChrootDirectory` must be owned by `root` and not writable by the user; put the writable web root one level below (e.g. `/var/www/html`).
3. **Install only the public key** for the deploy user (`~deploy/.ssh/authorized_keys`, mode `600`); disable password auth for it.
4. **Restrict file permissions** so deployed files aren't world-writable; serve the web root read-only to the web server where possible.

With this in place, even a crafted `remotePath` cannot escape `/var/www`, and a stolen deploy key grants nothing beyond writing files to that directory.

## Notes

- Prefer SSH keys over passwords; keep keys at `chmod 600` (QuickSync warns if a key is group/world-readable).
- The "changed files" mode tracks mtime since the last successful sync in this VS Code session. After a fresh restart, the first sync re-baselines (uploads everything matching the ignore rules) and asks for confirmation.
- Built on [`ssh2-sftp-client`](https://www.npmjs.com/package/ssh2-sftp-client). Run `npm audit` regularly; CI does this on every push (see `.github/workflows/ci.yml`).
- Security reports: see [SECURITY.md](SECURITY.md).
