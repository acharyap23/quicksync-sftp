// Phase 8 — Optional FileZilla-style dual-pane explorer (webview).
//
// SECURITY POSTURE:
//  - Strict CSP: default-src 'none'; scripts only via a per-load nonce; styles
//    only from the extension's media dir. No inline script, no eval.
//  - localResourceRoots is limited to media/ — the webview can load nothing else.
//  - The webview performs NO I/O. It posts intents; this host validates every
//    path (local must stay inside the workspace, remote inside cfg.remotePath)
//    and runs the operation through the shared connection + transfer queue.
//  - Remote filenames are treated as data on both sides (textContent in the UI).

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const POSIX = path.posix;

function nonce() {
  return crypto.randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}

function localInside(root, p) {
  const rel = path.relative(root, p);
  return p === root || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function remoteInside(base, p) {
  const b = base.replace(/\/+$/, '');
  return p === b || p === b + '/' || p.startsWith(b + '/');
}
function remoteBase(cfg) {
  return cfg.remotePath.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
}

// Recursively collect files under `dir` (within the workspace), skipping symlinks.
function walkLocalFiles(dir, root, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (!localInside(root, full)) continue;
    if (e.isDirectory()) walkLocalFiles(full, root, out);
    else if (e.isFile()) out.push(full);
  }
}

function getHtml(webview, mediaUri, n) {
  const css = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'dualpane.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'dualpane.js'));
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource}`,
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${n}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${css}" rel="stylesheet" />
  <title>QuickSync Explorer</title>
</head>
<body>
  <div class="toolbar"><strong>QuickSync</strong><span>— local ↔ remote</span></div>
  <div class="panes">
    <section class="pane" id="localPane">
      <h2>Local site</h2>
      <div class="pathbar" id="localPath"></div>
      <input class="filter" id="localFilter" placeholder="Filter…" />
      <div class="tbwrap">
        <table class="flist">
          <thead><tr><th>Filename</th><th class="col-size">Size</th><th class="col-mtime">Last modified</th><th class="col-type">Type</th></tr></thead>
          <tbody id="localList"></tbody>
        </table>
      </div>
      <div class="actions">
        <button id="uploadBtn">Upload →</button>
        <button class="secondary" id="localRefresh">Refresh</button>
      </div>
    </section>
    <section class="pane" id="remotePane">
      <h2>Remote site</h2>
      <div class="pathbar" id="remotePath"></div>
      <input class="filter" id="remoteFilter" placeholder="Filter…" />
      <div class="tbwrap">
        <table class="flist">
          <thead><tr><th>Filename</th><th class="col-size">Size</th><th class="col-mtime">Last modified</th><th class="col-perm">Perms</th><th class="col-owner">Owner</th></tr></thead>
          <tbody id="remoteList"></tbody>
        </table>
      </div>
      <div class="actions">
        <button id="downloadBtn">← Download</button>
        <button class="secondary" id="remoteRefresh">Refresh</button>
      </div>
    </section>
  </div>
  <div class="log" id="log"></div>
  <script nonce="${n}" src="${js}"></script>
</body>
</html>`;
}

