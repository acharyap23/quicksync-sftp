const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const SftpClient = require('ssh2-sftp-client');

let statusBarItem;
let lastSyncTime = 0;
let isSyncing = false;          // M-2: single-flight lock
let extContext = null;          // for SecretStorage + globalState
let transferQueue = null;       // Phase 3: shared upload queue
let connection = null;          // Phase 1/3: shared ConnectionManager
const compare = require('./compare'); // Phase 4
const safety = require('./safety'); // Phase 7
const { AuditLogger } = require('./audit');
let auditLogger = null;

// ---------- Secret deny-list (H-1: non-overridable) ----------
// These are ALWAYS skipped regardless of the user's ignore list. A
// misconfiguration must never be able to exfiltrate credentials.
const SECRET_DENY = [
  /(^|\/)\.env(\..+)?$/i,            // .env, .env.production, ...
  /\.env$/i,                          // prod.env, production.env, *.env
  /\.(pem|key|p12|pfx|ppk|asc|gpg)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)\.aws(\/|$)/i,
  /(^|\/)\.gcp(\/|$)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/)credentials(\.json|\.yml|\.yaml)?$/i,
  /(^|\/)secrets?(\.json|\.yml|\.yaml|\.env)?$/i,
  // Backups & database dumps — high-value theft targets.
  /\.(bak|backup|dump|sql\.gz|sqlite|sqlite3|db)$/i,
  /(^|\/)dump\.sql$/i,
  /\.(zip|tar|tar\.gz|tgz|rar|7z)$/i,
];

const ALWAYS_IGNORE = [
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '.DS_Store',
  '.vscode/quicksync.json',
  // R4: editor/OS temp & partial-write artifacts — avoid uploading torn files.
  '*.swp',
  '*.swo',
  '*~',
  '*.tmp',
  '*.part',
  '*.crdownload',
  'Thumbs.db',
];

// ---------- Config loading ----------

function getConfigPath() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  return path.join(folders[0].uri.fsPath, '.vscode', 'quicksync.json');
}

function getWorkspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  return folders[0].uri.fsPath;
}

// L-2: validate shape/types so malformed config fails loudly and safely.
function validateConfig(cfg) {
  if (typeof cfg !== 'object' || cfg === null) return 'config must be a JSON object';
  if (typeof cfg.host !== 'string' || !cfg.host.trim()) return 'host is required';
  if (typeof cfg.username !== 'string' || !cfg.username.trim()) return 'username is required';
  if (typeof cfg.remotePath !== 'string' || !cfg.remotePath.trim()) return 'remotePath is required';
  if (cfg.port !== undefined && (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535))
    return 'port must be an integer 1–65535';
  // M-1: remotePath must be absolute and free of traversal.
  const rp = cfg.remotePath.replace(/\\/g, '/');
  if (!rp.startsWith('/')) return 'remotePath must be an absolute path (start with /)';
  if (rp.split('/').includes('..')) return 'remotePath must not contain ".." segments';
  if (cfg.ignore !== undefined && !Array.isArray(cfg.ignore)) return 'ignore must be an array';
  return null;
}

async function loadConfig() {
  const configPath = getConfigPath();
  if (!configPath || !fs.existsSync(configPath)) return null;

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    vscode.window.showErrorMessage(`QuickSync: config is not valid JSON.`); // L-1: no raw err
    return null;
  }

  const problem = validateConfig(cfg);
  if (problem) {
    vscode.window.showErrorMessage(`QuickSync: invalid config — ${problem}`);
    return null;
  }

  // C-2: migrate any plaintext secrets into SecretStorage, then scrub the file.
  await migrateSecrets(cfg, configPath);

  // H-5: only honor privateKeyPath in trusted workspaces, and validate it.
  if (cfg.privateKeyPath && typeof cfg.privateKeyPath === 'string') {
    let p = cfg.privateKeyPath;
    if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
    cfg.privateKeyPath = path.resolve(p);
  }
  return cfg;
}

// ---------- Secrets (C-2) ----------

function secretKey(cfg, name) {
  // Site Manager configs carry _siteId → per-site secret namespace.
  if (cfg._siteId) return `quicksync:site:${cfg._siteId}:${name}`;
  return `quicksync:${cfg.host}:${cfg.port || 22}:${cfg.username}:${name}`;
}

// Resolve the connection config: the active Site Manager site if one is set,
// otherwise the legacy workspace .vscode/quicksync.json.
let siteManager = null;
async function resolveConfig() {
  if (siteManager) {
    const active = siteManager.getActiveConfig();
    if (active) return active;
  }
  return loadConfig();
}

// Lightweight, side-effect-free read of the workspace config for display in the
// Site Manager (no migration, no secrets, no prompts). Returns null if absent.
function getWorkspaceConfigInfo() {
  const p = getConfigPath();
  if (!p || !fs.existsSync(p)) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!cfg || typeof cfg.host !== 'string') return null;
    return { host: cfg.host, username: cfg.username || '', port: cfg.port || 22, remotePath: cfg.remotePath || '/' };
  } catch {
    return null;
  }
}

// R2: SecretStorage is global to the extension, so a stored credential can be
// reused from ANY workspace (incl. a malicious cloned repo that names the same
// host/user). We track, per workspace, which host/user it has been authorized
// to use — and confirm the first reuse of a saved credential in a new workspace.
function authzKey(cfg) {
  return `authz:${getWorkspaceRoot() || 'none'}:${cfg.host}:${cfg.port || 22}:${cfg.username}`;
}

