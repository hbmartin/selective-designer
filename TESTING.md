# Testing Strategy

This project uses a layered test system. The default rule is to verify behavior at the cheapest layer that proves the contract, then add a higher layer only when the behavior crosses process, browser, persistence, or routing boundaries.

## Layer Map

| Layer | File pattern | Command | Contract |
| --- | --- | --- | --- |
| Property tests | `tests/unit/**/*.unit.spec.ts` using `@tests/support/property-testing` | `pnpm test:property` | Invariants over generated inputs for pure functions, state transitions, validators, and data mappers. |
| Unit tests | `tests/unit/**/*.unit.{test,spec}.{ts,tsx}` | `pnpm test:unit` | Business logic in isolation. Mock only true I/O boundaries such as DB, network, provider SDKs, clock, and generated IDs. |
| Browser component tests | `tests/browser/**/*.browser.{test,spec}.tsx` | `pnpm test:browser` | Component rendering and user interactions in Chromium through Vitest Browser. |
| Public workflow integration tests | `tests/integration/**/*.workflow.integration.test.ts` | `pnpm test:integration:workflow` | Sub-feature workflows through module public APIs only. No module-internal imports. Assert observable outputs and fake or real port side effects. |
| Adapter integration tests | Ordinary owner-specific `*.integration.test.*` specs under `tests/integration` | `pnpm test:integration <ordinary-file>` | Repository, webhook, SDK, and provider adapters against realistic local infrastructure such as PGlite. The `test:integration:adapters` alias selects only `infrastructure/__tests__` paths. |
| Native PostgreSQL integration | PostgreSQL-marked `*.postgres.integration.test.*` specs under `tests/integration` | `pnpm test:integration:postgres` (optionally `<postgres-file>`) | Real PostgreSQL migration, transaction, locking, and driver contracts using disposable Docker/Testcontainers databases. |
| E2E UI tests | `tests/e2e/*.spec.ts` | `pnpm test:e2e` or `pnpm test:e2e:chromium` | User-facing journeys from UI to rendered outcome. Assert durable side effects when the workflow writes data. |
| Visual regression | `tests/e2e/visual/*.visual.spec.ts` | `pnpm test:e2e:visual` | Stable critical screens with local Playwright snapshots. Baseline updates use `pnpm test:e2e:visual:update` and require review. |
| Coverage | Ordinary Vitest projects | `pnpm test:coverage` | Floor metric for touched code and trend signal in CI. Do not treat line coverage as proof of assertion quality. |
| Mutation testing | Stryker scoped configs | `pnpm test:mutation:critical` or scoped scripts | Test sensitivity for critical domain/application logic. Run periodically and for risky auth, authorization, and data-loss changes. |

`pnpm test` runs the full ordinary Vitest suite: unit, browser, architecture/security, and PGLite integration projects. Dedicated PostgreSQL tests use `pnpm test:integration:postgres` (Docker required); Playwright tests use `pnpm test:e2e`. Use the layer commands when you need a faster or more diagnostic signal. Focus ordinary specs with `pnpm test:integration <ordinary-file>` and native PostgreSQL specs with `pnpm test:integration:postgres <postgres-file>`; the ordinary command excludes PostgreSQL-marked specs.

## Functional Correctness

Property tests should target invariants that are easy to state and expensive to enumerate manually:

- Normalizers are idempotent and preserve the expected semantic value.
- Validators accept all generated valid values and reject generated invalid families.
- Authorization and policy predicates match their truth table for generated users, roles, and targets.
- Data mappers round-trip, preserve IDs, and do not leak provider-only fields.
- Pagination, cursor, and search helpers keep ordering and limits stable.

Use `PROPERTY_DEFAULTS` from `tests/support/property-testing.ts` so generated tests are reproducible locally and in CI. Prefer bounded generators over broad arbitrary objects; failures should shrink to useful examples.

Unit tests should cover the business rule directly from `tests/unit`. Fakes are preferred over mocks when they make the observable behavior clearer. Mock only I/O boundaries, time, generated IDs, or provider APIs.

## Integration

There are two intentional integration shapes:

- Public workflow integration tests exercise a module through `index.ts`, `server.ts`, `client.ts`, `presentation.ts`, or a test-only `testing.ts` gate when internals are intentionally part of the test setup. They are for sub-feature workflows and should not import `domain/`, `application/`, `infrastructure/`, `transport/`, or `factory.ts` directly. `pnpm check:test-layering` enforces this for `*.workflow.integration.test.ts`.
- Adapter integration tests live under `tests/integration` and may use owner `testing.ts` gates for the adapter internals they are proving. These tests assert on durable behavior: DB rows, emitted events, provider payloads, idempotency, pagination, and transaction effects.

