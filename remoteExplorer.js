// Phase 1 — Native VS Code remote explorer.
//
// Provides a TreeDataProvider-backed sidebar that browses the configured SFTP
// server and offers the core file operations (refresh, upload, download,
// rename, delete, new file/folder, open-and-edit). It reuses the host-key
// verification, SecretStorage and validation already implemented in
// extension.js — those are passed in as `deps` so there is one code path for
// connecting securely.

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const compare = require('./compare');

function fileSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const POSIX = path.posix;

// ---------- Connection manager (one live connection, lazily opened) ----------

class ConnectionManager {
  constructor(deps) {
    this.deps = deps; // { loadConfig, connectSftp }
    this.sftp = null;
    this.cfg = null;
    this.connecting = null; // in-flight promise (single-flight)
    this.onChange = null; // invoked on connect / disconnect / drop
  }

  isConnected() {
    return !!this.sftp;
  }

  _changed() {
    if (this.onChange) {
      try {
        this.onChange();
      } catch {
        /* ignore */
      }
    }
  }

  async getClient() {
    if (this.sftp) return this.sftp;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const cfg = await this.deps.loadConfig();
      if (!cfg) throw new Error('No QuickSync config found. Run "QuickSync: Create Config File".');
      const sftp = await this.deps.connectSftp(cfg);
      // If the server drops, clear our cached handle so the next call reconnects.
      const client = sftp.client || (sftp.sftp && sftp.sftp.client);
      if (client && client.on) {
        client.on('close', () => {
          this.sftp = null;
          this._changed();
        });
        client.on('error', () => {
          this.sftp = null;
          this._changed();
        });
      }
      this.sftp = sftp;
      this.cfg = cfg;
      return sftp;
    })();
    try {
      const s = await this.connecting;
      this._changed();
      return s;
    } finally {
      this.connecting = null;
    }
  }

  async disconnect() {
    const s = this.sftp;
    this.sftp = null;
    this.cfg = null;
    if (s) {
      try {
        await s.end();
      } catch {
        /* already gone */
      }
    }
    this._changed();
  }
}

// ---------- Tree model ----------

class RemoteItem extends vscode.TreeItem {
  constructor(entry, remotePath) {
    const isDir = entry.type === 'd';
    // FileZilla-style navigation: folders are NOT collapsible. Clicking
    // a folder enters it (replaces current view via
    // `quicksync.remote.enterDir`). Multi-select still picks up the
    // folder for context-menu actions like Download / Upload Here.
    super(entry.name, vscode.TreeItemCollapsibleState.None);
    this.entry = entry;
    this.remotePath = remotePath; // full POSIX path on the server
    this.isDir = isDir;
    this.contextValue = isDir ? 'quicksyncDir' : 'quicksyncFile';
    this.resourceUri = vscode.Uri.parse('quicksync-remote:' + remotePath); // drives file icons
    this.iconPath = isDir ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    if (isDir) {
      this.command = {
        command: 'quicksync.remote.enterDir',
        title: 'Enter Folder',
        arguments: [this],
      };
    } else {
      this.description = formatSize(entry.size);
      this.command = {
        command: 'quicksync.remote.openFile',
        title: 'Open Remote File',
        arguments: [this],
      };
    }
  }
}

/**
 * Special row that navigates up one level. Always sits at the top of
 * the list unless we're already at the configured base `remotePath`.
 */
class ParentNavItem extends vscode.TreeItem {
  constructor(currentDir, baseDir) {
    super('..', vscode.TreeItemCollapsibleState.None);
    this.description = POSIX.dirname(currentDir);
    this.iconPath = new vscode.ThemeIcon('arrow-up');
    this.contextValue = 'quicksyncParent'; // hides regular file/dir context menus
    this.isParentNav = true;
    this.command = {
      command: 'quicksync.remote.goUp',
      title: 'Go Up',
      arguments: [],
    };
  }
}