function isWorkspaceAuthorized(cfg) {
  return extContext.globalState.get(authzKey(cfg)) === true;
}

function authorizeWorkspace(cfg) {
  return extContext.globalState.update(authzKey(cfg), true);
}

// Returns true if it's OK to use a stored credential here; false if declined.
async function ensureCredentialAllowedInWorkspace(cfg) {
  if (isWorkspaceAuthorized(cfg)) return true;
  const ok = await vscode.window.showWarningMessage(
    `QuickSync: use the saved credential for ${cfg.username}@${cfg.host}:${cfg.port || 22} in THIS workspace?\n\n` +
      `This credential was saved in another project. Only allow it if you trust this workspace to deploy to that server.`,
    { modal: true },
    'Use credential'
  );
  if (ok === 'Use credential') {
    await authorizeWorkspace(cfg);
    return true;
  }
  return false;
}

async function migrateSecrets(cfg, configPath) {
  let changed = false;
  for (const field of ['password', 'passphrase']) {
    if (typeof cfg[field] === 'string' && cfg[field].length > 0) {
      await extContext.secrets.store(secretKey(cfg, field), cfg[field]);
      delete cfg[field];
      changed = true;
    }
  }
  if (changed) {
    // The plaintext lived in THIS workspace, so it is implicitly authorized (R2).
    await authorizeWorkspace(cfg);
    try {
      // Rewrite the file without the secret fields.
      const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      delete onDisk.password;
      delete onDisk.passphrase;
      fs.writeFileSync(configPath, JSON.stringify(onDisk, null, 2));
      // R9: migration can't un-leak a secret that was already committed.
      vscode.window.showWarningMessage(
        'QuickSync: moved plaintext credentials from quicksync.json into the OS secret store and removed them from the file. ' +
          'If this password/passphrase was ever committed to git or backed up, ROTATE it now — it should be considered exposed.'
      );
    } catch {
      vscode.window.showWarningMessage(
        'QuickSync: stored credentials securely, but could not rewrite quicksync.json — please remove the password/passphrase fields manually.'
      );
    }
  }
}

// ---------- Ignore matching (H-2) ----------

// Glob → anchored regex (supports * and ?). Matches a single path segment.
function globToRegExp(glob) {
  let re = '';
  for (const ch of glob) {
    if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', process.platform === 'win32' ? 'i' : '');
}

function matchesPattern(relPath, pattern) {
  const segments = relPath.split('/');
  if (pattern.includes('*') || pattern.includes('?')) {
    const re = globToRegExp(pattern);
    return segments.some((s) => re.test(s)) || re.test(relPath);
  }
  // Exact segment match or exact full-path match (no loose substring).
  return segments.includes(pattern) || relPath === pattern;
}

function shouldIgnore(relPath, ignoreList) {
  const rel = relPath.split(path.sep).join('/');
  for (const re of SECRET_DENY) if (re.test(rel)) return true;     // H-1
  for (const ig of ALWAYS_IGNORE) if (matchesPattern(rel, ig)) return true;
  if (Array.isArray(ignoreList)) {
    for (const pattern of ignoreList) {
      if (typeof pattern === 'string' && matchesPattern(rel, pattern)) return true;
    }
  }
  return false;
}

// ---------- File walking ----------

// R5: hard cap so a pathological tree can't exhaust memory; async I/O so the
// extension-host thread stays responsive while scanning.
const MAX_FILES = 50000;

// True only if `realFull` is the root itself or lives beneath it.
function isContained(realRoot, realFull) {
  const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  return realFull === realRoot || realFull.startsWith(prefix);
}

async function walk(dir, root, ignoreList, files = [], realRoot = null) {
  if (files.length >= MAX_FILES) return files;
  if (realRoot === null) {
    try {
      realRoot = await fs.promises.realpath(root);
    } catch {
      realRoot = path.resolve(root);
    }
  }
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (files.length >= MAX_FILES) break;
    // M-5: skip symlinks explicitly (fast path).
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);

    // Surface-9 hardening: resolve the real path and skip anything that
    // escapes the workspace root. This catches Windows junctions and any
    // symlinked directory that isSymbolicLink() failed to flag — both of
    // which would otherwise produce an innocent-looking rel path.
    let realFull;
    try {
      realFull = await fs.promises.realpath(full);
    } catch {
      continue; // dangling/inaccessible — don't upload
    }
    if (!isContained(realRoot, realFull)) continue;

    const rel = path.relative(root, full);
    if (shouldIgnore(rel, ignoreList)) continue;
    if (entry.isDirectory()) {
      await walk(full, root, ignoreList, files, realRoot);
    } else if (entry.isFile()) {
      const st = await fs.promises.stat(full);
      files.push({ full, rel, mtime: st.mtimeMs });
    }
  }
  return files;
}

// ---------- Host-key verification (C-1, TOFU) ----------

function pinKey(host, port) {
  return `hostkey:${host}:${port}`;
}

// R6: compare fingerprints regardless of base64 padding or an "SHA256:"
// prefix, so a value copied from `ssh-keyscan`/OpenSSH still matches.
function normalizeFp(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/^sha256:/i, '').replace(/=+$/, '').trim();
}

function fingerprint(keyBuf) {
  // Stored/compared without padding to match the OpenSSH "SHA256:" form.
  return normalizeFp(crypto.createHash('sha256').update(keyBuf).digest('base64'));
}

