// Audit logging — append-only local record of sensitive operations.
//
// SECURITY: writes are ALLOWLIST-redacted — only known non-secret fields are
// ever persisted, so a caller cannot accidentally log a password, key or
// passphrase. Enabled in enterprise mode or via quicksync.auditLog. The log
// lives in the extension's globalStorage (local to the machine), never sent
// anywhere.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const SAFE_FIELDS = ['site', 'host', 'user', 'protocol', 'remotePath', 'localName', 'bytes', 'result', 'from', 'to', 'detail'];

class AuditLogger {
  constructor(context) {
    this.ctx = context;
    this.file = null;
  }
  enabled() {
    const c = vscode.workspace.getConfiguration('quicksync');
    return c.get('enterpriseMode', false) || c.get('auditLog', false);
  }
  _file() {
    if (this.file) return this.file;
    try {
      const dir = this.ctx.globalStorageUri.fsPath;
      fs.mkdirSync(dir, { recursive: true });
      this.file = path.join(dir, 'audit.log');
    } catch {
      this.file = null;
    }
    return this.file;
  }
  log(action, details) {
    if (!this.enabled()) return;
    const f = this._file();
    if (!f) return;
    const safe = {};
    for (const k of SAFE_FIELDS) {
      if (details && details[k] != null) safe[k] = String(details[k]).slice(0, 512);
    }
    let ts;
    try {
      ts = new Date().toISOString();
    } catch {
      ts = '';
    }
    try {
      fs.appendFileSync(f, JSON.stringify({ ts, action, ...safe }) + '\n');
    } catch {
      /* logging must never break the operation */
    }
  }
  async open() {
    const f = this._file();
    if (!f || !fs.existsSync(f)) {
      vscode.window.showInformationMessage('QuickSync: no audit log yet (enable enterprise mode or quicksync.auditLog).');
      return;
    }
    const doc = await vscode.workspace.openTextDocument(f);
    vscode.window.showTextDocument(doc);
  }
}

module.exports = { AuditLogger };
