// Minimal OpenSSH client-config (~/.ssh/config) reader.
//
// Parses Host blocks and their HostName / User / Port / IdentityFile so a saved
// site can be pre-filled from the user's existing SSH setup. Intentionally
// simple: no Include/Match/ProxyJump resolution. Read-only — never modifies the
// file, and the key file itself is never read here (only its path is captured).

const fs = require('fs');
const os = require('os');
const path = require('path');

function configPath() {
  return path.join(os.homedir(), '.ssh', 'config');
}

function defaultKeyPath() {
  return path.join(os.homedir(), '.ssh', 'id_rsa');
}

function parse() {
  const p = configPath();
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch {
    return [];
  }
  const hosts = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\S+)\s+(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim().replace(/^["']|["']$/g, '');
    if (key === 'host') {
      // A Host line can list several patterns; pick the first concrete alias.
      const patterns = val.split(/\s+/);
      const alias = patterns.find((x) => !/[*?!]/.test(x)) || patterns[0];
      cur = { host: alias, hostName: '', user: '', port: '', identityFile: '' };
      hosts.push(cur);
    } else if (cur) {
      if (key === 'hostname') cur.hostName = val;
      else if (key === 'user') cur.user = val;
      else if (key === 'port') cur.port = val;
      else if (key === 'identityfile') cur.identityFile = val;
    }
  }
  // Drop wildcard-only blocks (e.g. "Host *").
  return hosts.filter((h) => h.host && !/[*?]/.test(h.host));
}

module.exports = { parse, configPath, defaultKeyPath };