function makeHostVerifier(cfg) {
  const host = cfg.host;
  const port = cfg.port || 22;
  // Async 2-arg form: ssh2 waits for callback(true/false).
  return (keyBuf, cb) => {
    const fp = fingerprint(keyBuf);
    const pinned = normalizeFp(extContext.globalState.get(pinKey(host, port)));

    // If the user supplied an expected fingerprint, it is authoritative.
    if (cfg.hostFingerprint) return cb(normalizeFp(cfg.hostFingerprint) === fp);

    if (pinned) {
      if (pinned === fp) return cb(true);
      // Fingerprint CHANGED since first trust — loud, explicit MITM warning.
      vscode.window.showErrorMessage(
        `QuickSync: ⚠ SSH host key for ${host}:${port} has CHANGED.\n` +
          `Expected: ${pinned}\nReceived: ${fp}\n` +
          `This may be a man-in-the-middle attack. Connection refused. ` +
          `If the server key legitimately changed, run "QuickSync: Reset Host Key" for this host.`,
        { modal: true }
      );
      return cb(false);
    }

    // Enterprise mode: no silent trust-on-first-use. Show the presented
    // fingerprint and require an explicit, informed decision. "Trust & Pin"
    // accepts it for this host (a later key change is still refused); "Copy
    // Fingerprint" lets the user pin it via config instead.
    if (enterpriseMode()) {
      const sha = 'SHA256:' + fp;
      vscode.window
        .showWarningMessage(
          `QuickSync (enterprise mode): host ${host}:${port} is not yet trusted.\n\n` +
            `The server presented:\n${sha}\n\n` +
            `Verify this fingerprint through a trusted channel. "Trust & Pin" accepts it now ` +
            `(a future key change will be refused). Otherwise Copy it and set "hostFingerprint" in config.`,
          { modal: true },
          'Trust & Pin',
          'Copy Fingerprint'
        )
        .then((choice) => {
          if (choice === 'Trust & Pin') {
            extContext.globalState.update(pinKey(host, port), fp);
            cb(true);
          } else {
            if (choice === 'Copy Fingerprint') vscode.env.clipboard.writeText(sha);
            cb(false);
          }
        });
      return;
    }

    // Trust On First Use: confirm with the user, then pin.
    vscode.window
      .showWarningMessage(
        `QuickSync: first connection to ${host}:${port}.\nServer key fingerprint (SHA-256):\n${fp}\n\nTrust this server?`,
        { modal: true },
        'Trust & Pin'
      )
      .then((choice) => {
        if (choice === 'Trust & Pin') {
          extContext.globalState.update(pinKey(host, port), fp);
          cb(true);
        } else {
          cb(false);
        }
      });
  };
}

// ---------- SFTP operations ----------

// Detect whether a private key is passphrase-encrypted (legacy PEM or the
// new OpenSSH format) so we can prompt for the passphrase before connecting.
function isEncryptedKey(buf) {
  const head = buf.toString('utf8', 0, Math.min(buf.length, 6000));
  if (/Proc-Type:\s*4,ENCRYPTED/i.test(head)) return true; // legacy PEM (RSA/EC/DSA)
  if (head.includes('-----BEGIN OPENSSH PRIVATE KEY-----')) {
    try {
      const b64 = head.replace('-----BEGIN OPENSSH PRIVATE KEY-----', '').split('-----END')[0].replace(/\s+/g, '');
      const data = Buffer.from(b64, 'base64');
      const magic = 'openssh-key-v1\0';
      if (data.slice(0, magic.length).toString('latin1') === magic) {
        let off = magic.length;
        const len = data.readUInt32BE(off);
        off += 4;
        const cipher = data.slice(off, off + len).toString('utf8');
        return cipher && cipher !== 'none';
      }
    } catch {
      /* fall through */
    }
  }
  return false;
}

