// Phase 7 — Deployment safety scan.
//
// The SECRET_DENY list in extension.js HARD-blocks the worst secrets (.env,
// private keys, dumps) — they are never uploaded. This module is the softer,
// WARN-level layer: files that are often sensitive but sometimes legitimately
// deployed (server configs, certs, compose files) and a lightweight content
// scan for credentials embedded in otherwise-ordinary files. Matches here are
// surfaced to the user as Upload / Skip / Always Ignore — they are not blocked.

const fs = require('fs');

// Filename/path patterns that warrant a warning (distinct from the hard deny).
const SENSITIVE_PATTERNS = [
  /(^|\/)wp-config\.php$/i,
  /(^|\/)config\.php$/i,
  /(^|\/)web\.config$/i,
  /(^|\/)\.htaccess$/i,
  /(^|\/)\.htpasswd$/i,
  /(^|\/)\.htdigest$/i,
  /(^|\/)\.dockercfg$/i,
  /(^|\/)docker-compose(\.[A-Za-z0-9_-]+)?\.ya?ml$/i,
  /(^|\/)appsettings(\.[A-Za-z0-9_-]+)?\.json$/i,
  /\.(crt|cer|der|csr|keystore|jks|p7b|p8|p10)$/i,
];

const MAX_SCAN_BYTES = 256 * 1024;

// Content signatures for high-confidence credentials.
const CONTENT_SIGNATURES = [
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, label: 'embedded private key' },
  { re: /AKIA[0-9A-Z]{16}/, label: 'AWS access key' },
  { re: /xox[baprs]-[0-9A-Za-z-]{10,}/, label: 'Slack token' },
  { re: /gh[pousr]_[0-9A-Za-z]{20,}/, label: 'GitHub token' },
];

function isSensitiveName(rel) {
  const norm = rel.split('\\').join('/');
  return SENSITIVE_PATTERNS.some((re) => re.test(norm));
}

// Returns a credential label if the file's text content matches a signature.
function scanContent(full) {
  try {
    const st = fs.statSync(full);
    if (st.size === 0 || st.size > MAX_SCAN_BYTES) return null;
    const buf = fs.readFileSync(full);
    if (buf.includes(0)) return null; // binary — skip
    const s = buf.toString('utf8');
    for (const sig of CONTENT_SIGNATURES) {
      if (sig.re.test(s)) return sig.label;
    }
    return null;
  } catch {
    return null;
  }
}

// Classify entries → [{ rel, reason }] for any flagged as sensitive.
function classify(files) {
  const out = [];
  for (const f of files) {
    if (isSensitiveName(f.rel)) {
      out.push({ rel: f.rel, reason: 'sensitive filename' });
      continue;
    }
    const hit = scanContent(f.full);
    if (hit) out.push({ rel: f.rel, reason: hit });
  }
  return out;
}

module.exports = { classify, isSensitiveName, scanContent };
