// Phase 4 — Compare local vs remote before overwrite.
//
// Fetches the remote file, compares size / modified-time / SHA-256, and (on
// difference) offers Upload Local / View Diff / Keep Remote using VS Code's
// native diff viewer. Used both as a standalone "Compare with Remote" command
// and as an optional pre-flight inside the upload workflow.

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fmtSize(b) {
  if (b == null) return '?';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = b;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function fmtDate(ms) {
  if (!ms) return '?';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

// Returns comparison facts. If the remote file does not exist, { exists:false }.
async function gather(sftp, localPath, remotePath) {
  let rstat;
  try {
    rstat = await sftp.stat(remotePath);
  } catch {
    return { exists: false };
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quicksync-cmp-'));
  const remoteTmp = path.join(tmpDir, path.basename(remotePath));
  await sftp.fastGet(remotePath, remoteTmp);
  const lstat = fs.statSync(localPath);
  const localHash = sha256(localPath);
  const remoteHash = sha256(remoteTmp);
  return {
    exists: true,
    remoteTmp,
    localSize: lstat.size,
    remoteSize: rstat.size,
    localMtime: lstat.mtimeMs,
    remoteMtime: rstat.modifyTime || 0,
    localHash,
    remoteHash,
    identical: localHash === remoteHash,
  };
}

async function openDiff(localPath, remoteTmp, title) {
  // Left = remote (original), right = local (modified).
  await vscode.commands.executeCommand(
    'vscode.diff',
    vscode.Uri.file(remoteTmp),
    vscode.Uri.file(localPath),
    title || `${path.basename(localPath)} (Remote ↔ Local)`
  );
}

// Standalone compare: show the diff if files differ, info if identical/absent.
async function compareWithRemote(sftp, localPath, remotePath) {
  const c = await gather(sftp, localPath, remotePath);
  if (!c.exists) {
    vscode.window.showInformationMessage(`QuickSync: ${path.basename(localPath)} has no counterpart at ${remotePath}.`);
    return c;
  }
  if (c.identical) {
    vscode.window.showInformationMessage(`QuickSync: ${path.basename(localPath)} is identical on the server.`);
    return c;
  }
  await openDiff(localPath, c.remoteTmp);
  return c;
}

// Pre-flight used by the upload workflow. Returns 'upload' | 'skip'.
async function decideBeforeOverwrite(sftp, localPath, remotePath) {
  const c = await gather(sftp, localPath, remotePath);
  if (!c.exists) return 'upload'; // nothing to overwrite
  if (c.identical) {
    vscode.window.showInformationMessage(`QuickSync: ${path.basename(localPath)} is already up to date on the server.`);
    return 'skip';
  }
  const summary =
    `Remote file differs from local:\n\n` +
    `LOCAL   ${fmtSize(c.localSize)}   ${fmtDate(c.localMtime)}\n` +
    `REMOTE  ${fmtSize(c.remoteSize)}   ${fmtDate(c.remoteMtime)}\n\n` +
    `SHA-256 local : ${c.localHash.slice(0, 16)}…\n` +
    `SHA-256 remote: ${c.remoteHash.slice(0, 16)}…`;
  const pick = await vscode.window.showWarningMessage(summary, { modal: true }, 'Upload Local', 'View Diff', 'Keep Remote');
  if (pick === 'View Diff') {
    await openDiff(localPath, c.remoteTmp);
    const p2 = await vscode.window.showWarningMessage('Upload local over remote?', { modal: true }, 'Upload Local', 'Keep Remote');
    return p2 === 'Upload Local' ? 'upload' : 'skip';
  }
  return pick === 'Upload Local' ? 'upload' : 'skip';
}

module.exports = { gather, openDiff, compareWithRemote, decideBeforeOverwrite };
