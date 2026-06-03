// Dual-pane explorer — FileZilla-style navigable file lists (local | remote).
//
// SECURITY: never trusts data as HTML (textContent only). No I/O — it posts
// intents; the host re-validates every path. Double-click a folder to enter it,
// ".." to go up, single-click to select (Ctrl/Cmd for multi). Only columns we
// can actually populate are shown (remote adds Permissions/Owner).
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const state = { local: { dir: '', sel: new Set() }, remote: { dir: '', sel: new Set() } };

  function log(t) {
    const el = $('log');
    const d = document.createElement('div');
    d.textContent = t;
    el.appendChild(d);
    el.scrollTop = el.scrollHeight;
  }
  function fmtSize(b) {
    if (b == null || b === '') return '';
    let n = Number(b);
    if (isNaN(n)) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) {
      n /= 1024;
      i++;
    }
    return (i ? n.toFixed(1) : n) + ' ' + u[i];
  }
  function fmtDate(ms) {
    if (!ms) return '';
    try {
      const d = new Date(Number(ms));
      return isNaN(d.getTime()) ? '' : d.toLocaleString();
    } catch {
      return '';
    }
  }
  function ext(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(i + 1).toUpperCase() + ' File' : 'File';
  }
  function parentOf(p) {
    const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
    const i = norm.lastIndexOf('/');
    if (i < 0) return p;
    return norm.slice(0, i) || '/';
  }
  function cell(text, cls) {
    const td = document.createElement('td');
    if (cls) td.className = cls;
    td.textContent = text;
    return td;
  }

  function makeRow(side, e) {
    const tr = document.createElement('tr');
    tr.dataset.side = side;
    tr.dataset.path = e.path;
    tr.dataset.kind = e.type === 'd' ? 'dir' : 'file';
    tr.dataset.name = e.name;
    const nameTd = document.createElement('td');
    const ic = document.createElement('span');
    ic.className = 'ic';
    ic.textContent = e.type === 'd' ? '📁' : '📄';
    nameTd.appendChild(ic);
    nameTd.appendChild(document.createTextNode(e.name));
    tr.appendChild(nameTd);
    tr.appendChild(cell(e.type === 'd' ? '' : fmtSize(e.size), 'col-size'));
    tr.appendChild(cell(fmtDate(e.mtime), 'col-mtime'));
    if (side === 'remote') {
      tr.appendChild(cell(e.perms || '', 'col-perm'));
      tr.appendChild(cell(e.owner || '', 'col-owner'));
    } else {
      tr.appendChild(cell(e.type === 'd' ? 'Folder' : ext(e.name), 'col-type'));
    }
    if (side === 'local' && e.type !== 'd') tr.draggable = true;
    return tr;
  }

  function parentRow(side) {
    const tr = document.createElement('tr');
    tr.dataset.side = side;
    tr.dataset.kind = 'up';
    const td = document.createElement('td');
    td.colSpan = side === 'remote' ? 5 : 4;
    const ic = document.createElement('span');
    ic.className = 'ic';
    ic.textContent = '📂';
    td.appendChild(ic);
    td.appendChild(document.createTextNode('..'));
    tr.appendChild(td);
    return tr;
  }

  function render(side, dir, entries) {
    state[side].dir = dir;
    state[side].sel.clear();
    $(side + 'Path').textContent = dir || '(none)';
    const tb = $(side + 'List');
    tb.textContent = '';
    tb.appendChild(parentRow(side));
    entries.forEach((e) => tb.appendChild(makeRow(side, e)));
  }

  function navigate(side, dir) {
    vscode.postMessage({ type: side === 'local' ? 'listLocal' : 'listRemote', path: dir });
  }

  function selectRow(side, tr, additive) {
    if (!additive) {
      $(side + 'List')
        .querySelectorAll('tr.sel')
        .forEach((r) => r.classList.remove('sel'));
      state[side].sel.clear();
    }
    if (state[side].sel.has(tr.dataset.path)) {
      state[side].sel.delete(tr.dataset.path);
      tr.classList.remove('sel');
    } else {
      state[side].sel.add(tr.dataset.path);
      tr.classList.add('sel');
    }
  }

  function wire(side) {
    const tb = $(side + 'List');
    tb.addEventListener('click', (ev) => {
      const tr = ev.target.closest('tr');
      if (!tr || tr.dataset.kind === 'up') return;
      selectRow(side, tr, ev.ctrlKey || ev.metaKey);
    });
    tb.addEventListener('dblclick', (ev) => {
      const tr = ev.target.closest('tr');
      if (!tr) return;
      if (tr.dataset.kind === 'up') return navigate(side, parentOf(state[side].dir));
      if (tr.dataset.kind === 'dir') navigate(side, tr.dataset.path);
    });
    $(side + 'Filter').addEventListener('input', () => {
      const f = $(side + 'Filter').value.toLowerCase();
      tb.querySelectorAll('tr').forEach((tr) => {
        if (tr.dataset.kind === 'up') return;
        tr.style.display = !f || (tr.dataset.name || '').toLowerCase().includes(f) ? '' : 'none';
      });
    });
    $(side + 'Refresh').addEventListener('click', () => navigate(side, state[side].dir));
  }

  function init() {
    wire('local');
    wire('remote');
    $('uploadBtn').addEventListener('click', () => {
      const f = [...state.local.sel];
      if (!f.length) return log('Select local item(s) to upload.');
      vscode.postMessage({ type: 'upload', localPaths: f, remoteDir: state.remote.dir });
    });
    $('downloadBtn').addEventListener('click', () => {
      const f = [...state.remote.sel];
      if (!f.length) return log('Select remote item(s) to download.');
      vscode.postMessage({ type: 'download', remotePaths: f, localDir: state.local.dir });
    });
    const rp = $('remotePane');
    rp.addEventListener('dragover', (e) => {
      e.preventDefault();
      rp.classList.add('dropping');
    });
    rp.addEventListener('dragleave', () => rp.classList.remove('dropping'));
    rp.addEventListener('drop', (e) => {
      e.preventDefault();
      rp.classList.remove('dropping');
      const p = e.dataTransfer.getData('text/plain');
      if (p) vscode.postMessage({ type: 'upload', localPaths: [p], remoteDir: state.remote.dir });
    });
    $('localList').addEventListener('dragstart', (e) => {
      const tr = e.target.closest('tr');
      if (tr && tr.dataset.kind === 'file') e.dataTransfer.setData('text/plain', tr.dataset.path);
    });
    vscode.postMessage({ type: 'init' });
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.type === 'remoteCleared') {
      state.remote.dir = '';
      state.remote.sel.clear();
      $('remotePath').textContent = '(disconnected)';
      const tb = $('remoteList');
      tb.textContent = '';
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.textContent = 'Not connected';
      tr.appendChild(td);
      tb.appendChild(tr);
      return;
    }
    if (m.type === 'local' || m.type === 'remote') {
      render(m.type, typeof m.path === 'string' ? m.path : '', Array.isArray(m.entries) ? m.entries : []);
    } else if (m.type === 'log') {
      log(String(m.text || ''));
    } else if (m.type === 'transfers') {
      renderTransfers(Array.isArray(m.items) ? m.items : []);
    }
  });

  function renderTransfers(items) {
    const tb = $('xfer');
    if (!tb) return;
    tb.textContent = '';
    items
      .slice()
      .reverse()
      .forEach((t) => {
        const tr = document.createElement('tr');
        const arrow = t.dir === 'down' ? '↓ ' : '↑ ';
        tr.appendChild(cell(arrow + (t.label || '')));
        tr.appendChild(cell(fmtSize(t.total), 'col-size'));
        const inProgress = t.state === 'Uploading' || t.state === 'Downloading';
        tr.appendChild(cell(inProgress ? (t.percent || 0) + '%' : '', 'col-perm'));
        tr.appendChild(cell(t.state || ''));
        tb.appendChild(tr);
      });
  }

  init();
})();
