### Current Implementation Status

This document is a high-level practices reference. Current accepted dependency
risks and implemented TanStack Start hardening controls are tracked in
`docs/security-risk-register.md`.

### Input Validation

- **Zod schemas** at HTTP boundaries for incoming payloads (i.e. webhooks) — no unvalidated external input reaches business logic
- Parameterized queries are the default path, with guardrails to detect unsafe raw SQL usage
- LIKE pattern escaping utility for search queries
- Branded types for phone numbers (E.164), emails, IDs — preventing type confusion at compile time

### Security Scanning & SAST

The repository's workflows and configuration define the active controls:

| Scanner | Scope | Integration |
| --- | --- | --- |
| Semgrep | Public gates, SDK confinement, application error/time boundaries, secret logging, redirect and SQL guardrails | [Workflow](../.github/workflows/semgrep.yml) and [`pnpm semgrep` configuration](../.semgrep.yml); SARIF retained as an Actions artifact |
| CodeQL | JavaScript/TypeScript and GitHub Actions analysis | [Workflow](../.github/workflows/codeql.yml), Security results, and retained SARIF artifacts |
| Dependency-cruiser | Module boundaries, cycles, public gates, and SDK ownership | [`pnpm depcruise` rules](../.dependency-cruiser.cjs) in Code Quality |
| Dependency audit and policy | High-severity pnpm audit, TanStack lockfile policy, license compliance, and accepted-risk review | `pnpm security:audit`; [risk register](security-risk-register.md) |
| GitHub Dependency Review | Dependency changes at moderate severity and above | [Pull-request workflow](../.github/workflows/dependency-review.yml) |
| OSV Scanner | Dependency vulnerabilities in PR diffs and full scans | [PR workflow](../.github/workflows/osv-scanner.yml) and [full-scan workflow](../.github/workflows/osv-scanner-full.yml), with Security integration |
| detect-secrets | Committed files checked against the reviewed baseline | [Workflow](../.github/workflows/detect-secrets.yml) and [baseline](../.secrets.baseline) |

Sheriff remains an explicit local command (`pnpm lint:sheriff`, [configuration](../sheriff.config.ts)); it is not part of `check`, `verify`, or CI. jscpd is configured for manual use; there is no `pnpm dupes` script or duplication gate in CI.

### SOC 2 Readiness

While a formal SOC 2 audit has not yet been completed, the codebase implements controls aligned with SOC 2 trust service criteria:

- **Security**: RBAC, encryption at rest/in transit, brute-force protection, CSRF, CSP
- **Availability**: Vercel's managed infrastructure, automated migration rollback alerts, Pushover on-call notifications
- **Processing Integrity**: webhook idempotency, domain error model, transactional consistency
- **Confidentiality**: PII masking in logs, branded types preventing accidental exposure, Zod-validated boundaries
- **Privacy**: data classification by table, access controls per permission scope

### CI Pipeline

[Code Quality](../.github/workflows/code-quality.yml) runs on main pushes and ready pull requests. Its jobs cover formatting, Oxlint/ESLint/typechecking, dependency-cruiser and architecture checks, dependency policies, migration integrity, the ordinary suite with coverage, dedicated PostgreSQL integration, and production builds.

The Coverage and PostgreSQL Integration jobs require JUnit reports and check that tests leave tracked worktree and staged files unchanged. Report and mutation checks run after attempted tests, including failures; artifact uploads remain enabled on failure. LCOV is required after successful coverage runs.

Security scanning uses the dedicated workflows linked above. Trigger policies differ: Dependency Review and OSV diff scanning are PR-specific. CodeQL also runs on main pushes and a schedule; Semgrep also supports main pushes, scheduled runs, and manual dispatch; detect-secrets also runs on main pushes and manual dispatch. Most PR jobs skip drafts. [Supply Chain Artifacts](../.github/workflows/supply-chain.yml) generates audit, SBOM, and provenance artifacts on main pushes or manual dispatch.

Coverage is generated locally and in CI via `pnpm test:coverage` (Vitest + V8). `pnpm test:affected` is a compatibility alias for the full ordinary suite, with no dependency-based selection. Dependency-cruiser enforces architecture boundaries. Dedicated PostgreSQL and Playwright suites use separate commands; see [Testing Strategy](../TESTING.md) for escalation guidance.

### Testing Strategy

| Test type | Framework | Purpose |
| --- | --- | --- |
| Unit | Vitest | Domain and application behavior in isolation |
| Integration | Vitest + PGlite | Repository and workflow behavior against a local PostgreSQL-compatible driver |
| Native PostgreSQL | Vitest + Testcontainers | Migrations, driver behavior, transactions, and locking against disposable PostgreSQL |
| Component | Vitest Browser + Playwright + `vitest-browser-react` | Real Chromium component interactions |
| E2E and visual | Playwright | Full-stack journeys and reviewed local screenshot baselines |
| Architecture | Vitest + dependency-cruiser + Semgrep | Module boundaries, SDK confinement, and structural guardrails |
| Property | fast-check + Vitest | Generated invariant and boundary checks |
| Mutation | Stryker | Scoped test sensitivity for account, auth, runtime configuration, user, kernel, and shared code; the manual CI matrix covers auth, kernel, user, and shared |

### Code Quality Enforcement

- [Oxfmt](../package.json) checks formatting through `pnpm format:check`.
- [Oxlint](../.oxlintrc.json) and [ESLint](../eslint.config.mjs) provide lint rules through `pnpm lint` and `pnpm lint:eslint`. The commands do not globally treat warnings as errors; severity is defined in configuration.
- TypeScript checks types through `pnpm typecheck`.
- [Knip](../knip.jsonc) checks dependencies and unlisted dependencies through `pnpm knip:deps`.
- [Dependabot](../.github/dependabot.yml) proposes dependency updates for npm, GitHub Actions, and Docker.

## Disaster Recovery & Business Continuity

### Operational Resilience

- Database migrations: pre-validated before execution; failures trigger automatic GitHub issue creation and Pushover on-call alert with commit SHA, branch, and run URL
- Webhook idempotency: all webhook handlers (Stripe, Twilio, Resend) are idempotent — replayed events produce no side effects
- Fail-closed security: authentication lockout returns 60-second retry-after on backend failures rather than allowing access
- Graceful degradation: cache failures don't break functionality (cache-aside pattern); Edge Config failures return safe defaults; rate limiter fails open with logged anomaly
- Automated alerting: critical domain events, auth lockouts, webhook signature failures, and migration results all push to on-call via Pushover

### Deployment Safety

- Preview deployments: every PR gets an isolated environment via Vercel's Git integration
- Automated testing: the Coverage CI job runs the full ordinary Vitest suite, and PostgreSQL Integration runs the dedicated database tests; local verification uses the same ordinary suite
- Architectural guardrails: dependency-cruiser rules, architecture tests, and Semgrep enforce the configured structural boundaries
- Security scanning: the dedicated Semgrep, CodeQL, OSV, Dependency Review, and detect-secrets workflows complement the Code Quality dependency policies; result destinations are described above
- Dependabot: automated update PRs cover the npm, GitHub Actions, and Docker ecosystems configured in `.github/dependabot.yml`
- Migration safety: separate `db-migrate.yml` workflow runs schema-drift, file, journal, snapshot, and dry-apply validation before executing migrations, with Pushover alerts on failure
