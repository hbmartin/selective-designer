import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const sourceFileExtensions = new Set(['.css', '.ts', '.tsx']);
const emailThemeFile = path.join(
  'src',
  'modules',
  'email',
  'presentation',
  'theme.ts'
);
const allowedHardcodedColorFiles = new Set([
  emailThemeFile,
  path.join('src', 'platform', 'styles', 'app.css'),
]);

const rawTailwindColorUtilityPattern =
  /(?:^|[\s"'`:])((?:bg|text|border(?:-[trblxyse])?|ring|from|via|to|fill|stroke|decoration|outline)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(?:-\d{1,3})?(?:\/\d+)?)(?=$|[\s"'`:;,\]])/g;
const hardcodedHexColorPattern = /#[0-9A-Fa-f]{3,8}\b/g;

function listSourceFiles(target: string): string[] {
  if (!fs.existsSync(target)) return [];
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    return sourceFileExtensions.has(path.extname(target)) ? [target] : [];
  }

  return fs.readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(target, entry.name);
    if (entry.isDirectory()) return listSourceFiles(entryPath);
    return sourceFileExtensions.has(path.extname(entry.name))
      ? [entryPath]
      : [];
  });
}

function listModulePresentationFiles() {
  const modulesRoot = path.join(root, 'src', 'modules');
  return fs
    .readdirSync(modulesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      listSourceFiles(path.join(modulesRoot, entry.name, 'presentation'))
    );
}

function findMatches(
  files: string[],
  pattern: RegExp,
  isMatchAllowed: (relativeFile: string) => boolean = () => false
) {
  return files.flatMap((file) => {
    const relativeFile = path.relative(root, file);
    if (isMatchAllowed(relativeFile)) return [];

    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, index) => {
        pattern.lastIndex = 0;
        return Array.from(line.matchAll(pattern)).map((match) => {
          const value = match[1] ?? match[0];
          return `${relativeFile}:${index + 1}:${value}`;
        });
      });
  });
}

describe('design token usage', () => {
  const presentationFiles = [
    ...listSourceFiles(path.join(root, 'src', 'platform', 'components')),
    ...listSourceFiles(path.join(root, 'src', 'app')),
    ...listModulePresentationFiles(),
  ];

  it('keeps presentation color utilities semantic', () => {
    expect(
      findMatches(presentationFiles, rawTailwindColorUtilityPattern)
    ).toEqual([]);
  });

  it('keeps hardcoded presentation colors isolated to token files', () => {
    expect(
      findMatches(presentationFiles, hardcodedHexColorPattern, (relativeFile) =>
        allowedHardcodedColorFiles.has(relativeFile)
      )
    ).toEqual([]);
  });
});