function formatSize(bytes) {
  if (bytes == null) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

class RemoteTreeProvider {
  constructor(conn) {
    this.conn = conn;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    /**
     * FileZilla-style: the tree always shows the contents of ONE
     * directory at a time. `currentDir` tracks where we are; null
     * means "use cfg.remotePath" (the configured root on the server).
     * `enterDir` / `goUp` mutate this and `refresh()` re-renders.
     */
    this._currentDir = null;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  /** Absolute POSIX path of the directory currently shown. */
  getCurrentDir() {
    const base = (this.conn.cfg && this.conn.cfg.remotePath) || '/';
    return (this._currentDir || base).replace(/\\/g, '/');
  }

  /** Configured root on the server. Used to clamp goUp(). */
  getBaseDir() {
    return ((this.conn.cfg && this.conn.cfg.remotePath) || '/').replace(/\\/g, '/');
  }

  /** Navigate into `dir` (absolute POSIX path). */
  enterDir(dir) {
    if (!dir) return;
    this._currentDir = dir;
    this.refresh();
  }

  /** Navigate to the parent of `currentDir`, clamped at the configured base. */
  goUp() {
    const cur = this.getCurrentDir();
    const base = this.getBaseDir();
    if (cur === base || cur === '/') return; // already at the root
    const parent = POSIX.dirname(cur);
    // Clamp: never go above the configured remotePath.
    const allowed = parent === base || parent.startsWith(base + '/') || parent.startsWith(base);
    this._currentDir = allowed ? parent : base;
    this.refresh();
  }

  getTreeItem(el) {
    return el;
  }

  async getChildren(element) {
    // IMPORTANT: never initiate a connection from rendering. VS Code calls
    // getChildren when the view is restored on startup/project-open; connecting
    // here would auto-connect (and, in enterprise mode, pop an error). Only show
    // remote contents once a connection has been established explicitly via
    // Connect; otherwise show a passive, click-to-connect placeholder.
    if (!this.conn.isConnected()) {
      if (element) return [];
      const item = new vscode.TreeItem(
        this.conn.deps && this.conn.deps._lastError ? this.conn.deps._lastError : 'Not connected — click to connect',
        vscode.TreeItemCollapsibleState.None
      );
      item.command = { command: 'quicksync.remote.connect', title: 'Connect' };
      item.iconPath = new vscode.ThemeIcon('plug');
      return [item];
    }

    // FileZilla-style: we only return contents of the *current* directory.
    // Folders are non-collapsible (no nested tree), so `element` is only
    // ever non-null if some legacy caller tries to expand — return [] to be safe.
    if (element) return [];

    let sftp;
    try {
      sftp = await this.conn.getClient();
    } catch {
      return [];
    }

    const dir = this.getCurrentDir();
    try {
      const list = await sftp.list(dir);
      const items = list
        .filter((e) => e.type === 'd' || e.type === '-') // skip symlinks/specials for safety
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'd' ? -1 : 1))
        .map((e) => new RemoteItem(e, POSIX.join(dir, e.name)));
      // Prepend a `..` row unless we're already at the configured root.
      if (dir !== this.getBaseDir() && dir !== '/') {
        return [new ParentNavItem(dir, this.getBaseDir()), ...items];
      }
      return items;
    } catch (err) {
      vscode.window.showErrorMessage(`QuickSync: cannot list ${dir}.`);
      return [];
    }
  }
}

// ---------- Helpers ----------

function enterpriseMode() {
  return vscode.workspace.getConfiguration('quicksync').get('enterpriseMode', false);
}

async function confirm(message, action) {
  const pick = await vscode.window.showWarningMessage(message, { modal: true }, action);
  return pick === action;
}

// Map of local temp file -> { remotePath, baseHash } for opened remote files.
// baseHash is the remote content hash AT OPEN TIME, used for conflict detection.
const openRemoteFiles = new Map();

// ---------- Registration ----------

