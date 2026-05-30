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
      <h2>Local Files</h2>
      <div class="pathbar" id="localPath"></div>
      <input class="filter" id="localFilter" placeholder="Filter…" />
      <ul class="list" id="localList"></ul>
      <div class="actions">
        <button id="uploadBtn">Upload →</button>
        <button class="secondary" id="localRefresh">Refresh</button>
      </div>
    </section>
    <section class="pane" id="remotePane">
      <h2>Remote Files</h2>
      <div class="pathbar" id="remotePath"></div>
      <input class="filter" id="remoteFilter" placeholder="Filter…" />
      <ul class="list" id="remoteList"></ul>
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
        .map((e) => ({ name: e.name, type: e.isDirectory() ? 'd' : '-', path: path.join(target, e.name) }))
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'd' ? -1 : 1));
      post({ type: 'local', path: target, entries });
    } catch {
      logToView('Cannot read local folder: ' + target);
    }
  }

  async function sendRemote(dir) {
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
        .map((e) => ({ name: e.name, type: e.type, path: POSIX.join(target, e.name) }))
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
    const toEnqueue = [];
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
      if (!st.isFile()) continue;
      const name = path.basename(full);
      // Hard deny-list (name-based) — never upload secrets.
      if (deps.shouldIgnore(name, cfg.ignore)) {
        skipped++;
        logToView(`Skipped ${name} (ignored / sensitive).`);
        continue;
      }
      // Warn-level safety classification.
      const flagged = deps.classify([{ rel: name, full }]);
      if (flagged.length) {
        const ok = await vscode.window.showWarningMessage(
          `Upload potentially sensitive file "${name}" (${flagged[0].reason})?`,
          { modal: true },
          'Upload'
        );
        if (ok !== 'Upload') {
          skipped++;
          continue;
        }
      }
      toEnqueue.push({ full, remote: POSIX.join(remoteDir, name), name });
    }
    // Overwrite confirmation — how many targets already exist on the server?
    let overwrites = 0;
    for (const t of toEnqueue) {
      try {
        if (await sftp.exists(t.remote)) overwrites++;
      } catch {
        /* treat as not-existing */
      }
    }
    if (overwrites > 0) {
      const ok = await vscode.window.showWarningMessage(
        `${overwrites} of ${toEnqueue.length} file(s) already exist on the server and will be overwritten. Continue?`,
        { modal: true },
        'Overwrite'
      );
      if (ok !== 'Overwrite') {
        logToView('Upload cancelled.');
        return;
      }
    }
    let queued = 0;
    for (const t of toEnqueue) {
      queue.enqueue(t.full, t.remote, t.name);
      queued++;
    }
    logToView(`Queued ${queued} upload(s)${skipped ? `, skipped ${skipped}` : ''}. See QuickSync ▸ Transfers.`);
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
      valid.push({ norm, dest });
    }
    // Overwrite confirmation — how many local targets already exist?
    const overwrites = valid.filter((v) => fs.existsSync(v.dest)).length;
    if (overwrites > 0) {
      const ok = await vscode.window.showWarningMessage(
        `${overwrites} of ${valid.length} file(s) already exist locally and will be overwritten. Continue?`,
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
        await sftp.fastGet(v.norm, v.dest);
        done++;
        logToView('Downloaded ' + POSIX.basename(v.norm));
      } catch {
        logToView('Download failed: ' + v.norm);
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
}

module.exports = { registerDualPane };
