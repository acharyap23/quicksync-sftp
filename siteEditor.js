// Site Editor — FileZilla-style form for creating/editing a site (webview).
//
// SECURITY: strict CSP (default-src none, nonce-only script, styles from
// media/ only), localResourceRoots limited to media/. The webview holds no
// secret at rest — when editing, the stored password is NOT sent to the
// webview; a blank field means "keep existing". The host validates all input
// and persists metadata to the SiteStore and secrets to SecretStorage.

const vscode = require('vscode');
const crypto = require('crypto');

function nonce() {
  return crypto.randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}

function getHtml(webview, mediaUri, n) {
  const css = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'siteEditor.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'siteEditor.js'));
  const csp = ["default-src 'none'", `style-src ${webview.cspSource}`, `script-src 'nonce-${n}'`].join('; ');
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link href="${css}" rel="stylesheet" />
<title>Site</title></head><body>
<h1 id="title">New Site</h1>
<div class="tabs">
  <button class="tab active" data-tab="general">General</button>
  <button class="tab" data-tab="advanced">Advanced</button>
  <button class="tab" data-tab="transfer">Transfer Settings</button>
  <button class="tab" data-tab="charset">Charset</button>
</div>

<div class="panel active" data-panel="general">
  <div class="row"><label for="siteName">Site Name</label><input id="siteName" /></div>
  <div class="row"><label for="protocol">Protocol</label>
    <select id="protocol">
      <option value="sftp">SFTP - SSH File Transfer Protocol</option>
      <option value="ftps">FTPS - FTP over TLS</option>
      <option value="scp">SCP - Secure Copy</option>
      <option value="ftp">FTP - File Transfer Protocol</option>
    </select>
  </div>
  <div class="row split"><label for="host">Host</label><input id="host" /><label for="port" style="text-align:right">Port</label><input id="port" placeholder="22" /></div>
  <div class="row hide" id="rowEncryption"><label for="encryption">Encryption</label>
    <select id="encryption">
      <option value="explicit">Use explicit FTP over TLS if available</option>
      <option value="require">Require explicit FTP over TLS</option>
      <option value="implicit">Require implicit FTP over TLS</option>
      <option value="plain">Only use plain FTP (insecure)</option>
    </select>
  </div>
  <div class="row"><label for="logonType">Logon Type</label>
    <select id="logonType">
      <option value="password">Normal (password)</option>
      <option value="key">Key file</option>
    </select>
  </div>
  <div class="row"><label for="user">User</label><input id="user" /></div>
  <div class="row" id="rowPassword"><label for="password">Password</label><input id="password" type="password" /></div>
  <div class="row"><label for="notes">Notes</label><textarea id="notes" rows="3" placeholder="Optional notes about this site"></textarea></div>
  <p class="warn" id="ftpWarn">⚠ FTP transmits credentials insecurely. SFTP is recommended.</p>
  <p class="warn" id="protoWarn">Note: QuickSync currently transports SFTP only — non-SFTP sites can be saved but not connected yet.</p>
</div>

<div class="panel" data-panel="advanced">
  <div class="row"><label for="serverType">Server type</label>
    <select id="serverType" disabled title="SFTP is auto-handled"><option>SFTP (fixed)</option></select>
  </div>
  <div class="row split"><label for="localDir">Default local directory</label><input id="localDir" placeholder="(within workspace)" /><span></span><button class="btn secondary" id="browseBtn" type="button">Browse…</button></div>
  <div class="row"><label for="remoteRoot">Default remote dir</label><input id="remoteRoot" placeholder="/home/deploy/public_html" /></div>
  <div class="hint">Remote path must be absolute, no ".." segments.</div>
  <div class="row hide" id="rowKeyPath"><label for="keyPath">Private Key Path</label><input id="keyPath" /></div>
  <div class="row hide" id="rowPassphrase"><label for="passphrase">Passphrase</label><input id="passphrase" type="password" /></div>
  <div class="row"><label for="fingerprint">Host Fingerprint</label><input id="fingerprint" placeholder="SHA256:… (optional, pins the host key)" /></div>
  <div class="row"><label for="folder">Folder / Group</label><input id="folder" placeholder="Production (optional)" /></div>
  <div class="row split"><label>Adjust server time, offset by</label><input id="offsetH" type="number" value="0" /><label style="text-align:right">Hrs</label><input id="offsetM" type="number" value="0" /></div>
  <div class="hint">Bypass proxy / synchronized browsing / directory comparison are not applicable to SFTP.</div>
</div>

<div class="panel" data-panel="transfer">
  <div class="row"><label>Transfer mode</label>
    <span><label><input type="radio" name="tmode" checked disabled /> Default</label>
    <label><input type="radio" name="tmode" disabled /> Active</label>
    <label><input type="radio" name="tmode" disabled /> Passive</label></span>
  </div>
  <div class="hint">Active/Passive apply to FTP only — SFTP uses a single SSH channel.</div>
  <div class="row"><label for="limitConns">Limit connections</label>
    <span><label><input type="checkbox" id="limitConns" /> Limit simultaneous connections</label></span>
  </div>
  <div class="row"><label for="maxConns">Max connections</label><input id="maxConns" type="number" min="1" max="8" value="1" disabled /></div>
  <div class="hint">Per-site override of the upload-queue concurrency (otherwise quicksync.concurrentTransfers).</div>
</div>

<div class="panel" data-panel="charset">
  <div class="row"><label>Filename charset</label>
    <span><label><input type="radio" name="cs" checked disabled /> UTF-8</label>
    &nbsp;&nbsp;<label><input type="radio" name="cs" disabled /> Custom</label></span>
  </div>
  <div class="row"><label for="encoding">Encoding</label><input id="encoding" disabled placeholder="UTF-8" /></div>
  <div class="hint">SFTP transfers filenames as UTF-8; custom encodings are not configurable.</div>
</div>

<div class="actions">
  <button class="btn" id="saveBtn">Save</button>
  <button class="btn" id="connectBtn">Connect</button>
  <button class="btn secondary" id="cancelBtn">Cancel</button>
</div>
<script nonce="${n}" src="${js}"></script>
</body></html>`;
}

function validate(s) {
  if (!s || typeof s !== 'object') return 'invalid form';
  if (!s.host || !String(s.host).trim()) return 'Host is required';
  if (!s.username || !String(s.username).trim()) return 'User is required';
  if (!s.remotePath || !String(s.remotePath).startsWith('/') || String(s.remotePath).split('/').includes('..'))
    return 'Remote Root must be an absolute path without ".." segments';
  if (s.port && (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535)) return 'Port must be 1–65535';
  return null;
}

// openSiteEditor(context, store, existing|null, { onSaved(site, connect), siteSecretKey })
function openSiteEditor(context, store, existing, hooks) {
  const mediaUri = vscode.Uri.joinPath(context.extensionUri, 'media');
  const panel = vscode.window.createWebviewPanel('quicksyncSiteEditor', existing ? 'Edit Site' : 'New Site', vscode.ViewColumn.Active, {
    enableScripts: true,
    localResourceRoots: [mediaUri],
  });
  const n = nonce();
  panel.webview.html = getHtml(panel.webview, mediaUri, n);

  panel.webview.onDidReceiveMessage(async (m) => {
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'ready') {
      let hasStoredSecret = false;
      if (existing) {
        const pw = await context.secrets.get(hooks.siteSecretKey(existing.id, 'password'));
        const pp = await context.secrets.get(hooks.siteSecretKey(existing.id, 'passphrase'));
        hasStoredSecret = !!(pw || pp);
      }
      panel.webview.postMessage({ type: 'load', site: existing || {}, hasStoredSecret });
      return;
    }
    if (m.type === 'cancel') {
      panel.dispose();
      return;
    }
    if (m.type === 'browseLocal') {
      const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Use folder' });
      if (picked && picked[0]) panel.webview.postMessage({ type: 'localDir', path: picked[0].fsPath });
      return;
    }
    if (m.type === 'save' || m.type === 'saveAndConnect') {
      const s = m.site || {};
      const problem = validate(s);
      if (problem) {
        vscode.window.showErrorMessage(`QuickSync: ${problem}`);
        return;
      }
      const id = s.id || (existing && existing.id) || Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const site = {
        id,
        siteName: s.siteName || s.host,
        folder: s.folder || '',
        host: s.host.trim(),
        port: s.port || 22,
        protocol: s.protocol || 'sftp',
        username: s.username.trim(),
        privateKeyPath: s.logonType === 'key' ? s.privateKeyPath || '' : '',
        remotePath: s.remotePath.trim(),
        localDir: (s.localDir || '').trim() || undefined,
        hostFingerprint: s.hostFingerprint || undefined,
        maxConnections: s.maxConnections > 0 ? s.maxConnections : 0,
        timeOffsetMinutes: s.timeOffsetMinutes || 0,
        notes: typeof s.notes === 'string' ? s.notes.slice(0, 2000) : '',
      };
      await store.save(site);
      // Secrets: only write when a non-blank value was entered (blank = keep existing).
      if (s.password) await context.secrets.store(hooks.siteSecretKey(id, 'password'), s.password);
      if (s.passphrase) await context.secrets.store(hooks.siteSecretKey(id, 'passphrase'), s.passphrase);
      panel.dispose();
      if (hooks.onSaved) hooks.onSaved(site, m.type === 'saveAndConnect');
    }
  }, null, context.subscriptions);

  return panel;
}

module.exports = { openSiteEditor };
