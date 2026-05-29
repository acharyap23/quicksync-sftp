// Site Manager — multi-site profiles (FileZilla-style).
//
// Stores only NON-SECRET metadata in globalState; passwords/passphrases go to
// VS Code SecretStorage keyed per site (quicksync:site:<id>:password). One
// "active" site drives the shared connection; the existing connection manager,
// queue, explorer, compare and auto-sync all operate against it.

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const { openSiteEditor } = require('./siteEditor');
const sshConfig = require('./sshConfig');

const STORE_KEY = 'quicksync.sites.v1';
const ACTIVE_KEY = 'quicksync.activeSite';

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function siteSecretKey(id, name) {
  return `quicksync:site:${id}:${name}`;
}

// ---------- Store ----------

class SiteStore {
  constructor(context) {
    this.ctx = context;
  }
  list() {
    return this.ctx.globalState.get(STORE_KEY) || [];
  }
  get(id) {
    return this.list().find((s) => s.id === id) || null;
  }
  async _persist(sites) {
    await this.ctx.globalState.update(STORE_KEY, sites);
  }
  async save(site) {
    const sites = this.list();
    const i = sites.findIndex((s) => s.id === site.id);
    if (i >= 0) sites[i] = site;
    else sites.push(site);
    await this._persist(sites);
    return site;
  }
  async remove(id) {
    await this._persist(this.list().filter((s) => s.id !== id));
    // SecretStorage has no enumerate; delete known secret names.
    await this.ctx.secrets.delete(siteSecretKey(id, 'password'));
    await this.ctx.secrets.delete(siteSecretKey(id, 'passphrase'));
    await this.ctx.secrets.delete(siteSecretKey(id, 'notes'));
    if (this.getActiveId() === id) await this.setActive(null);
  }
  async duplicate(id) {
    const src = this.get(id);
    if (!src) return null;
    const copy = { ...src, id: newId(), siteName: `${src.siteName} (copy)` };
    await this.save(copy);
    return copy; // secrets are NOT copied — user re-enters for the new site
  }
  getActiveId() {
    return this.ctx.globalState.get(ACTIVE_KEY) || null;
  }
  getActive() {
    const id = this.getActiveId();
    return id ? this.get(id) : null;
  }
  async setActive(id) {
    await this.ctx.globalState.update(ACTIVE_KEY, id || undefined);
  }
}

// Convert a stored site into a connectSftp-compatible config.
// `_siteId` routes secret lookups to the per-site SecretStorage keys.
function siteToConfig(site) {
  if (!site) return null;
  let keyPath = site.privateKeyPath;
  if (keyPath && keyPath.startsWith('~')) keyPath = path.join(os.homedir(), keyPath.slice(1));
  return {
    _siteId: site.id,
    siteName: site.siteName,
    host: site.host,
    port: site.port || 22,
    username: site.username,
    privateKeyPath: keyPath ? path.resolve(keyPath) : undefined,
    remotePath: site.remotePath,
    hostFingerprint: site.hostFingerprint,
    protocol: site.protocol || 'sftp',
    maxConnections: site.maxConnections || 0,
    localDir: site.localDir || undefined,
  };
}

// ---------- Tree ----------