async function connectSftp(cfg) {
  // Tolerate a "user@host" value mistakenly placed in the host field
  // (a common copy/paste from an `ssh user@host` command).
  if (typeof cfg.host === 'string' && cfg.host.includes('@')) {
    const at = cfg.host.lastIndexOf('@');
    if (!cfg.username) cfg.username = cfg.host.slice(0, at);
    cfg.host = cfg.host.slice(at + 1);
  }
  if (typeof cfg.host === 'string') cfg.host = cfg.host.trim();

  const sftp = new SftpClient();
  const connectOpts = {
    host: cfg.host,
    port: cfg.port || 22,
    username: cfg.username,
    readyTimeout: Math.min(cfg.readyTimeout || 20000, 60000), // M-4: capped
    keepaliveInterval: 15000,                                  // M-4
    hostVerifier: makeHostVerifier(cfg),                       // C-1
    // Pin strong algorithms only — prevents cipher/KEX/MAC downgrade attacks.
    algorithms: {
      kex: [
        'curve25519-sha256',
        'curve25519-sha256@libssh.org',
        'ecdh-sha2-nistp256',
        'ecdh-sha2-nistp384',
        'ecdh-sha2-nistp521',
        'diffie-hellman-group-exchange-sha256',
        'diffie-hellman-group16-sha512',
        'diffie-hellman-group18-sha512',
      ],
      // NOTE: chacha20-poly1305@openssh.com is intentionally omitted — ssh2
      // implements it only in its native addon, which this bundle does not ship
      // (pure-JS build). Pinning it would make every connection fail with
      // "Unsupported algorithm". AES-GCM/CTR are strong and pure-JS.
      cipher: [
        'aes256-gcm@openssh.com',
        'aes128-gcm@openssh.com',
        'aes256-ctr',
        'aes192-ctr',
        'aes128-ctr',
      ],
      hmac: ['hmac-sha2-512-etm@openssh.com', 'hmac-sha2-256-etm@openssh.com', 'hmac-sha2-512', 'hmac-sha2-256'],
      serverHostKey: ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'rsa-sha2-512', 'rsa-sha2-256'],
    },
  };

  // Warn (don't block) when deploying as root — encourage least privilege.
  if ((cfg.username || '').toLowerCase() === 'root') {
    vscode.window.showWarningMessage(
      'QuickSync: you are deploying as "root". Use a least-privilege deployment user with write access only to the target path.'
    );
  }

  if (cfg.privateKeyPath) {
    let real;
    try {
      real = fs.realpathSync(cfg.privateKeyPath);              // H-5
      if (!fs.statSync(real).isFile()) throw new Error('not a file');
    } catch {
      throw new Error('privateKeyPath does not point to a readable file');
    }
    // L1: warn if the key file is group/world-readable (POSIX only).
    try {
      if (process.platform !== 'win32' && (fs.statSync(real).mode & 0o077)) {
        vscode.window.showWarningMessage(
          `QuickSync: private key ${real} is group/world-readable. Restrict it: chmod 600 "${real}"`
        );
      }
    } catch {
      /* non-fatal */
    }
    connectOpts.privateKey = fs.readFileSync(real);
    let passphrase = await extContext.secrets.get(secretKey(cfg, 'passphrase'));
    if (passphrase) {
      // Reusing a stored passphrase — confirm for this workspace (R2).
      if (!(await ensureCredentialAllowedInWorkspace(cfg)))
        throw new Error('Credential use was not authorized for this workspace.');
    } else if (isEncryptedKey(connectOpts.privateKey)) {
      // Encrypted key with no stored passphrase → prompt securely and save it.
      passphrase = await vscode.window.showInputBox({
        prompt: `Passphrase for key ${path.basename(real)}`,
        password: true,
        ignoreFocusOut: true,
      });
      if (passphrase) {
        await extContext.secrets.store(secretKey(cfg, 'passphrase'), passphrase);
        await authorizeWorkspace(cfg);
      } else {
        throw new Error('Encrypted key requires a passphrase.');
      }
    }
    if (passphrase) connectOpts.passphrase = passphrase;
  } else {
    let password = await extContext.secrets.get(secretKey(cfg, 'password'));
    if (password) {
      if (!(await ensureCredentialAllowedInWorkspace(cfg))) // R2: reusing a stored secret
        throw new Error('Credential use was not authorized for this workspace.');
    } else {
      password = await vscode.window.showInputBox({
        prompt: `SFTP password for ${cfg.username}@${cfg.host}`,
        password: true,
        ignoreFocusOut: true,
      });
      if (!password) throw new Error('No privateKeyPath or password available.');
      await extContext.secrets.store(secretKey(cfg, 'password'), password);
      await authorizeWorkspace(cfg); // entered in this workspace → implicitly trusted
    }
    connectOpts.password = password;
  }

  await sftp.connect(connectOpts);
  return sftp;
}

