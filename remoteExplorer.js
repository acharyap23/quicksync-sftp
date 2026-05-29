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

const POSIX = path.posix;

// ---------- Connection manager (one live connection, lazily opened) ----------

class ConnectionManager {
  constructor(deps) {
    this.deps = deps; // { loadConfig, connectSftp }
    this.sftp = null;
    this.cfg = null;
    this.connecting = null; // in-flight promise (single-flight)
  }

  isConnected() {
    return !!this.sftp;
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
        });
        client.on('error', () => {
          this.sftp = null;
        });
      }
      this.sftp = sftp;
      this.cfg = cfg;
      return sftp;
    })();
    try {
      return await this.connecting;
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
  }
}

// ---------- Tree model ----------

class RemoteItem extends vscode.TreeItem {
  constructor(entry, remotePath) {
    const isDir = entry.type === 'd';
    super(
      entry.name,
      isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    this.entry = entry;
    this.remotePath = remotePath; // full POSIX path on the server
    this.isDir = isDir;
    this.contextValue = isDir ? 'quicksyncDir' : 'quicksyncFile';
    this.resourceUri = vscode.Uri.parse('quicksync-remote:' + remotePath); // drives file icons
    this.iconPath = isDir ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    if (!isDir) {
      this.description = formatSize(entry.size);
      this.command = {
        command: 'quicksync.remote.openFile',
        title: 'Open Remote File',
        arguments: [this],
      };
    }
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
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(el) {
    return el;
  }

  async getChildren(element) {
    let sftp;
    try {
      sftp = await this.conn.getClient();
    } catch (err) {
      // Show a single, clickable placeholder rather than throwing.
      const item = new vscode.TreeItem(
        this.conn.deps._lastError || 'Not connected — click to connect',
        vscode.TreeItemCollapsibleState.None
      );
      item.command = { command: 'quicksync.remote.connect', title: 'Connect' };
      item.iconPath = new vscode.ThemeIcon('plug');
      return element ? [] : [item];
    }

    const dir = element ? element.remotePath : this.conn.cfg.remotePath.replace(/\\/g, '/');
    try {
      const list = await sftp.list(dir);
      return list
        .filter((e) => e.type === 'd' || e.type === '-') // skip symlinks/specials for safety
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'd' ? -1 : 1))
        .map((e) => new RemoteItem(e, POSIX.join(dir, e.name)));
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

// Map of local temp file -> remote path, for save-back of opened remote files.
const openRemoteFiles = new Map();

// ---------- Registration ----------

function registerRemoteExplorer(context, deps, conn, queue) {
  if (!conn) conn = new ConnectionManager(deps);
  if (!conn.deps) conn.deps = deps;
  const provider = new RemoteTreeProvider(conn);
  const view = vscode.window.createTreeView('quicksyncRemote', {
    treeDataProvider: provider,
    canSelectMany: true, // multi-select (Phase 2 builds on this)
    showCollapseAll: true,
  });
  context.subscriptions.push(view);

  const reg = (id, fn) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('quicksync.remote.connect', async () => {
    if (!vscode.workspace.isTrusted) {
      vscode.window.showWarningMessage('QuickSync is disabled in untrusted workspaces.');
      return;
    }
    try {
      conn.deps._lastError = null;
      await conn.getClient();
      provider.refresh();
    } catch (err) {
      conn.deps._lastError = 'Connect failed — check config / fingerprint';
      vscode.window.showErrorMessage(`QuickSync: ${err.message}`);
      provider.refresh();
    }
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
      openRemoteFiles.set(local, item.remotePath);
      const doc = await vscode.workspace.openTextDocument(local);
      await vscode.window.showTextDocument(doc);
    } catch (err) {
      vscode.window.showErrorMessage(`QuickSync: could not open ${item.remotePath}.`);
    }
  });

  // Save-back: when a tracked temp file is saved, offer to upload it.
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      const remote = openRemoteFiles.get(doc.uri.fsPath);
      if (!remote) return;
      const auto = vscode.workspace.getConfiguration('quicksync').get('autoUpload', false);
      if (!auto && !(await confirm(`Upload changes to ${remote}?`, 'Upload'))) return;
      if (queue) {
        queue.enqueue(doc.uri.fsPath, remote, POSIX.basename(remote));
        return;
      }
      try {
        const sftp = await conn.getClient();
        await sftp.fastPut(doc.uri.fsPath, remote);
        vscode.window.showInformationMessage(`QuickSync: uploaded ${POSIX.basename(remote)} ✓`);
      } catch {
        vscode.window.showErrorMessage(`QuickSync: failed to upload ${remote}.`);
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
      await sftp.rename(item.remotePath, POSIX.join(POSIX.dirname(item.remotePath), name));
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
      } catch {
        vscode.window.showErrorMessage(`QuickSync: could not delete ${t.entry.name}.`);
      }
    }
    provider.refresh();
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
