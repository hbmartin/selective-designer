import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const sourceExtensions = new Set(['.ts', '.tsx']);
const forbiddenValidationHelpers = [
  'isAccountNameValid',
  'isTrackedEmailEvent',
] as const;

const identifierPattern = (identifier: string) =>
  new RegExp(`\\b${identifier}\\b`, 'u');

function listSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(entryPath);
    return sourceExtensions.has(path.extname(entry.name)) ? [entryPath] : [];
  });
}

describe('parser guardrails', () => {
  it('keeps validation-only helpers replaced by Result-returning parsers', () => {
    const violations = listSourceFiles(path.join(root, 'src')).flatMap(
      (file) => {
        const source = fs.readFileSync(file, 'utf8');
        return forbiddenValidationHelpers
          .filter((helper) => identifierPattern(helper).test(source))
          .map((helper) => `${path.relative(root, file)}:${helper}`);
      }
    );

    expect(violations).toEqual([]);
  });
});