class SiteItem extends vscode.TreeItem {
  constructor(site, isActive, isConnected, durationText) {
    super(site.siteName || site.host, vscode.TreeItemCollapsibleState.None);
    this.site = site;
    this.contextValue = isActive ? 'quicksyncSiteActive' : 'quicksyncSite';
    this.description = `${site.username}@${site.host}:${site.port || 22}` + (isConnected ? `  ● ${durationText}` : '');
    this.tooltip = `${site.protocol || 'sftp'}://${site.username}@${site.host}:${site.port || 22}\n${site.remotePath || ''}`;
    this.iconPath = new vscode.ThemeIcon(isConnected ? 'vm-active' : isActive ? 'vm' : 'server-environment');
  }
}
class FolderItem extends vscode.TreeItem {
  constructor(name) {
    super(name, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'quicksyncSiteFolder';
    this.iconPath = vscode.ThemeIcon.Folder;
  }
}

class SitesTreeProvider {
  constructor(mgr) {
    this.mgr = mgr;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }
  refresh() {
    this._onDidChangeTreeData.fire();
  }
  getTreeItem(el) {
    return el;
  }
  _siteItem(s) {
    const activeId = this.mgr.store.getActiveId();
    const connected = this.mgr.connectedSiteId === s.id;
    return new SiteItem(s, s.id === activeId, connected, this.mgr.durationText());
  }
  getChildren(element) {
    const sites = this.mgr.store.list();
    if (element && element.contextValue === 'quicksyncSiteFolder') {
      return sites.filter((s) => (s.folder || '') === element.label).map((s) => this._siteItem(s));
    }
    if (element) return [];
    const top = [];
    // Surface the workspace .vscode/quicksync.json (if present) as a connectable entry.
    const wc = this.mgr.getWorkspaceConfig();
    if (wc) top.push(this._workspaceItem(wc));
    const folders = [...new Set(sites.map((s) => s.folder).filter(Boolean))].sort();
    for (const f of folders) top.push(new FolderItem(f));
    for (const s of sites.filter((s) => !s.folder)) top.push(this._siteItem(s));
    if (top.length === 0) {
      const hint = new vscode.TreeItem('No sites — click + to add one', vscode.TreeItemCollapsibleState.None);
      hint.command = { command: 'quicksync.sites.new', title: 'New Site' };
      hint.iconPath = new vscode.ThemeIcon('add');
      return [hint];
    }
    return top;
  }
  _workspaceItem(wc) {
    const connected = this.mgr.connectedSiteId === 'workspace';
    const it = new vscode.TreeItem('Workspace config', vscode.TreeItemCollapsibleState.None);
    it.contextValue = 'quicksyncWorkspaceSite';
    it.description = `${wc.username ? wc.username + '@' : ''}${wc.host}  ${wc.remotePath || ''}` + (connected ? `  ● ${this.mgr.durationText()}` : '');
    it.tooltip = '.vscode/quicksync.json';
    it.iconPath = new vscode.ThemeIcon(connected ? 'vm-active' : 'file-code');
    it.command = { command: 'quicksync.sites.connectWorkspace', title: 'Connect' };
    return it;
  }
}

// ---------- Manager / registration ----------

function registerSiteManager(context, deps) {
  // deps: { connection, connectSftp, onActiveChanged, audit }
  const store = new SiteStore(context);
  const audit = (deps && deps.audit) || { log() {} };
  const mgr = {
    store,
    ephemeral: null, // quick-connect config that isn't persisted
    connectedSiteId: null,
    connectedAt: 0,
    durationText() {
      if (!this.connectedAt) return '';
      const s = Math.floor((Date.now() - this.connectedAt) / 1000);
      if (s < 60) return `${s}s`;
      const m = Math.floor(s / 60);
      return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`;
    },
    getActiveConfig() {
      return this.ephemeral || siteToConfig(store.getActive());
    },
    getWorkspaceConfig() {
      return deps.getWorkspaceConfig ? deps.getWorkspaceConfig() : null;
    },
  };

  const provider = new SitesTreeProvider(mgr);
  const view = vscode.window.createTreeView('quicksyncSites', { treeDataProvider: provider });
  context.subscriptions.push(view);
  // Refresh duration display periodically while connected.
  const ticker = setInterval(() => {
    if (mgr.connectedSiteId) provider.refresh();
  }, 10000);
  context.subscriptions.push({ dispose: () => clearInterval(ticker) });

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  function openEditor(existing) {
    openSiteEditor(context, store, existing, {
      siteSecretKey,
      onSaved: (site, doConnect) => {
        provider.refresh();
        vscode.window.showInformationMessage(`QuickSync: saved site "${site.siteName}".`);
        if (doConnect) connectSite(site);
      },
    });
  }

  reg('quicksync.sites.refresh', () => provider.refresh());
  reg('quicksync.sites.new', () => openEditor(null));
  reg('quicksync.sites.edit', (item) => item && item.site && openEditor(item.site));

  // Connect using the workspace .vscode/quicksync.json (clears the active site
  // so resolveConfig falls back to that file).
  reg('quicksync.sites.connectWorkspace', async () => {
    if (!vscode.workspace.isTrusted) {
      vscode.window.showWarningMessage('QuickSync is disabled in untrusted workspaces.');
      return;
    }
    await deps.connection.disconnect();
    mgr.ephemeral = null;
    await store.setActive(null);
    if (deps.onActiveChanged) deps.onActiveChanged();
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'QuickSync: connecting to workspace config…' },
      async () => {
        try {
          await deps.connection.getClient();
          mgr.connectedSiteId = 'workspace';
          mgr.connectedAt = Date.now();
          provider.refresh();
          vscode.commands.executeCommand('quicksync.remote.refresh');
          const c = deps.connection.cfg || {};
          audit.log('connect', { site: 'workspace-config', host: c.host, user: c.username, protocol: 'sftp', result: 'ok' });
          vscode.window.showInformationMessage(`QuickSync: connected to workspace config (${c.username || ''}@${c.host || ''}) ✓`);
        } catch (err) {
          mgr.connectedSiteId = null;
          provider.refresh();
          audit.log('connect', { site: 'workspace-config', result: 'failed' });
          vscode.window.showErrorMessage(`QuickSync: connection failed — ${err.message}`);
        }
      }
    );
  });

  // Import a host from ~/.ssh/config and pre-fill the editor.
  reg('quicksync.sites.fromSshConfig', async () => {
    const hosts = sshConfig.parse();
    if (hosts.length === 0) {
      vscode.window.showInformationMessage(`QuickSync: no usable Host entries found in ${sshConfig.configPath()}.`);
      return;
    }
    const pick = await vscode.window.showQuickPick(
      hosts.map((h) => ({
        label: h.host,
        description: `${h.user ? h.user + '@' : ''}${h.hostName || h.host}${h.port ? ':' + h.port : ''}`,
        h,
      })),
      { placeHolder: 'Import which SSH host? (you can edit before saving)' }
    );
    if (!pick) return;
    const h = pick.h;
    // Pre-fill a NEW site (no id) — user confirms the remote root, then Save/Connect.
    openEditor({
      siteName: h.host,
      host: h.hostName || h.host,
      port: parseInt(h.port, 10) || 22,
      username: h.user || '',
      privateKeyPath: h.identityFile || '~/.ssh/id_rsa',
      remotePath: '/',
      folder: '',
    });
  });

  reg('quicksync.sites.duplicate', async (item) => {
    if (!item || !item.site) return;
    await store.duplicate(item.site.id);
    provider.refresh();
    vscode.window.showInformationMessage('QuickSync: site duplicated (re-enter its credentials).');
  });

  reg('quicksync.sites.delete', async (item) => {
    if (!item || !item.site) return;
    const ok = await vscode.window.showWarningMessage(`Delete site "${item.site.siteName}" and its saved credentials?`, { modal: true }, 'Delete');
    if (ok !== 'Delete') return;
    await store.remove(item.site.id);
    provider.refresh();
  });

  async function connectSite(site) {
    if (!vscode.workspace.isTrusted) {
      vscode.window.showWarningMessage('QuickSync is disabled in untrusted workspaces.');
      return;
    }
    if ((site.protocol || 'sftp') !== 'sftp') {
      vscode.window.showWarningMessage(`QuickSync can only connect via SFTP right now (site "${site.siteName}" is ${site.protocol.toUpperCase()}).`);
      return;
    }
    await deps.connection.disconnect(); // drop any prior site's connection
    mgr.ephemeral = null;
    await store.setActive(site.id);
    if (deps.onActiveChanged) deps.onActiveChanged();
    try {
      await deps.connection.getClient(); // uses resolveConfig → active site
      mgr.connectedSiteId = site.id;
      mgr.connectedAt = Date.now();
      provider.refresh();
      vscode.commands.executeCommand('quicksync.remote.refresh');
      audit.log('connect', { site: site.siteName, host: site.host, user: site.username, protocol: site.protocol || 'sftp', result: 'ok' });
      vscode.window.showInformationMessage(`QuickSync: connected to ${site.siteName} (${site.username}@${site.host}:${site.port || 22}) ✓`);
    } catch (err) {
      mgr.connectedSiteId = null;
      provider.refresh();
      audit.log('connect', { site: site.siteName, host: site.host, user: site.username, result: 'failed' });
      vscode.window.showErrorMessage(`QuickSync: connection to ${site.siteName} failed — ${err.message}`);
    }
  }

  reg('quicksync.sites.connect', (item) => item && item.site && connectSite(item.site));

  reg('quicksync.sites.disconnect', async () => {
    await deps.connection.disconnect();
    mgr.connectedSiteId = null;
    mgr.connectedAt = 0;
    provider.refresh();
    vscode.commands.executeCommand('quicksync.remote.refresh');
    vscode.window.showInformationMessage('QuickSync: disconnected.');
  });

  reg('quicksync.sites.test', async (item) => {
    if (!item || !item.site) return;
    const site = item.site;
    if ((site.protocol || 'sftp') !== 'sftp') {
      vscode.window.showWarningMessage('Test supports SFTP only for now.');
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Testing ${site.siteName}…` },
      async () => {
        const cfg = siteToConfig(site);
        let sftp;
        try {
          sftp = await deps.connectSftp(cfg); // full host-key verification applies
        } catch (err) {
          vscode.window.showErrorMessage(`Test failed — connect/auth: ${err.message}`);
          return;
        }
        try {
          await sftp.list(cfg.remotePath);
          vscode.window.showInformationMessage(`✓ ${site.siteName}: connected, authenticated, and "${cfg.remotePath}" is listable.`);
        } catch (err) {
          vscode.window.showWarningMessage(`Connected & authenticated, but cannot list "${cfg.remotePath}": ${err.message}`);
        } finally {
          try {
            await sftp.end();
          } catch {
            /* ignore */
          }
        }
      }
    );
  });

  // Quick Connect — connect without saving a site; optionally save afterward.
  reg('quicksync.sites.quickConnect', async () => {
    if (!vscode.workspace.isTrusted) {
      vscode.window.showWarningMessage('QuickSync is disabled in untrusted workspaces.');
      return;
    }
    const host = await vscode.window.showInputBox({ prompt: 'Host', ignoreFocusOut: true });
    if (!host) return;
    const portStr = await vscode.window.showInputBox({ prompt: 'Port', value: '22', ignoreFocusOut: true });
    if (portStr === undefined) return;
    const username = await vscode.window.showInputBox({ prompt: 'Username', ignoreFocusOut: true });
    if (!username) return;
    const remotePath = await vscode.window.showInputBox({
      prompt: 'Remote root directory',
      value: '/',
      ignoreFocusOut: true,
      validateInput: (v) => (v && v.startsWith('/') && !v.split('/').includes('..') ? null : 'Absolute path, no ".."'),
    });
    if (!remotePath) return;
    const password = await vscode.window.showInputBox({ prompt: `Password for ${username}@${host}`, password: true, ignoreFocusOut: true });
    if (password === undefined) return;
    await context.secrets.store(siteSecretKey('quickconnect', 'password'), password);

    await deps.connection.disconnect();
    await store.setActive(null);
    mgr.ephemeral = { _siteId: 'quickconnect', siteName: host, host, port: parseInt(portStr, 10) || 22, username, remotePath, protocol: 'sftp' };
    if (deps.onActiveChanged) deps.onActiveChanged();
    try {
      await deps.connection.getClient();
      mgr.connectedSiteId = 'quickconnect';
      mgr.connectedAt = Date.now();
      provider.refresh();
      vscode.commands.executeCommand('quicksync.remote.refresh');
      audit.log('connect', { site: 'quick-connect', host, user: username, protocol: 'sftp', result: 'ok' });
      const save = await vscode.window.showInformationMessage(`Connected to ${host}. Save as a site?`, 'Save Site');
      if (save === 'Save Site') {
        const site = { id: newId(), siteName: host, folder: '', host, port: parseInt(portStr, 10) || 22, protocol: 'sftp', username, remotePath };
        await store.save(site);
        const pw = await context.secrets.get(siteSecretKey('quickconnect', 'password'));
        if (pw) await context.secrets.store(siteSecretKey(site.id, 'password'), pw);
        mgr.ephemeral = null;
        mgr.connectedSiteId = site.id;
        await store.setActive(site.id);
        provider.refresh();
      }
    } catch (err) {
      mgr.ephemeral = null;
      mgr.connectedSiteId = null;
      provider.refresh();
      vscode.window.showErrorMessage(`QuickSync: quick connect failed (${err.message}).`);
    }
  });

  // Auto-connect last active site on startup (opt-in).
  if (vscode.workspace.getConfiguration('quicksync').get('autoConnectLastSite', false)) {
    const active = store.getActive();
    if (active && (active.protocol || 'sftp') === 'sftp' && vscode.workspace.isTrusted) {
      connectSite(active);
    }
  }

  return mgr;
}

module.exports = { registerSiteManager, siteToConfig, SiteStore, siteSecretKey };