function registerRemoteExplorer(context, deps, conn, queue) {
  if (!conn) conn = new ConnectionManager(deps);
  if (!conn.deps) conn.deps = deps;
  const audit = (deps && deps.audit) || { log() {} };
  const provider = new RemoteTreeProvider(conn);
  const view = vscode.window.createTreeView('quicksyncRemote', {
    treeDataProvider: provider,
    canSelectMany: true, // multi-select (Phase 2 builds on this)
    // FileZilla-style: folders are flat, so the global "collapse all"
    // button has nothing to do. Hide it to avoid confusion.
    showCollapseAll: false,
  });
  context.subscriptions.push(view);

  // Keep the view title in sync with the current directory so users
  // always know where they are. Path is relative to the configured
  // base remotePath where possible.
  const updateViewTitle = () => {
    if (!conn.isConnected()) {
      view.description = '';
      return;
    }
    const cur = provider.getCurrentDir();
    const base = provider.getBaseDir();
    if (cur === base) {
      view.description = '/';
      return;
    }
    const rel = cur.startsWith(base) ? cur.slice(base.length) : cur;
    view.description = rel.startsWith('/') ? rel : '/' + rel;
  };
  updateViewTitle();
  // Refresh the title whenever the tree refreshes (cheap, fires on every nav).
  context.subscriptions.push(provider.onDidChangeTreeData(updateViewTitle));

  const reg = (id, fn) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  // FileZilla-style navigation commands.
  reg('quicksync.remote.enterDir', (item) => {
    if (!item || !item.remotePath) return;
    provider.enterDir(item.remotePath);
  });
  reg('quicksync.remote.goUp', () => {
    provider.goUp();
  });
  reg('quicksync.remote.goHome', () => {
    provider.enterDir(provider.getBaseDir());
  });

  reg('quicksync.remote.connect', async () => {
    if (!vscode.workspace.isTrusted) {
      vscode.window.showWarningMessage('QuickSync is disabled in untrusted workspaces.');
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'QuickSync: connecting…' },
      async () => {
        try {
          conn.deps._lastError = null;
          await conn.getClient();
          provider.refresh();
          const c = conn.cfg || {};
          vscode.window.showInformationMessage(`QuickSync: connected to ${c.username || ''}@${c.host || 'server'} ✓`);
        } catch (err) {
          conn.deps._lastError = 'Connect failed — check config / fingerprint';
          vscode.window.showErrorMessage(`QuickSync: connection failed — ${err.message}`);
          provider.refresh();
        }
      }
    );
  });

  reg('quicksync.remote.disconnect', async () => {
    await conn.disconnect();
    provider.refresh();
    vscode.window.showInformationMessage('QuickSync: disconnected.');
  });

  reg('quicksync.remote.refresh', () => provider.refresh());

  // Open a remote file: download to a temp file, open it, and track it so a
  // later save can offer to upload the change back.
  reg('quicksync.remote.openFile', async (item) => {
    if (!item || !item.remotePath) return;
    try {
      const sftp = await conn.getClient();
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quicksync-'));
      const local = path.join(tmpDir, path.basename(item.remotePath));
      await sftp.fastGet(item.remotePath, local);
      // Record the remote content hash at open time for conflict detection.
      openRemoteFiles.set(local, { remotePath: item.remotePath, baseHash: fileSha256(local) });
      const doc = await vscode.workspace.openTextDocument(local);
      await vscode.window.showTextDocument(doc);
    } catch (err) {
      vscode.window.showErrorMessage(`QuickSync: could not open ${item.remotePath}.`);
    }
  });

  // Save-back: when a tracked remote-opened file is saved, upload it with
  // conflict detection (did the remote change since we opened it?).
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      const meta = openRemoteFiles.get(doc.uri.fsPath);
      if (!meta) return;
      const { remotePath, baseHash } = meta;
      const auto = vscode.workspace.getConfiguration('quicksync').get('autoUpload', false);
      const name = POSIX.basename(remotePath);

      let proceed = true;
      let c = null;
      try {
        const sftp = await conn.getClient();
        c = await compare.gather(sftp, doc.uri.fsPath, remotePath);
        if (c.exists) {
          if (c.localHash === c.remoteHash) {
            vscode.window.showInformationMessage(`QuickSync: ${name} is already up to date on the server.`);
            meta.baseHash = c.localHash;
            return;
          }
          const remoteChanged = baseHash && c.remoteHash !== baseHash;
          if (remoteChanged) {
            // True conflict: the server's copy changed under us.
            const pick = await vscode.window.showWarningMessage(
              `⚠ ${name} changed on the server since you opened it. Overwriting will discard the server's version.`,
              { modal: true },
              'Overwrite',
              'View Diff',
              'Cancel'
            );
            if (pick === 'View Diff') {
              await compare.openDiff(doc.uri.fsPath, c.remoteTmp);
              proceed =
                (await vscode.window.showWarningMessage(
                  'Overwrite the server version with your local changes?',
                  { modal: true },
                  'Overwrite'
                )) === 'Overwrite';
            } else {
              proceed = pick === 'Overwrite';
            }
          } else if (!auto) {
            proceed = await confirm(`Upload changes to ${remotePath}?`, 'Upload');
          }
        } else if (!auto) {
          proceed = await confirm(`Remote ${remotePath} no longer exists. Create it?`, 'Upload');
        }
      } catch {
        // Conflict check failed (e.g. offline) — fall back to a simple confirm.
        if (!auto) proceed = await confirm(`Upload changes to ${remotePath}?`, 'Upload');
      }
      if (!proceed) return;

      // After this upload the remote will equal our local content.
      meta.baseHash = c && c.localHash ? c.localHash : fileSha256(doc.uri.fsPath);
      if (queue) {
        queue.enqueue(doc.uri.fsPath, remotePath, name);
        return;
      }
      try {
        const sftp = await conn.getClient();
        await sftp.fastPut(doc.uri.fsPath, remotePath);
        vscode.window.showInformationMessage(`QuickSync: uploaded ${name} ✓`);
      } catch {
        vscode.window.showErrorMessage(`QuickSync: failed to upload ${remotePath}.`);
      }
    })
  );

  // Clean up the temp file (and tracking) when a remote-opened doc is closed.
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const meta = openRemoteFiles.get(doc.uri.fsPath);
      if (!meta) return;
      openRemoteFiles.delete(doc.uri.fsPath);
      try {
        fs.rmSync(path.dirname(doc.uri.fsPath), { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    })
  );

  reg('quicksync.remote.download', async (item) => {
    if (!item) return;
    const dest = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Download here',
    });
    if (!dest || !dest[0]) return;
    const target = dest[0].fsPath;
    // Overwrite confirmation if the target already exists locally.
    if (fs.existsSync(path.join(target, item.entry.name))) {
      if (!(await confirm(`"${item.entry.name}" already exists in the target folder and will be overwritten. Continue?`, 'Overwrite')))
        return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Downloading ${item.entry.name}` },
      async () => {
        try {
          const sftp = await conn.getClient();
          if (item.isDir) {
            await sftp.downloadDir(item.remotePath, path.join(target, item.entry.name));
          } else {
            await sftp.fastGet(item.remotePath, path.join(target, item.entry.name));
          }
          audit.log('download', { remotePath: item.remotePath, result: 'ok' });
          vscode.window.showInformationMessage(`QuickSync: downloaded ${item.entry.name} ✓`);
        } catch {
          vscode.window.showErrorMessage(`QuickSync: download of ${item.entry.name} failed.`);
        }
      }
    );
  });

  // Upload local file(s) into a remote directory item.
  reg('quicksync.remote.uploadHere', async (item) => {
    if (!item || !item.isDir) return;
    const picks = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Upload' });
    if (!picks || picks.length === 0) return;
    if (enterpriseMode() && !(await confirm(`Upload ${picks.length} file(s) to ${item.remotePath}?`, 'Upload')))
      return;
    // Overwrite confirmation — count picks that already exist on the server.
    let upSftp;
    try {
      upSftp = await conn.getClient();
    } catch {
      vscode.window.showErrorMessage('QuickSync: not connected.');
      return;
    }
    let overwrites = 0;
    for (const p of picks) {
      try {
        if (await upSftp.exists(POSIX.join(item.remotePath, path.basename(p.fsPath)))) overwrites++;
      } catch {
        /* ignore */
      }
    }
    if (overwrites > 0 && !(await confirm(`${overwrites} of ${picks.length} file(s) already exist on the server and will be overwritten. Continue?`, 'Overwrite')))
      return;
    if (queue) {
      for (const p of picks) {
        queue.enqueue(p.fsPath, POSIX.join(item.remotePath, path.basename(p.fsPath)), path.basename(p.fsPath));
      }
      vscode.window.showInformationMessage(`QuickSync: queued ${picks.length} file(s).`);
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Uploading to ${item.entry.name}` },
      async () => {
        const sftp = await conn.getClient();
        for (const p of picks) {
          try {
            await sftp.fastPut(p.fsPath, POSIX.join(item.remotePath, path.basename(p.fsPath)));
          } catch {
            vscode.window.showErrorMessage(`QuickSync: failed to upload ${path.basename(p.fsPath)}.`);
          }
        }
      }
    );
    provider.refresh();
  });

  reg('quicksync.remote.newFolder', async (item) => {
    const base = item && item.isDir ? item.remotePath : conn.cfg && conn.cfg.remotePath;
    if (!base) return;
    const name = await vscode.window.showInputBox({ prompt: 'New folder name' });
    if (!name || /[\\/]/.test(name) || name === '..') return;
    try {
      const sftp = await conn.getClient();
      await sftp.mkdir(POSIX.join(base, name), true);
      provider.refresh();
    } catch {
      vscode.window.showErrorMessage('QuickSync: could not create folder.');
    }
  });

  reg('quicksync.remote.newFile', async (item) => {
    const base = item && item.isDir ? item.remotePath : conn.cfg && conn.cfg.remotePath;
    if (!base) return;
    const name = await vscode.window.showInputBox({ prompt: 'New file name' });
    if (!name || /[\\/]/.test(name) || name === '..') return;
    try {
      const sftp = await conn.getClient();
      await sftp.put(Buffer.from(''), POSIX.join(base, name));
      provider.refresh();
    } catch {
      vscode.window.showErrorMessage('QuickSync: could not create file.');
    }
  });

  reg('quicksync.remote.rename', async (item) => {
    if (!item || !item.remotePath) return;
    const name = await vscode.window.showInputBox({ prompt: 'New name', value: item.entry.name });
    if (!name || name === item.entry.name || /[\\/]/.test(name) || name === '..') return;
    try {
      const sftp = await conn.getClient();
      const to = POSIX.join(POSIX.dirname(item.remotePath), name);
      await sftp.rename(item.remotePath, to);
      audit.log('rename', { from: item.remotePath, to });
      provider.refresh();
    } catch {
      vscode.window.showErrorMessage('QuickSync: rename failed.');
    }
  });

  reg('quicksync.remote.delete', async (item) => {
    // Multi-select aware: act on the full selection if present.
    const targets = view.selection && view.selection.length ? view.selection : [item];
    const valid = targets.filter((t) => t && t.remotePath);
    if (valid.length === 0) return;
    const label = valid.length === 1 ? valid[0].remotePath : `${valid.length} items`;
    if (!(await confirm(`Delete ${label} on the server? This cannot be undone.`, 'Delete'))) return;
    const sftp = await conn.getClient();
    for (const t of valid) {
      try {
        if (t.isDir) await sftp.rmdir(t.remotePath, true);
        else await sftp.delete(t.remotePath);
        audit.log('delete', { remotePath: t.remotePath, result: 'ok' });
      } catch {
        vscode.window.showErrorMessage(`QuickSync: could not delete ${t.entry.name}.`);
      }
    }
    provider.refresh();
  });

  // Restore a remote file from its most recent .quicksync-backups copy.
  reg('quicksync.remote.restore', async (item) => {
    if (!item || item.isDir) return;
    const dir = POSIX.dirname(item.remotePath);
    const base = POSIX.basename(item.remotePath);
    const bdir = POSIX.join(dir, '.quicksync-backups');
    try {
      const sftp = await conn.getClient();
      if (!(await sftp.exists(bdir))) {
        vscode.window.showInformationMessage('QuickSync: no backups for this file.');
        return;
      }
      const backups = (await sftp.list(bdir))
        .filter((e) => e.type === '-' && e.name.startsWith(base + '.'))
        .sort((a, b) => b.name.localeCompare(a.name)); // newest (timestamp) first
      if (backups.length === 0) {
        vscode.window.showInformationMessage('QuickSync: no backups for this file.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        backups.map((b) => ({ label: b.name.slice(base.length + 1), description: formatSize(b.size), name: b.name })),
        { placeHolder: `Restore which backup of ${base}?` }
      );
      if (!pick) return;
      const confirmRestore = await confirm(`Overwrite ${item.remotePath} with backup from ${pick.label}?`, 'Restore');
      if (!confirmRestore) return;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quicksync-rst-'));
      const local = path.join(tmpDir, base);
      await sftp.fastGet(POSIX.join(bdir, pick.name), local);
      await sftp.fastPut(local, item.remotePath);
      audit.log('restore', { remotePath: item.remotePath, from: pick.name, result: 'ok' });
      vscode.window.showInformationMessage(`QuickSync: restored ${base} from backup.`);
      provider.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(`QuickSync: restore failed (${err.message}).`);
    }
  });

  // Clean up temp files on shutdown.
  context.subscriptions.push({
    dispose: () => {
      conn.disconnect();
    },
  });

  return { conn, provider, view };
}

module.exports = { registerRemoteExplorer, ConnectionManager };