// R3: atomic publish — upload to a temp name, then rename over the target so
// readers never see a half-written file and a crash can't leave a torn file live.
async function atomicPut(sftp, localFull, remotePath) {
  const tmp = remotePath + '.qs-tmp';
  try {
    await sftp.fastPut(localFull, tmp);
    try {
      // posix-rename@openssh.com atomically replaces an existing target.
      await sftp.posixRename(tmp, remotePath);
    } catch {
      // Fallback for servers without the extension: delete-then-rename.
      try { await sftp.delete(remotePath); } catch { /* may not exist */ }
      await sftp.rename(tmp, remotePath);
    }
  } catch (err) {
    try { await sftp.delete(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

async function ensureRemoteDir(sftp, remoteDir, knownDirs) {
  if (knownDirs.has(remoteDir)) return;
  const parts = remoteDir.split('/').filter(Boolean);
  let current = '';
  for (const p of parts) {
    current = current + '/' + p;
    if (!knownDirs.has(current)) {
      if (!(await sftp.exists(current))) await sftp.mkdir(current, true);
      knownDirs.add(current);
    }
  }
}

async function uploadFiles(cfg, files, progress, token) {
  const base = cfg.remotePath.replace(/\\/g, '/').replace(/\/$/, '');
  const sftp = await connectSftp(cfg);
  const knownDirs = new Set();
  let uploaded = 0;
  let failed = 0;
  const errors = [];
  const uploadedMtimes = []; // M-3: track only successful uploads

  try {
    for (let i = 0; i < files.length; i++) {
      if (token.isCancellationRequested) break;
      const f = files[i];
      const remoteRel = f.rel.split(path.sep).join('/');
      // M-1: defense-in-depth — reject traversal in the assembled path.
      if (remoteRel.split('/').includes('..')) {
        failed++;
        errors.push(`${f.rel}: rejected (path traversal)`);
        continue;
      }
      const remotePath = base + '/' + remoteRel;
      const remoteDir = remotePath.substring(0, remotePath.lastIndexOf('/'));

      try {
        await ensureRemoteDir(sftp, remoteDir, knownDirs);
        await atomicPut(sftp, f.full, remotePath);
        uploaded++;
        uploadedMtimes.push(f.mtime);
      } catch (err) {
        failed++;
        errors.push(`${f.rel}: upload failed`); // L-1: no raw err detail
      }

      progress.report({
        increment: 100 / files.length,
        message: `${i + 1}/${files.length} — ${f.rel}`,
      });
    }
  } finally {
    await sftp.end();
  }

  return { uploaded, failed, errors, uploadedMtimes };
}

// ---------- Commands ----------

async function runSync(onlyChanged) {
  // H-3: never operate in an untrusted workspace.
  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage('QuickSync is disabled in untrusted workspaces. Trust this folder to sync.');
    return;
  }
  // R1: acquire the lock synchronously BEFORE any await, so two rapid
  // invocations can't both pass the check (no TOCTOU window).
  if (isSyncing) {
    vscode.window.showInformationMessage('QuickSync: a sync is already in progress.');
    return;
  }
  isSyncing = true;

  try {
    const cfg = await resolveConfig();
    if (!cfg) {
      const choice = await vscode.window.showWarningMessage('QuickSync: no config found.', 'Create config');
      if (choice === 'Create config') await initConfig();
      return;
    }

    const root = getWorkspaceRoot();
    const allFiles = await walk(root, root, cfg.ignore || []);
    if (allFiles.length >= MAX_FILES) {
      vscode.window.showWarningMessage(
        `QuickSync: workspace exceeds ${MAX_FILES} files — only the first ${MAX_FILES} were scanned. Add large folders to "ignore".`
      );
    }

    let files = allFiles;
    if (onlyChanged && lastSyncTime > 0) {
      files = allFiles.filter((f) => f.mtime > lastSyncTime);
    }

    if (files.length === 0) {
      vscode.window.showInformationMessage('QuickSync: nothing to upload.');
      return;
    }

    // H-4: explicit confirmation before mass upload / overwrite.
    const fullSync = !onlyChanged || lastSyncTime === 0;
    if (fullSync) {
      const ok = await vscode.window.showWarningMessage(
        `QuickSync will upload ${files.length} file(s) to ${cfg.username}@${cfg.host}:${cfg.remotePath} and OVERWRITE existing remote files. Continue?`,
        { modal: true },
        'Upload'
      );
      if (ok !== 'Upload') return;
    }

    const startedAt = Date.now();
    setStatusBar('$(sync~spin) Syncing…', 'Sync in progress');

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `QuickSync: uploading ${files.length} file(s)`,
        cancellable: true,
      },
      async (progress, token) => {
        try {
          const result = await uploadFiles(cfg, files, progress, token);
          // M-3: only advance baseline if nothing failed; otherwise keep failed
          // files eligible for the next "changed" sync.
          if (result.failed === 0) {
            lastSyncTime = startedAt;
            vscode.window.showInformationMessage(`QuickSync: uploaded ${result.uploaded} file(s) ✓`);
          } else {
            vscode.window.showWarningMessage(
              `QuickSync: ${result.uploaded} uploaded, ${result.failed} failed. ${result.errors[0] || ''}`
            );
          }
        } catch (err) {
          // L-1: surface a generic message; full detail only to the dev console.
          console.error('QuickSync error:', err);
          vscode.window.showErrorMessage('QuickSync failed: could not complete the sync (see Developer Tools console).');
        } finally {
          resetStatusBar();
        }
      }
    );
  } finally {
    isSyncing = false; // released on every path: early return, error, or success
  }
}

// ---------- Phase 2: manual sync commands ----------

function requireTrust() {
  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage('QuickSync is disabled in untrusted workspaces.');
    return false;
  }
  return true;
}

