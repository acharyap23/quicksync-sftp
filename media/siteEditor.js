// Webview script for the Site Editor (FileZilla-style form).
// No I/O here — it gathers form values and posts them to the extension host,
// which validates and persists. Labels/values are set via value/textContent,
// never innerHTML.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let editingId = null;
  let hasStoredSecret = false;

  function isSftpLike(p) {
    return p === 'sftp' || p === 'scp';
  }

  function applyProtocol() {
    const p = $('protocol').value;
    // Encryption only matters for FTP/FTPS.
    $('rowEncryption').classList.toggle('hide', isSftpLike(p));
    // FTP insecurity warning.
    $('ftpWarn').classList.toggle('show', p === 'ftp');
    // Non-SFTP cannot connect yet.
    $('protoWarn').classList.toggle('show', p !== 'sftp');
  }

  function applyLogon() {
    const t = $('logonType').value; // 'password' | 'key'
    $('rowPassword').classList.toggle('hide', t !== 'password');
    $('rowKeyPath').classList.toggle('hide', t !== 'key');
    $('rowPassphrase').classList.toggle('hide', t !== 'key');
  }

  function showTab(name) {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === name);
    for (const p of document.querySelectorAll('.panel')) p.classList.toggle('active', p.dataset.panel === name);
  }

  function gather() {
    return {
      id: editingId,
      siteName: $('siteName').value.trim(),
      protocol: $('protocol').value,
      host: $('host').value.trim(),
      port: parseInt($('port').value, 10) || 22,
      username: $('user').value.trim(),
      remotePath: $('remoteRoot').value.trim(),
      privateKeyPath: $('logonType').value === 'key' ? $('keyPath').value.trim() : '',
      hostFingerprint: $('fingerprint').value.trim(),
      folder: $('folder').value.trim(),
      logonType: $('logonType').value,
      // Secrets sent separately; blank means "keep existing" when editing.
      password: $('logonType').value === 'password' ? $('password').value : '',
      passphrase: $('logonType').value === 'key' ? $('passphrase').value : '',
    };
  }

  function submit(connect) {
    vscode.postMessage({ type: connect ? 'saveAndConnect' : 'save', site: gather() });
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.type !== 'load') return;
    const s = m.site || {};
    editingId = s.id || null;
    hasStoredSecret = !!m.hasStoredSecret;
    $('title').textContent = editingId ? 'Edit Site' : 'New Site';
    $('siteName').value = s.siteName || '';
    $('protocol').value = s.protocol || 'sftp';
    $('host').value = s.host || '';
    $('port').value = s.port || 22;
    $('user').value = s.username || '';
    $('remoteRoot').value = s.remotePath || '/';
    $('keyPath').value = s.privateKeyPath || '~/.ssh/id_rsa';
    $('fingerprint').value = s.hostFingerprint || '';
    $('folder').value = s.folder || '';
    $('logonType').value = s.privateKeyPath ? 'key' : 'password';
    if (hasStoredSecret) {
      $('password').placeholder = '•••••••• (unchanged — leave blank to keep)';
      $('passphrase').placeholder = '•••••••• (unchanged — leave blank to keep)';
    }
    applyProtocol();
    applyLogon();
  });

  document.querySelectorAll('.tab').forEach((t) => {
    if (!t.classList.contains('disabled')) t.addEventListener('click', () => showTab(t.dataset.tab));
  });
  $('protocol').addEventListener('change', applyProtocol);
  $('logonType').addEventListener('change', applyLogon);
  $('saveBtn').addEventListener('click', () => submit(false));
  $('connectBtn').addEventListener('click', () => submit(true));
  $('cancelBtn').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

  vscode.postMessage({ type: 'ready' });
})();
