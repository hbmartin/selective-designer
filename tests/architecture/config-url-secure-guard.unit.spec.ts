import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * I2 regression guardrail.
 *
 * Every kernel config module that introduces a URL env field (a Zod `z.url()`
 * or `.url()` validator) must also reference one of the secure-URL guards, so a
 * future edit cannot land a new URL field that silently accepts a cleartext /
 * unauthenticated endpoint in production.
 *
 * This is a deliberately coarse, file-level heuristic kept robust against false
 * positives: it only fires when a config file declares a URL field but
 * references NO secure-URL guard anywhere in the same file. The exact
 * production rejection behaviour is covered by the url-security and
 * config-accessors unit specs.
 */
const CONFIG_DIR = path.resolve(
  process.cwd(),
  'src/modules/kernel/infrastructure/config'
);

// Matches the Zod URL validators `z.url(` and `z.string().url(`. A leading dot
// is required so `new URL(` and identifiers like `...TelemetryUrl(` never match.
const URL_FIELD_PATTERN = /\.url\s*\(/;

// Any one of these secure-URL guards satisfies the requirement.
const SECURE_URL_GUARD_PATTERN =
  /assertSecureUrlInProduction|isSecureUrlForProduction|assertDatabaseUrlTls|secureUrl/;

const listConfigFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listConfigFiles(entryPath);
    if (!entry.isFile()) return [];
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.unit.spec.ts')) {
      return [];
    }
    return [path.relative(CONFIG_DIR, entryPath)];
  });

const configFiles = listConfigFiles(CONFIG_DIR);

const declaresUrlField = (name: string) =>
  URL_FIELD_PATTERN.test(readFileSync(path.join(CONFIG_DIR, name), 'utf8'));

const urlConfigFiles = configFiles.filter(declaresUrlField);

describe('kernel config URL fields are HTTPS-guarded (I2)', () => {
  it('discovers kernel config modules to scan', () => {
    expect(configFiles.length).toBeGreaterThan(0);
  });

  it.each(urlConfigFiles)('%s references a secure-URL guard', (name) => {
    const source = readFileSync(path.join(CONFIG_DIR, name), 'utf8');
    expect(SECURE_URL_GUARD_PATTERN.test(source)).toBe(true);
  });

  it('still detects the known URL-bearing config modules', () => {
    // Fails loudly if the URL-field detector regex ever stops matching, which
    // would otherwise turn the guardrail above into a silent no-op.
    expect(urlConfigFiles).toEqual(
      expect.arrayContaining(['database.ts', 'redis.ts', 'telemetry.ts'])
    );
  });
});