// Map a local absolute path to its remote path under cfg.remotePath. Returns
// null if the file is outside the workspace.
function localToRemote(cfg, root, full) {
  const rel = path.relative(root, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const base = cfg.remotePath.replace(/\\/g, '/').replace(/\/$/, '');
  return base + '/' + rel.split(path.sep).join('/');
}

// Compare pre-flight is on when explicitly enabled or in enterprise mode.
function compareBeforeOverwriteEnabled() {
  const c = vscode.workspace.getConfiguration('quicksync');
  return c.get('compareBeforeOverwrite', false) || c.get('enterpriseMode', false);
}

async function compareWithRemoteCommand(uri) {
  if (!requireTrust()) return;
  const target = uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
  if (!target) {
    vscode.window.showInformationMessage('QuickSync: no file to compare.');
    return;
  }
  const cfg = await resolveConfig();
  if (!cfg) {
    vscode.window.showWarningMessage('QuickSync: no config found.');
    return;
  }
  const root = getWorkspaceRoot();
  const remotePath = localToRemote(cfg, root, target.fsPath);
  if (!remotePath) {
    vscode.window.showWarningMessage('QuickSync: file is outside the workspace.');
    return;
  }
  try {
    const sftp = await connection.getClient();
    await compare.compareWithRemote(sftp, target.fsPath, remotePath);
  } catch (err) {
    vscode.window.showErrorMessage(`QuickSync: compare failed (${err.message}).`);
  }
}

// ---------- Phase 7: deployment safety scan ----------

function enterpriseMode() {
  return vscode.workspace.getConfiguration('quicksync').get('enterpriseMode', false);
}

function safetyIgnoreKey() {
  return `safetyIgnore:${getWorkspaceRoot() || 'none'}`;
}

function getSafetyIgnores() {
  return extContext.globalState.get(safetyIgnoreKey()) || [];
}

async function addSafetyIgnores(rels) {
  const set = new Set(getSafetyIgnores());
  rels.forEach((r) => set.add(r));
  await extContext.globalState.update(safetyIgnoreKey(), [...set]);
}

// Returns the (possibly reduced) file list to upload, or null if cancelled.
// Manual uploads only — auto-sync filters silently instead of prompting.
async function reviewSensitive(files) {
  const ignored = new Set(getSafetyIgnores());
  let kept = files.filter((f) => !ignored.has(f.rel));
  const flagged = safety.classify(kept).filter((x) => !ignored.has(x.rel));
  if (flagged.length === 0) return kept;

  const shown = flagged.slice(0, 8).map((x) => `• ${x.rel}  (${x.reason})`).join('\n');
  const more = flagged.length > 8 ? `\n…and ${flagged.length - 8} more` : '';
  const pick = await vscode.window.showWarningMessage(
    `This upload contains ${flagged.length} potentially sensitive file(s):\n\n${shown}${more}\n\nContinue?`,
    { modal: true },
    'Upload Anyway',
    'Skip Sensitive',
    'Always Ignore These'
  );
  if (!pick) return null; // cancelled
  const flaggedSet = new Set(flagged.map((x) => x.rel));
  if (pick === 'Upload Anyway') return kept;
  if (pick === 'Always Ignore These') await addSafetyIgnores([...flaggedSet]);
  return kept.filter((f) => !flaggedSet.has(f.rel)); // Skip Sensitive + Always Ignore
}

// Push entries onto the shared transfer queue (Phase 3). Remote paths mirror
// the workspace layout under cfg.remotePath.
async function enqueueEntries(cfg, files, quiet) {
  if (files.length === 0) {
    if (!quiet) vscode.window.showInformationMessage('QuickSync: nothing to upload.');
    return;
  }
  if (!transferQueue) {
    vscode.window.showErrorMessage('QuickSync: transfer queue unavailable.');
    return;
  }
  // Enterprise mode: require an explicit confirmation for manual uploads.
  if (!quiet && enterpriseMode()) {
    const ok = await vscode.window.showWarningMessage(
      `Upload ${files.length} file(s) to ${cfg.username}@${cfg.host}:${cfg.remotePath} (overwrites existing)?`,
      { modal: true },
      'Upload'
    );
    if (ok !== 'Upload') return;
  }
  const base = cfg.remotePath.replace(/\\/g, '/').replace(/\/$/, '');
  for (const f of files) {
    const remoteRel = f.rel.split(path.sep).join('/');
    transferQueue.enqueue(f.full, base + '/' + remoteRel, f.rel);
  }
  if (!quiet) {
    vscode.window.showInformationMessage(
      `QuickSync: queued ${files.length} file(s) — see the QuickSync ▸ Transfers view.`
    );
  }
}

// ---------- Phase 6: auto-sync engine (off by default) ----------

let autoSyncTimer = null;
const autoSyncPending = new Set(); // local fsPaths saved since last flush
let autoSyncBaseline = 0; // mtime watermark for "workspaceChanges" mode

function autoSyncMode() {
  return vscode.workspace.getConfiguration('quicksync').get('autoSync', 'off');
}

// Called on every text-document save. Cheap, debounced, and loop-safe.
function scheduleAutoSync(doc) {
  if (autoSyncMode() === 'off') return;
  if (!vscode.workspace.isTrusted) return;
  if (!doc || doc.uri.scheme !== 'file') return; // ignore untitled / non-file
  const root = getWorkspaceRoot();
  if (!root) return;
  // Loop prevention: only act on files INSIDE the workspace. Remote-opened
  // temp files live in the OS temp dir (outside root) and are handled
  // separately, so they never re-trigger here. We never write into the
  // workspace ourselves, so uploads can't cause a save→upload→save loop.
  const rel = path.relative(root, doc.uri.fsPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return;
  autoSyncPending.add(doc.uri.fsPath);
  const delay = vscode.workspace.getConfiguration('quicksync').get('autoSyncDebounce', 1000);
  if (autoSyncTimer) clearTimeout(autoSyncTimer);
  autoSyncTimer = setTimeout(() => {
    flushAutoSync().catch((err) => console.error('QuickSync auto-sync error:', err));
  }, Math.max(200, Number(delay) || 1000));
}

async function flushAutoSync() {
  autoSyncTimer = null;
  const saved = [...autoSyncPending];
  autoSyncPending.clear();
  const mode = autoSyncMode();
  if (mode === 'off') return;
  if (!vscode.workspace.isTrusted) return;
  const cfg = await resolveConfig();
  if (!cfg) return;
  const root = getWorkspaceRoot();
  if (!root) return;

  let files = [];
  if (mode === 'workspaceChanges') {
    // Upload everything changed since the last flush (deny-list applied by walk).
    const prev = autoSyncBaseline;
    autoSyncBaseline = Date.now();
    const all = await walk(root, root, cfg.ignore || []);
    files = all.filter((f) => f.mtime > prev);
  } else {
    // "currentFile": just the saved file(s), deny-list filtered (silently).
    for (const full of saved) {
      const rel = path.relative(root, full);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      if (shouldIgnore(rel, cfg.ignore)) continue; // never auto-push secrets
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      files.push({ full, rel, mtime: st.mtimeMs });
    }
  }
  // Auto-sync never prompts: silently drop always-ignored + flagged-sensitive files.
  const ignored = new Set(getSafetyIgnores());
  files = files.filter((f) => !ignored.has(f.rel));
  const flagged = new Set(safety.classify(files).map((x) => x.rel));
  files = files.filter((f) => !flagged.has(f.rel));
  await enqueueEntries(cfg, files, /* quiet */ true);
}

// Turn a set of URIs into upload entries: files become entries (skipping
// out-of-workspace and deny-listed paths); directories are walked recursively.
async function collectEntries(uris, root, cfg) {
  const out = [];
  const seen = new Set();
  for (const uri of uris) {
    const full = uri.fsPath;
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const walked = await walk(full, root, cfg.ignore || []);
      for (const f of walked) {
        if (!seen.has(f.full)) {
          seen.add(f.full);
          out.push(f);
        }
      }
    } else if (stat.isFile()) {
      const rel = path.relative(root, full);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        vscode.window.showWarningMessage(`QuickSync: ${path.basename(full)} is outside the workspace; skipped.`);
        continue;
      }
      if (shouldIgnore(rel, cfg.ignore)) {
        vscode.window.showWarningMessage(`QuickSync: ${rel} is ignored (sensitive or ignore-listed); skipped.`);
        continue;
      }
      if (!seen.has(full)) {
        seen.add(full);
        out.push({ full, rel, mtime: stat.mtimeMs });
      }
    }
  }
  return out;
}

