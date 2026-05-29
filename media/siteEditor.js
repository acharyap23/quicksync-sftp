// Webview script for the Site Editor (FileZilla-style, 4 tabs).
// No I/O — gathers form values and posts to the host, which validates and
// persists. Values set via .value / textContent, never innerHTML.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let editingId = null;

  const isSftpLike = (p) => p === 'sftp' || p === 'scp';

  function applyProtocol() {
    const p = $('protocol').value;
    $('rowEncryption').classList.toggle('hide', isSftpLike(p));
    $('ftpWarn').classList.toggle('show', p === 'ftp');
    $('protoWarn').classList.toggle('show', p !== 'sftp');
  }
  function applyLogon() {
    const key = $('logonType').value === 'key';
    $('rowPassword').classList.toggle('hide', key);
    $('rowKeyPath').classList.toggle('hide', !key);
    $('rowPassphrase').classList.toggle('hide', !key);
  }
  function applyLimit() {
    $('maxConns').disabled = !$('limitConns').checked;
  }
  function showTab(name) {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === name);
    for (const p of document.querySelectorAll('.panel')) p.classList.toggle('active', p.dataset.panel === name);
  }

  function gather() {
    const key = $('logonType').value === 'key';
    return {
      id: editingId,
      siteName: $('siteName').value.trim(),
      protocol: $('protocol').value,
      host: $('host').value.trim(),
      port: parseInt($('port').value, 10) || 22,
      username: $('user').value.trim(),
      remotePath: $('remoteRoot').value.trim(),
      localDir: $('localDir').value.trim(),
      privateKeyPath: key ? $('keyPath').value.trim() : '',
      hostFingerprint: $('fingerprint').value.trim(),
      folder: $('folder').value.trim(),
      maxConnections: $('limitConns').checked ? Math.max(1, parseInt($('maxConns').value, 10) || 1) : 0,
      timeOffsetMinutes: (parseInt($('offsetH').value, 10) || 0) * 60 + (parseInt($('offsetM').value, 10) || 0),
      notes: $('notes').value,
      logonType: $('logonType').value,
      password: key ? '' : $('password').value,
      passphrase: key ? $('passphrase').value : '',
    };
  }
  const submit = (connect) => vscode.postMessage({ type: connect ? 'saveAndConnect' : 'save', site: gather() });

  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.type === 'localDir') {
      if (typeof m.path === 'string') $('localDir').value = m.path;
      return;
    }
    if (m.type !== 'load') return;
    const s = m.site || {};
    editingId = s.id || null;
    $('title').textContent = editingId ? 'Edit Site' : 'New Site';
    $('siteName').value = s.siteName || '';
    $('protocol').value = s.protocol || 'sftp';
    $('host').value = s.host || '';
    $('port').value = s.port || 22;
    $('user').value = s.username || '';
    $('remoteRoot').value = s.remotePath || '/';
    $('localDir').value = s.localDir || '';
    $('keyPath').value = s.privateKeyPath || '~/.ssh/id_rsa';
    $('fingerprint').value = s.hostFingerprint || '';
    $('folder').value = s.folder || '';
    $('notes').value = s.notes || '';
    $('logonType').value = s.privateKeyPath ? 'key' : 'password';
    const off = s.timeOffsetMinutes || 0;
    $('offsetH').value = Math.trunc(off / 60);
    $('offsetM').value = off % 60;
    $('limitConns').checked = !!(s.maxConnections && s.maxConnections > 0);
    $('maxConns').value = s.maxConnections && s.maxConnections > 0 ? s.maxConnections : 1;
    if (m.hasStoredSecret) {
      $('password').placeholder = '•••••••• (unchanged — leave blank to keep)';
      $('passphrase').placeholder = '•••••••• (unchanged — leave blank to keep)';
    }
    applyProtocol();
    applyLogon();
    applyLimit();
  });

  document.querySelectorAll('.tab').forEach((t) => {
    if (!t.classList.contains('disabled')) t.addEventListener('click', () => showTab(t.dataset.tab));
  });
  $('protocol').addEventListener('change', applyProtocol);
  $('logonType').addEventListener('change', applyLogon);
  $('limitConns').addEventListener('change', applyLimit);
  $('browseBtn').addEventListener('click', () => vscode.postMessage({ type: 'browseLocal' }));
  $('saveBtn').addEventListener('click', () => submit(false));
  $('connectBtn').addEventListener('click', () => submit(true));
  $('cancelBtn').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

  vscode.postMessage({ type: 'ready' });
})();
