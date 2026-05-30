// Dual-pane explorer webview — expandable tree on both local and remote sides.
//
// SECURITY: never trusts incoming data as HTML. Every label is set via
// textContent. It performs no I/O — it posts intents to the extension host,
// which re-validates every path. Folders load their children lazily on expand.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const state = { local: { root: '', sel: new Set() }, remote: { root: '', sel: new Set() } };
  const pending = {}; // "side|path" -> the <ul.children> awaiting its listing

  function log(text) {
    const el = $('log');
    const d = document.createElement('div');
    d.textContent = text;
    el.appendChild(d);
    el.scrollTop = el.scrollHeight;
  }

  function makeNode(side, entry) {
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.side = side;
    row.dataset.path = entry.path;
    row.dataset.kind = entry.type === 'd' ? 'dir' : 'file';
    const tog = document.createElement('span');
    tog.className = 'tog';
    tog.textContent = entry.type === 'd' ? '▸' : '';
    const ic = document.createElement('span');
    ic.className = 'ic';
    ic.textContent = entry.type === 'd' ? '📁' : '📄';
    row.appendChild(tog);
    row.appendChild(ic);
    row.appendChild(document.createTextNode(entry.name)); // textContent-safe
    li.appendChild(row);
    if (entry.type === 'd') {
      const ul = document.createElement('ul');
      ul.className = 'children';
      ul.hidden = true;
      li.appendChild(ul);
    } else if (side === 'local') {
      row.draggable = true;
    }
    return li;
  }

  function renderRoot(side, entries) {
    const ul = $(side + 'List');
    ul.textContent = '';
    entries.forEach((e) => ul.appendChild(makeNode(side, e)));
  }

  function toggleSel(side, row) {
    const p = row.dataset.path;
    if (state[side].sel.has(p)) {
      state[side].sel.delete(p);
      row.classList.remove('sel');
    } else {
      state[side].sel.add(p);
      row.classList.add('sel');
    }
  }

  function onRowClick(side, row) {
    if (row.dataset.kind === 'file') {
      toggleSel(side, row);
      return;
    }
    const li = row.parentElement;
    const ul = li.querySelector(':scope > ul.children');
    if (!ul) return;
    const tog = row.querySelector('.tog');
    if (!ul.hidden) {
      ul.hidden = true;
      tog.textContent = '▸';
      return;
    }
    tog.textContent = '▾';
    ul.hidden = false;
    if (ul.dataset.loaded !== '1') {
      pending[side + '|' + row.dataset.path] = ul;
      vscode.postMessage({ type: side === 'local' ? 'listLocal' : 'listRemote', path: row.dataset.path });
    }
  }

  function applyFilter(side) {
    const f = $(side + 'Filter').value.toLowerCase();
    $(side + 'List')
      .querySelectorAll('.row')
      .forEach((r) => {
        const name = r.textContent.toLowerCase();
        r.parentElement.style.display = !f || name.includes(f) ? '' : 'none';
      });
  }

  function wire(side) {
    $(side + 'List').addEventListener('click', (ev) => {
      const row = ev.target.closest('.row');
      if (row && row.dataset.side === side) onRowClick(side, row);
    });
    $(side + 'Filter').addEventListener('input', () => applyFilter(side));
    $(side + 'Refresh').addEventListener('click', () => {
      state[side].sel.clear();
      vscode.postMessage({ type: side === 'local' ? 'listLocal' : 'listRemote', path: state[side].root });
    });
  }

  function init() {
    wire('local');
    wire('remote');
    $('uploadBtn').addEventListener('click', () => {
      const f = [...state.local.sel];
      if (!f.length) return log('Select local file(s) to upload.');
      vscode.postMessage({ type: 'upload', localPaths: f, remoteDir: state.remote.root });
    });
    $('downloadBtn').addEventListener('click', () => {
      const f = [...state.remote.sel];
      if (!f.length) return log('Select remote file(s) to download.');
      vscode.postMessage({ type: 'download', remotePaths: f, localDir: state.local.root });
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
      if (p) vscode.postMessage({ type: 'upload', localPaths: [p], remoteDir: state.remote.root });
    });
    $('localList').addEventListener('dragstart', (e) => {
      const row = e.target.closest('.row');
      if (row && row.dataset.kind === 'file') e.dataTransfer.setData('text/plain', row.dataset.path);
    });
    vscode.postMessage({ type: 'init' });
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.type === 'local' || m.type === 'remote') {
      const side = m.type;
      const path = typeof m.path === 'string' ? m.path : '';
      const entries = Array.isArray(m.entries) ? m.entries : [];
      if (!state[side].root || path === state[side].root) {
        state[side].root = path;
        $(side + 'Path').textContent = path || '(none)';
        state[side].sel.clear();
        renderRoot(side, entries);
      } else {
        const ul = pending[side + '|' + path];
        if (ul) {
          ul.textContent = '';
          entries.forEach((e) => ul.appendChild(makeNode(side, e)));
          ul.dataset.loaded = '1';
          delete pending[side + '|' + path];
        }
      }
    } else if (m.type === 'log') {
      log(String(m.text || ''));
    }
  });

  init();
})();