async function syncCurrentFile() {
  if (!requireTrust()) return;
  const ed = vscode.window.activeTextEditor;
  if (!ed) {
    vscode.window.showInformationMessage('QuickSync: no active file.');
    return;
  }
  const cfg = await resolveConfig();
  if (!cfg) {
    vscode.window.showWarningMessage('QuickSync: no config found.');
    return;
  }
  await ed.document.save();
  const root = getWorkspaceRoot();
  let files = await collectEntries([ed.document.uri], root, cfg);
  // Phase 7: scan for potentially sensitive content.
  const reviewed = await reviewSensitive(files);
  if (reviewed === null) return;
  files = reviewed;
  if (files.length === 0) return;
  // Phase 4: compare/confirm before overwriting a differing remote file.
  if (files.length === 1 && compareBeforeOverwriteEnabled() && connection) {
    try {
      const remotePath = localToRemote(cfg, root, files[0].full);
      const sftp = await connection.getClient();
      const action = await compare.decideBeforeOverwrite(sftp, files[0].full, remotePath);
      if (action !== 'upload') return;
    } catch {
      /* compare failed — fall through to normal upload */
    }
  }
  await enqueueEntries(cfg, files);
}

// Used by both "Sync Selected Files" (multi-select) and "Sync Folder".
async function syncUris(uris) {
  if (!requireTrust()) return;
  if (!uris || uris.length === 0) return;
  const cfg = await resolveConfig();
  if (!cfg) {
    vscode.window.showWarningMessage('QuickSync: no config found.');
    return;
  }
  const root = getWorkspaceRoot();
  let files = await collectEntries(uris, root, cfg);
  // Phase 7: scan for potentially sensitive content (enterprise confirm is in enqueueEntries).
  const reviewed = await reviewSensitive(files);
  if (reviewed === null) return;
  files = reviewed;
  await enqueueEntries(cfg, files);
}

async function initConfig() {
  const configPath = getConfigPath();
  if (!configPath) {
    vscode.window.showErrorMessage('QuickSync: open a folder first.');
    return;
  }
  if (fs.existsSync(configPath)) {
    vscode.window.showInformationMessage('QuickSync: config already exists.');
    const doc = await vscode.workspace.openTextDocument(configPath);
    vscode.window.showTextDocument(doc);
    return;
  }

  // No password/passphrase fields in the template — those go to SecretStorage.
  const template = {
    host: 'your-server.com',
    port: 22,
    username: 'your-username',
    privateKeyPath: '~/.ssh/id_rsa',
    remotePath: '/var/www/html',
    ignore: ['dist', '*.log', 'tmp'],
  };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(template, null, 2));

  // Best-effort: keep the config out of git.
  try {
    const root = getWorkspaceRoot();
    const gi = path.join(root, '.gitignore');
    const line = '.vscode/quicksync.json';
    const existing = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    if (!existing.split(/\r?\n/).includes(line)) {
      fs.appendFileSync(gi, (existing && !existing.endsWith('\n') ? '\n' : '') + line + '\n');
    }
  } catch {
    /* non-fatal */
  }

  const doc = await vscode.workspace.openTextDocument(configPath);
  vscode.window.showTextDocument(doc);
  vscode.window.showInformationMessage(
    'QuickSync: config created (added to .gitignore). For password auth, you will be prompted securely on first sync.'
  );
}

// Clears a pinned host key so the next connect re-runs TOFU. Use only when
// you have independently verified the server key legitimately changed.
async function resetHostKey() {
  const cfg = await resolveConfig();
  if (!cfg) {
    vscode.window.showErrorMessage('QuickSync: no config found.');
    return;
  }
  const key = pinKey(cfg.host, cfg.port || 22);
  const had = extContext.globalState.get(key);
  if (!had) {
    vscode.window.showInformationMessage(`QuickSync: no pinned key for ${cfg.host}:${cfg.port || 22}.`);
    return;
  }
  const ok = await vscode.window.showWarningMessage(
    `Forget the pinned SSH key for ${cfg.host}:${cfg.port || 22}? You will be asked to re-verify the fingerprint on the next sync.`,
    { modal: true },
    'Forget key'
  );
  if (ok === 'Forget key') {
    await extContext.globalState.update(key, undefined);
    vscode.window.showInformationMessage('QuickSync: host key forgotten.');
  }
}

