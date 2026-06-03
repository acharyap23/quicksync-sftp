// Phase 3 — Transfer queue.
//
// A background upload engine with a dedicated tree view. Items move through
// Queued → Uploading → Completed/Failed/Cancelled, with live byte progress,
// speed and ETA (via ssh2-sftp-client's fastPut `step` callback). Concurrency
// is configurable (1 = sequential, >1 = parallel). Uploads are atomic
// (temp-then-rename). Duplicate in-flight targets are de-duplicated to prevent
// redundant uploads. The queue is intentionally NOT persisted across restarts
// — resurrecting uploads after a reload would be surprising and unsafe.

const vscode = require('vscode');
const path = require('path');
const POSIX = path.posix;

const STATE = {
  QUEUED: 'Queued',
  UPLOADING: 'Uploading',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

const ACTIVE_STATES = [STATE.QUEUED, STATE.UPLOADING];

class TransferItem {
  constructor(id, localFull, remotePath, label) {
    this.id = id;
    this.localFull = localFull;
    this.remotePath = remotePath;
    this.label = label;
    this.state = STATE.QUEUED;
    this.transferred = 0;
    this.total = 0;
    this.startTime = 0;
    this.speed = 0; // bytes/sec
    this.error = null;
    this.cancelRequested = false;
  }
  get percent() {
    return this.total > 0 ? Math.min(100, Math.round((this.transferred / this.total) * 100)) : 0;
  }
  get etaSeconds() {
    if (this.speed <= 0 || this.total <= 0) return null;
    return Math.max(0, (this.total - this.transferred) / this.speed);
  }
}

// A small pool of independent, fully-verified SFTP connections so uploads can
// run in parallel. ssh2-sftp-client is NOT safe for concurrent ops on one
// client, so each worker gets its own connection. Connections are created via
// the same secure connectSftp path (host-key verification, pinned algorithms,
// SecretStorage) — parallelism does not weaken any security control.
class ClientPool {
  constructor(connectFn) {
    this.connectFn = connectFn;
    this.size = 1;
    this.clients = [];
    this.free = [];
    this.connecting = false;
  }
  async acquire() {
    for (;;) {
      if (this.free.length) return this.free.pop();
      if (this.clients.length < this.size && !this.connecting) {
        this.connecting = true;
        try {
          const c = await this.connectFn(); // full secure (host-verified) connection
          this.clients.push(c);
          return c;
        } finally {
          this.connecting = false;
        }
      }
      await new Promise((r) => setTimeout(r, 40)); // wait for a client to free up
    }
  }
  release(c) {
    if (c) this.free.push(c);
  }
  async evict(c) {
    this.clients = this.clients.filter((x) => x !== c);
    this.free = this.free.filter((x) => x !== c);
    try {
      await c.end();
    } catch {
      /* already gone */
    }
  }
  async closeAll() {
    const cs = this.clients;
    this.clients = [];
    this.free = [];
    for (const c of cs) {
      try {
        await c.end();
      } catch {
        /* already gone */
      }
    }
  }
}

class TransferQueue {
  constructor(conn, onChange, audit, pool) {
    this.conn = conn;
    this.items = [];
    this.active = 0;
    this.seq = 0;
    this.onChange = onChange || (() => {});
    this.audit = audit || { log() {} };
    this.pool = pool;
    this.onIdle = null; // (done, failed) → called when the queue drains
    this._idle = true;
    this._batchDone = 0;
    this._batchFail = 0;
  }

  get concurrency() {
    // A per-site "max simultaneous connections" overrides the global setting.
    const perSite = this.conn && this.conn.cfg && this.conn.cfg.maxConnections;
    const n = perSite > 0 ? perSite : vscode.workspace.getConfiguration('quicksync').get('concurrentTransfers', 1);
    return Math.min(8, Math.max(1, Number(n) || 1));
  }

  enqueue(localFull, remotePath, label, opts) {
    // Dedupe: skip if an active item already targets this remote path.
    const dup = this.items.find((i) => i.remotePath === remotePath && ACTIVE_STATES.includes(i.state));
    if (dup) return dup;
    const item = new TransferItem(++this.seq, localFull, remotePath, label);
    item.onComplete = opts && opts.onComplete;
    item.attempts = 0;
    this.items.push(item);
    this.onChange();
    this._pump();
    return item;
  }

  cancel(item) {
    if (!item) return;
    if (item.state === STATE.QUEUED) item.state = STATE.CANCELLED;
    else if (item.state === STATE.UPLOADING) item.cancelRequested = true;
    this.onChange();
  }

  retry(item) {
    if (!item || ![STATE.FAILED, STATE.CANCELLED].includes(item.state)) return;
    item.state = STATE.QUEUED;
    item.transferred = 0;
    item.total = 0;
    item.speed = 0;
    item.error = null;
    item.cancelRequested = false;
    this.onChange();
    this._pump();
  }

  retryAllFailed() {
    this.items.filter((i) => i.state === STATE.FAILED).forEach((i) => this.retry(i));
  }

  clearFinished() {
    this.items = this.items.filter((i) => ACTIVE_STATES.includes(i.state));
    this.onChange();
  }

  _pump() {
    this.pool.size = this.concurrency; // size the pool to the configured concurrency
    // New batch starting (was idle, now has work): reset per-batch counters.
    if (this._idle && this.active === 0 && this.items.some((i) => i.state === STATE.QUEUED)) {
      this._idle = false;
      this._batchDone = 0;
      this._batchFail = 0;
    }
    while (this.active < this.concurrency) {
      const next = this.items.find((i) => i.state === STATE.QUEUED);
      if (!next) break;
      this.active++;
      this._run(next).finally(() => {
        this.active--;
        this._pump();
        // Free idle connections once the queue is drained, and report the batch.
        if (this.active === 0 && !this.items.some((i) => i.state === STATE.QUEUED)) {
          this.pool.closeAll();
          if (!this._idle) {
            this._idle = true;
            if (this.onIdle) {
              try {
                this.onIdle(this._batchDone, this._batchFail);
              } catch {
                /* ignore */
              }
            }
          }
        }
      });
    }
  }

  async _run(item) {
    if (item.cancelRequested) {
      item.state = STATE.CANCELLED;
      this.onChange();
      return;
    }
    item.state = STATE.UPLOADING;
    item.startTime = Date.now();
    this.onChange();

    const tmp = item.remotePath + '.qs-tmp';
    let sftp = null;
    try {
      sftp = await this.pool.acquire(); // own connection → safe to run in parallel

      // Rollback support: back up an existing remote file before overwriting it.
      const conf = vscode.workspace.getConfiguration('quicksync');
      if (conf.get('backupBeforeOverwrite', false) || conf.get('enterpriseMode', false)) {
        try {
          const existed = !!(await sftp.exists(item.remotePath));
          item.existed = existed; // for undo: was there a prior version?
          if (existed) {
            const dir = POSIX.dirname(item.remotePath);
            const bdir = POSIX.join(dir, '.quicksync-backups');
            if (!(await sftp.exists(bdir))) await sftp.mkdir(bdir, true);
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backup = POSIX.join(bdir, POSIX.basename(item.remotePath) + '.' + stamp);
            await sftp.rename(item.remotePath, backup); // original preserved as backup
            item.backupPath = backup; // for undo: where to restore from
            this.audit.log('backup', { remotePath: item.remotePath, to: backup });
          }
        } catch {
          /* non-fatal: proceed without a backup rather than block the upload */
        }
      }

      await sftp.fastPut(item.localFull, tmp, {
        step: (transferred, _chunk, total) => {
          item.transferred = transferred;
          item.total = total;
          const elapsed = (Date.now() - item.startTime) / 1000;
          item.speed = elapsed > 0 ? transferred / elapsed : 0;
          this.onChange();
        },
      });

      // Atomic publish (posix-rename, fallback delete+rename).
      try {
        await sftp.posixRename(tmp, item.remotePath);
      } catch {
        try {
          await sftp.delete(item.remotePath);
        } catch {
          /* may not exist */
        }
        await sftp.rename(tmp, item.remotePath);
      }

      if (item.cancelRequested) {
        item.state = STATE.CANCELLED;
        try {
          await sftp.delete(item.remotePath);
        } catch {
          /* best effort */
        }
      } else {
        item.state = STATE.COMPLETED;
        item.transferred = item.total || item.transferred;
        this.audit.log('upload', { remotePath: item.remotePath, bytes: item.total, result: 'ok' });
      }
    } catch (err) {
      const msg = err && err.message ? err.message : 'upload failed';
      // A dropped/dead connection? Evict the client so a fresh one is created.
      const connErr = /econn|closed|timed?\s*out|not connected|channel|disconnect|ENOTFOUND|EPIPE|destroyed|ECONNRESET|handshake/i.test(msg);
      if (connErr && sftp && this.pool) {
        await this.pool.evict(sftp);
        sftp = null;
      }
      // Retry transient failures (esp. connection drops) before giving up.
      if ((item.attempts || 0) < 2) {
        item.attempts = (item.attempts || 0) + 1;
        item.state = STATE.QUEUED;
        item.error = null;
        item.transferred = 0;
        if (sftp) this.pool.release(sftp);
        sftp = null;
        this.onChange();
        setTimeout(() => this._pump(), connErr ? 600 : 150);
        return; // not terminal — don't notify onComplete yet
      }
      item.state = STATE.FAILED;
      item.error = msg;
      this.audit.log('upload', { remotePath: item.remotePath, result: 'failed' });
      if (sftp) {
        try {
          await sftp.delete(tmp);
        } catch {
          /* ignore */
        }
      }
    } finally {
      if (sftp) this.pool.release(sftp);
    }
    // Notify once on a terminal state (used to record the sync manifest).
    if ([STATE.COMPLETED, STATE.FAILED, STATE.CANCELLED].includes(item.state) && !item._notified) {
      item._notified = true;
      if (item.state === STATE.COMPLETED) this._batchDone++;
      else if (item.state === STATE.FAILED) this._batchFail++;
      if (item.onComplete) {
        try {
          item.onComplete(item.state, { existed: item.existed, backup: item.backupPath });
        } catch {
          /* ignore */
        }
      }
    }
    this.onChange();
  }
}

// ---------- Tree view ----------

function fmtSize(b) {
  if (b == null) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = b;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)}${u[i]}`;
}

function fmtEta(s) {
  if (s == null) return '';
  if (s < 60) return `${Math.ceil(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(Math.ceil(s % 60)).padStart(2, '0')}s`;
}

const STATE_ICON = {
  Queued: 'clock',
  Uploading: 'sync~spin',
  Completed: 'check',
  Failed: 'error',
  Cancelled: 'circle-slash',
};

class QueueItem extends vscode.TreeItem {
  constructor(t) {
    super(t.label, vscode.TreeItemCollapsibleState.None);
    this.transfer = t;
    this.contextValue = 'qitem-' + t.state.toLowerCase();
    this.iconPath = new vscode.ThemeIcon(STATE_ICON[t.state] || 'circle-outline');
    this.description = QueueItem.statusText(t);
    this.tooltip = `${t.localFull}\n→ ${t.remotePath}\n${t.state}${t.error ? ': ' + t.error : ''}`;
  }
  static statusText(t) {
    switch (t.state) {
      case 'Uploading': {
        const spd = t.speed ? `  ${fmtSize(t.speed)}/s` : '';
        const eta = t.etaSeconds != null ? `  ETA ${fmtEta(t.etaSeconds)}` : '';
        return `${t.percent}%${spd}${eta}`;
      }
      case 'Completed':
        return `✓ ${fmtSize(t.total)}`;
      case 'Failed':
        return `✗ ${t.error || 'failed'}`;
      default:
        return t.state;
    }
  }
}

class QueueTreeProvider {
  constructor(queue) {
    this.queue = queue;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }
  refresh() {
    this._onDidChangeTreeData.fire();
  }
  getTreeItem(el) {
    return el;
  }
  getChildren() {
    // Newest first.
    return this.queue.items.slice().reverse().map((t) => new QueueItem(t));
  }
}

function registerTransferQueue(context, deps) {
  let conn = null;
  const audit = (deps && deps.audit) || { log() {} };
  // Throttle refreshes — `step` fires very frequently.
  let provider;
  let pending = false;
  const onChange = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      if (provider) provider.refresh();
    }, 250);
  };

  // Pool of independent, fully-verified connections for parallel uploads.
  const pool = new ClientPool(async () => {
    if (!conn || !conn.deps) throw new Error('Not connected.');
    const cfg = await conn.deps.loadConfig();
    if (!cfg) throw new Error('No QuickSync config found.');
    return conn.deps.connectSftp(cfg); // host-verified, pinned-algorithm connection
  });
  const queue = new TransferQueue({ getClient: () => conn.getClient(), get cfg() { return conn && conn.cfg; } }, onChange, audit, pool);
  provider = new QueueTreeProvider(queue);

  const view = vscode.window.createTreeView('quicksyncQueue', { treeDataProvider: provider });
  context.subscriptions.push(view);

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('quicksync.queue.cancel', (el) => queue.cancel(el && el.transfer));
  reg('quicksync.queue.retry', (el) => queue.retry(el && el.transfer));
  reg('quicksync.queue.clear', () => queue.clearFinished());
  reg('quicksync.queue.retryAll', () => queue.retryAllFailed());

  // The connection is injected after creation so the explorer + queue share one.
  queue.bindConnection = (c) => {
    conn = c;
  };
  return queue;
}

module.exports = { registerTransferQueue, STATE };
