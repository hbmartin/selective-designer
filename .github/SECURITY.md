# Security Policy

`start-ui-web` is an open-source starter that many projects build on, so we
take the integrity of this template and its supply chain seriously.

## Supported Versions

Security fixes are provided for the latest released major version on the
`main` branch. Older majors are not maintained — upgrade to the latest release
to receive security updates.

| Version | Supported          |
| ------- | ------------------ |
| 4.x     | :white_check_mark: |
| < 4.0   | :x:                |

## Reporting a Vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through GitHub's coordinated disclosure flow:

1. Go to the repository's **Security** tab → **Report a vulnerability**
   (GitHub Private Vulnerability Reporting), or open
   <https://github.com/hbmartin/start-ui-web/security/advisories/new>.
2. Include affected version/commit, reproduction steps, impact, and any PoC.

If you cannot use GitHub advisories, contact the maintainer listed in
[`CODEOWNERS`](./CODEOWNERS).

### What to expect

- **Acknowledgement:** within 5 business days.
- **Triage & severity assessment:** within 10 business days.
- **Fix / mitigation:** prioritized by severity; we will coordinate a
  disclosure timeline and credit reporters who wish to be named.

Please give us a reasonable window to remediate before any public disclosure.

## Scope

In scope: code in this repository and its build/release pipeline
(`.github/workflows`, dependency manifests, CI configuration).

Out of scope: vulnerabilities in third-party dependencies that are already
public — these are tracked via Dependabot, OSV Scanner, `pnpm audit`, and
[`docs/security-risk-register.md`](../docs/security-risk-register.md). Report
those upstream; if this repo needs to pin or override around one, note it in
the risk register.

## Supply-chain controls

This repository enforces a layered supply-chain posture (OWASP A09:2025).
A summary lives in [`docs/security practices.md`](../docs/security%20practices.md);
accepted/temporary risks are tracked in
[`docs/security-risk-register.md`](../docs/security-risk-register.md). Key
controls:

- All GitHub Actions are pinned by commit SHA; CI installs with
  `--frozen-lockfile --ignore-scripts`.
- `pnpm-workspace.yaml` enforces `minimumReleaseAge` and an explicit
  build-script allowlist.
- Continuous scanning: OSV Scanner, `dependency-review`, CodeQL, Semgrep,
  detect-secrets, `pnpm audit` (high+ blocking), a license-compliance gate
  (`pnpm security:licenses`), and a TanStack incident blocklist
  (`pnpm security:tanstack`).
- An SPDX SBOM and `pnpm audit` report are generated and signed with build
  provenance on every push to `main`.

### Verifying release artifacts

The SBOM and audit report published from `main` carry signed build
provenance. Verify them with the GitHub CLI:

```bash
gh attestation verify sbom.spdx.json --repo hbmartin/start-ui-web
```