Use PGlite for fast repository and module-level checks. For repository SQL or persistence behavior, raw SQL, schema serialization, migrations, database clients/drivers, or transaction/locking changes, also run `pnpm test:integration:postgres` (Docker required). Add or extend PostgreSQL coverage when PGlite cannot prove the contract. The dedicated suite runs its own `*.postgres.integration.test.*` specs; it does not repeat every ordinary repository test. Provider/webhook-only changes use focused adapter checks unless persistence is also affected. Use appropriate local infrastructure or Docker/Testcontainers for object-storage, queue, extension, or network contracts that PGlite cannot represent.

## End To End

E2E tests are for user-facing confidence, not for exhaustive branch coverage. Add or update E2E tests when a change touches routing, auth/session behavior, persistence from the UI, upload/download flows, or cross-module workflows that users depend on.

E2E assertions should use user-visible locators first, then verify the next rendered state. For write paths, also verify the durable side effect through a declared service contract, seeded database state, or test helper. Prepare state outside the UI unless the UI path itself is the behavior under test.

Visual tests should stay focused on stable critical screens. Do not approve snapshot changes without reviewing the rendered difference and the reason for the change.

## Quality Gates

Local development and agent work should usually run:

```bash
pnpm format:changed
pnpm check
pnpm test              # Full ordinary Vitest suite
```

`pnpm test:affected` remains a compatibility alias for `pnpm test`. It runs the full ordinary suite even with a clean working tree. Full-suite execution avoids missed tests from implicit setup dependencies, mock aliases, imported assets, and deleted files; dependency-cruiser remains an architecture check rather than a test selector.

`pnpm test:affected:list` uses native `vitest list --filesOnly` discovery and lists all ordinary test files as `[project] path` lines. Add `--json` for Vitest's array of objects with `file` (absolute path) and `projectName`. The previous selector's `--base`, `--summary`, custom `--verbose` behavior, and selection-report JSON are retired. Explicit Vitest filters remain available through the native commands.

The Coverage CI job runs the full ordinary suite, and the PostgreSQL Integration job runs the dedicated suite. There are no per-change PostgreSQL impact predictions. Neither `pnpm verify` nor `pnpm verify:task` automatically runs PostgreSQL tests; use the escalation rules below and retain `pnpm check:migrations` for schema or migration edits.

CodeQL is intentionally opt-in locally because the CLI is not a Node dependency. Use `pnpm codeql:test`, `pnpm codeql:db`, and `pnpm codeql:analyze` when changing `.github/codeql/**` or when investigating semantic security/data-flow behavior. These commands call the CodeQL CLI directly, install the local query pack dependencies first, and write outputs under `test-results/codeql/`.

Escalate based on touched surface:

| Change touches | Add |
| --- | --- |
| Pure domain policies, validators, or mappers | `pnpm test:property` and `pnpm test:unit` |
| Shared React components or forms | `pnpm test:browser` and browser inspection when layout changes |
| Repository SQL/persistence, schema serialization, migrations, drivers, transactions, locking | `pnpm test:integration <ordinary-file>` and `pnpm test:integration:postgres`; also `pnpm check:migrations` for schema/migration edits |
| Provider or webhook contracts without persistence changes | Focused `pnpm test:integration <ordinary-file>`; `test:integration:adapters` covers matching `infrastructure/__tests__` files only |
| Module workflows or public APIs | `pnpm test:integration:workflow` |
| Auth, routing, session, upload, or full-stack persistence | `pnpm test:e2e:chromium` |
| Critical screens or layout-heavy UI | `pnpm test:e2e:visual` |
| Framework config, env loading, production runtime, dependencies | `pnpm build` |
| Merge-level confidence | `pnpm verify` |

Mutation testing is intentionally slower. Use scoped commands during deep work, for example `pnpm test:mutation:auth:fast`, and run `pnpm test:mutation:critical` before high-risk merges or through the manually dispatched mutation-testing workflow.

## Review Checklist

- The test layer matches the risk: pure logic is not only covered by E2E, and browser-only behavior is not only covered by unit tests.
- Assertions prove observable behavior, not implementation details.
- Public workflow integration tests call only public module APIs.
- Adapter integration tests assert durable state or provider contract effects.
- Property tests have bounded, reproducible generators and clear invariant names.
- New architecture or security regressions have guardrails through depcruise, Semgrep, or `check:test-layering` where practical.

### Focused detection write recovery

`pnpm test:integration tests/integration/composition/image-detection-intent.integration.test.ts` checks rollback, retries, and commit reconciliation through the local test database driver. To exercise PostgreSQL server-raised faults, set `RECOVERY_TEST_DATABASE_URL` to a disposable direct loopback PostgreSQL database whose name starts with `selective_designer_recovery_test_`, then run the same command. The suite applies migrations and truncates that database. The loopback connection must not tunnel to a remote database. The default socket emulator uses driver-shaped failures around real transaction rollbacks because repeated server error responses are not supported reliably by its protocol bridge.
