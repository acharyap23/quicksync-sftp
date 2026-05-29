# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for an
unfixed vulnerability.

- Use GitHub's **"Report a vulnerability"** (Security → Advisories) on this
  repository, or email the publisher.
- Include: affected version, a description, reproduction steps, and the impact
  you believe it has.

We aim to acknowledge within **72 hours** and to ship a fix or mitigation for
confirmed high/critical issues as quickly as practical. We'll credit reporters
who want it.

## Supported versions

The latest published `0.x` release receives security fixes. Older versions do
not.

## Security design summary

QuickSync is designed to resist a hostile network and a hostile repository:

- **Transport:** SFTP/SSH only; no FTP or plaintext path exists.
- **MITM:** SSH host keys are pinned (trust-on-first-use with explicit
  confirmation); a changed key is refused. Only strong KEX/cipher/MAC/host-key
  algorithms are offered (downgrade-resistant).
- **Secrets:** passwords and key passphrases live in the OS keychain
  (`SecretStorage`), never in `quicksync.json`. Reuse across workspaces requires
  confirmation.
- **Workspace trust:** disabled in untrusted workspaces.
- **Data protection:** a non-overridable deny-list blocks `.env*`, private keys,
  `.ssh/`, `.aws/`, `.npmrc`, credential/secret files, DB dumps, and backup
  archives from being uploaded. Path traversal outside `remotePath` is rejected.
- **Safety:** confirmation before full/overwrite syncs; atomic
  (temp-then-rename) uploads; single-flight lock.

## Out of scope

- Compromise of the user's own machine (malware running as the user can read
  any file the user can — including SSH keys and the OS keychain).
- Server-side confinement. Client-side path checks cannot constrain an
  over-privileged SSH account; harden the server (least-privilege user +
  `ChrootDirectory`/`internal-sftp`) as described in the README.

## Build & supply chain

- Dependencies are installed in CI with `npm ci --ignore-scripts` from the
  committed, integrity-pinned lockfile.
- `npm audit --omit=dev --audit-level=high` runs on every push and fails the
  build on known-vulnerable runtime dependencies.
- Marketplace publishing is gated behind a protected CI environment and a
  version tag; the `VSCE_PAT` is an encrypted secret, never logged.
- Each release publishes the **exact** `.vsix` that CI built, with a
  **SHA-256 checksum** and a **SLSA build-provenance attestation**. Verify a
  downloaded artifact with:
  ```bash
  sha256sum -c quicksync-sftp-<version>.vsix.sha256
  gh attestation verify quicksync-sftp-<version>.vsix --repo <owner>/<repo>
  ```