// R7: erase stored password/passphrase and revoke this workspace's authorization
// for the configured host/user (data-minimization / right-to-erasure hygiene).
async function clearCredentials() {
  const cfg = await resolveConfig();
  if (!cfg) {
    vscode.window.showErrorMessage('QuickSync: no config found.');
    return;
  }
  const ok = await vscode.window.showWarningMessage(
    `Delete the saved password/passphrase for ${cfg.username}@${cfg.host}:${cfg.port || 22} from the OS secret store?`,
    { modal: true },
    'Delete'
  );
  if (ok !== 'Delete') return;
  await extContext.secrets.delete(secretKey(cfg, 'password'));
  await extContext.secrets.delete(secretKey(cfg, 'passphrase'));
  await extContext.globalState.update(authzKey(cfg), undefined);
  vscode.window.showInformationMessage('QuickSync: saved credentials cleared.');
}

// Phase 7: reset the per-workspace "always ignore" safety list.
async function clearSafetyIgnores() {
  await extContext.globalState.update(safetyIgnoreKey(), undefined);
  vscode.window.showInformationMessage('QuickSync: cleared the safety "always ignore" list for this workspace.');
}

// ---------- Status bar ----------

function setStatusBar(text, tooltip) {
  if (statusBarItem) {
    statusBarItem.text = text;
    statusBarItem.tooltip = tooltip;
  }
}

function resetStatusBar() {
  if (statusBarItem) {
    statusBarItem.text = '$(cloud-upload) Sync';
    statusBarItem.tooltip = 'QuickSync: click to sync changed files (Ctrl+Alt+S)';
  }
}

// ---------- Lifecycle ----------

function activate(context) {
  extContext = context;
  context.subscriptions.push(
    vscode.commands.registerCommand('quicksync.syncAll', () => runSync(false)),
    vscode.commands.registerCommand('quicksync.syncChanged', () => runSync(true)),
    vscode.commands.registerCommand('quicksync.initConfig', () => initConfig()),
    vscode.commands.registerCommand('quicksync.resetHostKey', () => resetHostKey()),
    vscode.commands.registerCommand('quicksync.clearCredentials', () => clearCredentials()),
    // Phase 2: manual sync controls
    vscode.commands.registerCommand('quicksync.syncCurrentFile', () => syncCurrentFile()),
    vscode.commands.registerCommand('quicksync.syncSelectedFiles', (uri, uris) =>
      syncUris(uris && uris.length ? uris : uri ? [uri] : [])
    ),
    vscode.commands.registerCommand('quicksync.syncFolder', (uri) => syncUris(uri ? [uri] : [])),
    vscode.commands.registerCommand('quicksync.syncWorkspace', () => runSync(false)),
    // Phase 4: compare
    vscode.commands.registerCommand('quicksync.compareWithRemote', (uri) => compareWithRemoteCommand(uri)),
    // Phase 7: safety
    vscode.commands.registerCommand('quicksync.clearSafetyIgnores', () => clearSafetyIgnores())
  );

  // Phases 1+3: native remote explorer + transfer queue, sharing one connection.
  const { registerRemoteExplorer, ConnectionManager } = require('./remoteExplorer');
  const { registerTransferQueue } = require('./transferQueue');
  auditLogger = new AuditLogger(context);
  context.subscriptions.push(vscode.commands.registerCommand('quicksync.openAuditLog', () => auditLogger.open()));

  // The connection resolves its target via resolveConfig (active site → legacy file).
  const conn = new ConnectionManager({ loadConfig: resolveConfig, connectSftp });
  connection = conn;
  transferQueue = registerTransferQueue(context, { audit: auditLogger });
  transferQueue.bindConnection(conn);
  registerRemoteExplorer(context, { loadConfig: resolveConfig, connectSftp, audit: auditLogger }, conn, transferQueue);

  // Site Manager — multi-site profiles driving the shared connection.
  const sitesMod = require('./sites');
  siteManager = sitesMod.registerSiteManager(context, {
    connection: conn,
    connectSftp,
    audit: auditLogger,
    getWorkspaceConfig: getWorkspaceConfigInfo,
    onActiveChanged: () => vscode.commands.executeCommand('quicksync.remote.refresh'),
  });
  // Refresh the Site Manager when a quicksync.json is created/edited/removed.
  const cfgWatcher = vscode.workspace.createFileSystemWatcher('**/.vscode/quicksync.json');
  const refreshSites = () => vscode.commands.executeCommand('quicksync.sites.refresh');
  cfgWatcher.onDidCreate(refreshSites);
  cfgWatcher.onDidChange(refreshSites);
  cfgWatcher.onDidDelete(refreshSites);
  context.subscriptions.push(cfgWatcher);

  // Phase 6: auto-sync on save (off by default). Baseline starts now so the
  // first save in "workspaceChanges" mode doesn't push the whole tree.
  autoSyncBaseline = Date.now();
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => scheduleAutoSync(doc)));

  // Phase 8: optional FileZilla-style dual-pane webview (CSP-locked).
  const dualPane = require('./dualPane');
  dualPane.registerDualPane(context, {
    loadConfig: resolveConfig,
    getWorkspaceRoot,
    getConnection: () => connection,
    getQueue: () => transferQueue,
    shouldIgnore,
    classify: safety.classify,
  });

  const showBar = vscode.workspace.getConfiguration('quicksync').get('showStatusBar', true);
  if (showBar) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'quicksync.syncChanged';
    resetStatusBar();
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
