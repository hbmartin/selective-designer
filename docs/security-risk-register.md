# Security Risk Register

Last reviewed: 2026-11-02

## Temporary Accepted Dependency Advisories

As of 2026-11-02, `pnpm audit --audit-level=low --json` reports only low and
moderate advisories (high and critical are blocking and resolved through
upgrades or the scoped overrides in `pnpm-workspace.yaml`). The scoped
`@skidding/launch-editor` entry is not reported by `pnpm audit`, but is tracked
here because it follows the Windows UNC path handling risk shape of
`launch-editor` (GHSA-v6wh-96g9-6wx3).

| Package | Advisory | Current path | Decision | Next review |
| --- | --- | --- | --- | --- |
| `@skidding/launch-editor 2.13.2` | Related to GHSA-v6wh-96g9-6wx3: scoped launch-editor fork has the same Windows UNC path handling risk shape | `react-cosmos > @skidding/launch-editor` | Re-reviewed 2026-11-02: no patched release of the fork is published (latest is 2.13.2). Temporarily accepted because this is local Cosmos developer tooling and npm audit does not currently flag the scoped fork. Do not expose Cosmos/open-editor middleware to untrusted networks; replace or patch when a compatible fixed scoped package is available. | 2027-02-02 |

High-severity audit results remain blocking through `pnpm security:audit`.

## Accepted Pre-release Dependencies

Tracked here so the `scripts/check-risk-register.mjs` expiry gate forces a
periodic re-review even though `pnpm audit` reports no advisory for these.

| Package | Note | Current path | Decision | Next review |
| --- | --- | --- | --- | --- |
| `nitro` (`npm:nitro-nightly@3.0.1-20260501-164602-aee73f19`) | Pre-release dependency (no CVE). Nitro 3 server bundling for TanStack Start; no Nitro 3 GA stable is published upstream yet. | Build-time only — imported as `nitro/vite` in `vite.config.ts`; no runtime imports in `src/`. | Re-reviewed 2026-11-02: npm `latest` is still a release candidate (3.0.261102-rc), not GA. Accepted because the pin is exact and npm-sourced, the package is build-time only (no library/runtime surface ships to template consumers), and TanStack Start does not declare `nitro` as a peer dependency. Upgrade to a Nitro 3 GA release as soon as one is published. | 2027-02-02 |

## Resolved Previous Accepted Advisories

- `esbuild <= 0.24.2` via `drizzle-kit` and `@esbuild-kit/*` is no longer
  reported by the current audit after the lockfile override to
  `@esbuild-kit/core-utils>esbuild: 0.25.0`.
- `ws 8.19.0` via `react-cosmos` is no longer reported by the current audit
  after the lockfile override to `react-cosmos>ws: 8.21.0`.
- `qs 6.14.x/6.15.x` via `react-cosmos` and Stryker tooling is no longer
  reported by the current audit after the lockfile override to `qs: 6.15.2`.

## Implemented Controls

- Global TanStack Start middleware now sets report-only CSP, clickjacking, referrer, content-type, permissions-policy, and production HSTS headers.
- `/api/upload` now requires same-origin `Origin` on non-GET requests; Better Auth routes and the Resend webhook keep their provider-specific protection.
- TanStack Router/Start incident package versions and vulnerable TanStack floors are blocked by `scripts/check-tanstack-security.mjs`.
- CI installs dependencies with lifecycle scripts disabled, then explicitly runs trusted local build metadata generation.
