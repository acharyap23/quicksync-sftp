// Webview script for the QuickSync dual-pane explorer.
//
// SECURITY: this script never trusts incoming data as HTML. Every label is set
// via textContent (never innerHTML), so a hostile remote filename cannot inject
// markup or script. It performs no I/O itself — it only posts validated intents
// to the extension host, which re-checks every path.
(function () {
  const vscode = acquireVsCodeApi();

  const state = {
    local: { path: '', entries: [], sel: new Set() },
    remote: { path: '', entries: [], sel: new Set() },
  };

  const $ = (id) => document.getElementById(id);

  function log(text) {
    const el = $('log');
    const line = document.createElement('div');
    line.textContent = text; // textContent — no HTML injection
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }

  function renderPane(side) {
    const s = state[side];
    $(side + 'Path').textContent = s.path || '(loading…)';
    const ul = $(side + 'List');
    ul.textContent = '';
    const filter = $(side + 'Filter').value.toLowerCase();

    // Parent entry
    const up = document.createElement('li');
    up.textContent = '📁 ..';
    up.dataset.kind = 'up';
    ul.appendChild(up);

    for (const e of s.entries) {
      if (filter && !e.name.toLowerCase().includes(filter)) continue;
      const li = document.createElement('li');
      const ic = document.createElement('span');
      ic.className = 'ic';
      ic.textContent = e.type === 'd' ? '📁' : '📄';
      li.appendChild(ic);
      li.appendChild(document.createTextNode(e.name)); // textContent-safe
      li.dataset.kind = e.type === 'd' ? 'dir' : 'file';
      li.dataset.name = e.name;
      if (s.sel.has(e.name)) li.classList.add('sel');
      if (side === 'local' && e.type !== 'd') li.draggable = true;
      ul.appendChild(li);
    }
  }

  function join(base, name) {
    if (!base.endsWith('/')) base += '/';
    return base + name;
  }
  function parent(p) {
    const i = p.replace(/\/+$/, '').lastIndexOf('/');
    return i <= 0 ? '/' : p.slice(0, i);
  }

  function wirePane(side) {
    const ul = $(side + 'List');
    ul.addEventListener('click', (ev) => {
      const li = ev.target.closest('li');
      if (!li) return;
      const s = state[side];
      if (li.dataset.kind === 'up') {
        navigate(side, parent(s.path));
        return;
      }
      if (li.dataset.kind === 'dir') {
        navigate(side, join(s.path, li.dataset.name));
        return;
      }
      // file: toggle selection (multi-select)
      const name = li.dataset.name;
      if (s.sel.has(name)) s.sel.delete(name);
      else s.sel.add(name);
      li.classList.toggle('sel');
    });
    $(side + 'Filter').addEventListener('input', () => renderPane(side));
    $(side + 'Refresh').addEventListener('click', () => navigate(side, state[side].path));
  }

  function navigate(side, path) {
    state[side].sel.clear();
    vscode.postMessage({ type: side === 'local' ? 'listLocal' : 'listRemote', path });
  }

  function selectedFiles(side) {
    return [...state[side].sel].map((name) => join(state[side].path, name));
  }

  function doUpload(localFullPaths) {
    if (!localFullPaths.length) {
      log('Nothing selected to upload.');
      return;
    }
    vscode.postMessage({ type: 'upload', localPaths: localFullPaths, remoteDir: state.remote.path });
  }

  function init() {
    wirePane('local');
    wirePane('remote');
    $('uploadBtn').addEventListener('click', () => doUpload(selectedFiles('local')));
    $('downloadBtn').addEventListener('click', () => {
      const sel = selectedFiles('remote');
      if (!sel.length) {
        log('Nothing selected to download.');
        return;
      }
      vscode.postMessage({ type: 'download', remotePaths: sel, localDir: state.local.path });
    });

    // Drag a local file onto the remote pane to upload it.
    const remotePane = $('remotePane');
    remotePane.addEventListener('dragover', (e) => {
      e.preventDefault();
      remotePane.classList.add('dropping');
    });
    remotePane.addEventListener('dragleave', () => remotePane.classList.remove('dropping'));
    remotePane.addEventListener('drop', (e) => {
      e.preventDefault();
      remotePane.classList.remove('dropping');
      const name = e.dataTransfer.getData('text/plain');
      if (name) doUpload([join(state.local.path, name)]);
    });
    $('localList').addEventListener('dragstart', (e) => {
      const li = e.target.closest('li');
      if (li && li.dataset.kind === 'file') e.dataTransfer.setData('text/plain', li.dataset.name);
    });

    vscode.postMessage({ type: 'init' });
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.type === 'local' || m.type === 'remote') {
      const side = m.type;
      state[side].path = typeof m.path === 'string' ? m.path : '';
      state[side].entries = Array.isArray(m.entries) ? m.entries : [];
      state[side].sel.clear();
      renderPane(side);
    } else if (m.type === 'log') {
      log(String(m.text || ''));
    }
  });

  init();
})();