function registerDualPane(context, deps) {
  let panel = null;

  function reveal() {
    if (panel) {
      panel.reveal();
      return panel;
    }
    const mediaUri = vscode.Uri.joinPath(context.extensionUri, 'media');
    panel = vscode.window.createWebviewPanel('quicksyncDualPane', 'QuickSync Explorer', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [mediaUri], // nothing outside media/ is loadable
    });
    const n = nonce();
    panel.webview.html = getHtml(panel.webview, mediaUri, n);
    panel.onDidDispose(() => {
      panel = null;
    }, null, context.subscriptions);
    panel.webview.onDidReceiveMessage((m) => handleMessage(m).catch(() => {}), null, context.subscriptions);
    return panel;
  }

  const post = (msg) => panel && panel.webview.postMessage(msg);
  const logToView = (text) => post({ type: 'log', text });

  async function sendLocal(dir) {
    const root = deps.getWorkspaceRoot();
    if (!root) return logToView('No workspace folder open.');
    let target;
    if (dir) {
      target = path.resolve(dir);
    } else {
      // Default to the active site's local dir if it's inside the workspace.
      target = root;
      try {
        const cfg = await deps.loadConfig();
        if (cfg && cfg.localDir) {
          const p = path.resolve(cfg.localDir);
          if (localInside(root, p)) target = p;
        }
      } catch {
        /* fall back to root */
      }
    }
    if (!localInside(root, target)) target = root; // clamp to workspace
    try {
      const entries = fs.readdirSync(target, { withFileTypes: true })
        .filter((e) => e.isFile() || e.isDirectory()) // skip symlinks/specials
        .map((e) => {
          const full = path.join(target, e.name);
          let size = 0;
          let mtime = 0;
          try {
            const st = fs.statSync(full);
            size = st.size;
            mtime = st.mtimeMs;
          } catch {
            /* ignore */
          }
          return { name: e.name, type: e.isDirectory() ? 'd' : '-', path: full, size, mtime };
        })
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'd' ? -1 : 1));
      post({ type: 'local', path: target, entries });
    } catch {
      logToView('Cannot read local folder: ' + target);
    }
  }

  async function sendRemote(dir) {
    // Never auto-(re)connect from passive rendering. If disconnected, clear the
    // remote pane instead of opening a connection.
    if (!deps.getConnection().isConnected()) {
      post({ type: 'remoteCleared' });
      return;
    }
    const cfg = await deps.loadConfig();
    if (!cfg) return logToView('No QuickSync config found.');
    const base = remoteBase(cfg);
    let target = typeof dir === 'string' && dir ? dir.replace(/\\/g, '/') : base;
    if (!remoteInside(base, target)) target = base; // clamp to remotePath
    try {
      const conn = deps.getConnection();
      const sftp = await conn.getClient();
      const list = await sftp.list(target);
      const entries = list
        .filter((e) => e.type === 'd' || e.type === '-')
        .map((e) => {
          const r = e.rights || {};
          const perms = `${r.user || ''}${r.group || ''}${r.other || ''}`;
          const owner = e.owner != null || e.group != null ? `${e.owner || ''} ${e.group || ''}`.trim() : '';
          return { name: e.name, type: e.type, path: POSIX.join(target, e.name), size: e.size, mtime: e.modifyTime, perms, owner };
        })
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'd' ? -1 : 1));
      post({ type: 'remote', path: target, entries });
    } catch (err) {
      logToView('Cannot list remote folder: ' + target);
    }
  }

  async function handleMessage(m) {
    if (!m || typeof m.type !== 'string') return;
    if (!vscode.workspace.isTrusted) return logToView('Disabled in untrusted workspaces.');
    switch (m.type) {
      case 'init':
        await sendLocal();
        await sendRemote();
        return;
      case 'listLocal':
        return sendLocal(typeof m.path === 'string' ? m.path : undefined);
      case 'listRemote':
        return sendRemote(typeof m.path === 'string' ? m.path : undefined);
      case 'upload':
        return doUpload(m);
      case 'download':
        return doDownload(m);
      default:
        return; // ignore unknown message types
    }
  }

  async function doUpload(m) {
    const cfg = await deps.loadConfig();
    if (!cfg) return logToView('No config.');
    const root = deps.getWorkspaceRoot();
    const queue = deps.getQueue();
    if (!root || !queue) return;
    const base = remoteBase(cfg);
    const remoteDir = typeof m.remoteDir === 'string' ? m.remoteDir.replace(/\\/g, '/') : base;
    if (!remoteInside(base, remoteDir)) return logToView('Refused: remote target outside the deployment root.');

    const paths = Array.isArray(m.localPaths) ? m.localPaths : [];
    const conn = deps.getConnection();
    let sftp;
    try {
      sftp = await conn.getClient();
    } catch {
      return logToView('Not connected.');
    }
    // Expand selected directories into their files (recursive), preserving the
    // folder structure under remoteDir; selected files map to remoteDir/name.
    const candidates = [];
    let skipped = 0;
    for (const lp of paths) {
      if (typeof lp !== 'string') continue;
      const full = path.resolve(lp);
      if (!localInside(root, full)) {
        skipped++;
        continue;
      }
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isFile()) {
        candidates.push({ full, remote: POSIX.join(remoteDir, path.basename(full)), name: path.basename(full) });
      } else if (st.isDirectory()) {
        const parent = path.dirname(full);
        const files = [];
        walkLocalFiles(full, root, files);
        for (const f of files) {
          const rel = path.relative(parent, f).split(path.sep).join('/');
          candidates.push({ full: f, remote: POSIX.join(remoteDir, rel), name: path.basename(f) });
        }
      }
    }
    // Deny-list (never upload secrets) + warn-level safety, per file.
    const toEnqueue = [];
    for (const c of candidates) {
      if (deps.shouldIgnore(c.name, cfg.ignore)) {
        skipped++;
        continue;
      }
      const flagged = deps.classify([{ rel: c.name, full: c.full }]);
      if (flagged.length) {
        const ok = await vscode.window.showWarningMessage(
          `Upload potentially sensitive file "${c.name}" (${flagged[0].reason})?`,
          { modal: true },
          'Upload'
        );
        if (ok !== 'Upload') {
          skipped++;
          continue;
        }
      }
      toEnqueue.push(c);
    }
    if (toEnqueue.length === 0) return logToView('Nothing to upload.');

    // Path choice: the "matching path" mirrors the local structure under the
    // remote ROOT; the "current folder" is the remote dir you're viewing. If
    // they differ, ask (default = matching path).
    const matchOf = (full) => POSIX.join(base, path.relative(root, full).split(path.sep).join('/'));
    let mode = 'matching';
    const c0 = toEnqueue[0];
    if (matchOf(c0.full) !== c0.remote) {
      const pick = await vscode.window.showInformationMessage(
        `Upload location differs.\n\nMatching path:  ${POSIX.dirname(matchOf(c0.full))}\nCurrent folder: ${POSIX.dirname(c0.remote)}\n\nUpload to which?`,
        { modal: true },
        'Matching path',
        'Current folder'
      );
      mode = pick === 'Current folder' ? 'current' : 'matching'; // default matching (incl. dismiss)
    }
    const mapped = toEnqueue.map((t) => ({ full: t.full, name: t.name, remote: mode === 'matching' ? matchOf(t.full) : t.remote }));

    // Overwrite confirmation — how many targets already exist on the server?
    let overwrites = 0;
    for (const t of mapped) {
      try {
        if (await sftp.exists(t.remote)) overwrites++;
      } catch {
        /* treat as not-existing */
      }
    }
    if (overwrites > 0) {
      const ok = await vscode.window.showWarningMessage(
        `${overwrites} of ${mapped.length} file(s) already exist on the server and will be overwritten. Continue?`,
        { modal: true },
        'Overwrite'
      );
      if (ok !== 'Overwrite') {
        logToView('Upload cancelled.');
        return;
      }
    }
    // Ensure remote subdirectories exist (folder uploads create nested paths).
    const dirs = [...new Set(mapped.map((t) => POSIX.dirname(t.remote)))];
    for (const d of dirs) {
      try {
        if (!(await sftp.exists(d))) await sftp.mkdir(d, true);
      } catch {
        /* best effort — upload will surface a per-file failure */
      }
    }
    let queued = 0;
    for (const t of mapped) {
      queue.enqueue(t.full, t.remote, t.name);
      queued++;
    }
    logToView(`Queued ${queued} upload(s)${skipped ? `, skipped ${skipped}` : ''} (${mode} path). See QuickSync ▸ Transfers.`);
    sendRemote(remoteDir);
  }

  async function doDownload(m) {
    const cfg = await deps.loadConfig();
    if (!cfg) return logToView('No config.');
    const root = deps.getWorkspaceRoot();
    const base = remoteBase(cfg);
    const localDir = typeof m.localDir === 'string' ? path.resolve(m.localDir) : root;
    if (!root || !localInside(root, localDir)) return logToView('Refused: local target outside the workspace.');
    const paths = Array.isArray(m.remotePaths) ? m.remotePaths : [];
    const conn = deps.getConnection();
    let sftp;
    try {
      sftp = await conn.getClient();
    } catch {
      return logToView('Not connected.');
    }
    const valid = [];
    for (const rp of paths) {
      if (typeof rp !== 'string') continue;
      const norm = rp.replace(/\\/g, '/');
      if (!remoteInside(base, norm)) {
        logToView('Refused: ' + norm + ' is outside the deployment root.');
        continue;
      }
      const dest = path.join(localDir, POSIX.basename(norm));
      if (!localInside(root, dest)) continue;
      let isDir = false;
      try {
        const stt = await sftp.stat(norm);
        isDir = !!stt.isDirectory;
      } catch {
        /* treat as file */
      }
      valid.push({ norm, dest, isDir });
    }
    if (valid.length === 0) return logToView('Nothing to download.');

    // Path choice: the "matching path" mirrors the remote structure under the
    // local workspace ROOT; the "current folder" is the local dir you're
    // viewing. If they differ, ask (default = matching path).
    const matchOf = (norm) => path.join(root, norm.slice(base.length).replace(/^\/+/, '').split('/').join(path.sep));
    let mode = 'matching';
    const v0 = valid[0];
    if (matchOf(v0.norm) !== v0.dest) {
      const pick = await vscode.window.showInformationMessage(
        `Download location differs.\n\nMatching path:  ${path.dirname(matchOf(v0.norm))}\nCurrent folder: ${path.dirname(v0.dest)}\n\nDownload to which?`,
        { modal: true },
        'Matching path',
        'Current folder'
      );
      mode = pick === 'Current folder' ? 'current' : 'matching';
    }
    for (const v of valid) v.target = mode === 'matching' ? matchOf(v.norm) : v.dest;

    // Overwrite confirmation — how many local targets already exist?
    const overwrites = valid.filter((v) => fs.existsSync(v.target)).length;
    if (overwrites > 0) {
      const ok = await vscode.window.showWarningMessage(
        `${overwrites} of ${valid.length} item(s) already exist locally and will be overwritten. Continue?`,
        { modal: true },
        'Overwrite'
      );
      if (ok !== 'Overwrite') {
        logToView('Download cancelled.');
        return;
      }
    }
    let done = 0;
    for (const v of valid) {
      try {
        fs.mkdirSync(path.dirname(v.target), { recursive: true });
        if (v.isDir) await sftp.downloadDir(v.norm, v.target);
        else await sftp.fastGet(v.norm, v.target);
        done++;
        logToView('Downloaded ' + POSIX.basename(v.norm));
      } catch {
        logToView('Download failed: ' + POSIX.basename(v.norm));
      }
    }
    if (done) sendLocal(localDir);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('quicksync.openDualPane', () => {
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage('QuickSync is disabled in untrusted workspaces.');
        return;
      }
      reveal();
    })
  );

  // Called when the connection state changes: clear the remote pane on
  // disconnect, re-list the root on (re)connect — only if the panel is open.
  return {
    onConnectionChange() {
      if (!panel) return;
      if (deps.getConnection().isConnected()) sendRemote();
      else post({ type: 'remoteCleared' });
    },
  };
}

module.exports = { registerDualPane };
