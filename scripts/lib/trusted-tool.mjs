import { existsSync } from 'node:fs';
import path from 'node:path';

const TRUSTED_UNIX_TOOL_DIRECTORIES = [
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
  '/opt/homebrew/bin',
  '/usr/local/bin',
];

const TRUSTED_WINDOWS_TOOL_DIRECTORIES = [
  'C:\\Windows\\System32',
  'C:\\Program Files\\Git\\cmd',
  'C:\\Program Files\\Graphviz\\bin',
];

const TOOL_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export class TrustedToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TrustedToolError';
  }
}

const validateToolName = (toolName) => {
  if (
    !TOOL_NAME_PATTERN.test(toolName) ||
    toolName === '.' ||
    toolName === '..'
  ) {
    throw new TrustedToolError(`Invalid trusted tool name: ${toolName}`);
  }
};

const trustedToolDirectories = () =>
  process.platform === 'win32'
    ? TRUSTED_WINDOWS_TOOL_DIRECTORIES
    : TRUSTED_UNIX_TOOL_DIRECTORIES;

const executableNamesForSystemTool = (toolName) =>
  process.platform === 'win32' && !toolName.endsWith('.exe')
    ? [toolName, `${toolName}.exe`]
    : [toolName];

const executableNamesForProjectBin = (toolName) =>
  process.platform === 'win32'
    ? [`${toolName}.cmd`, `${toolName}.CMD`, `${toolName}.exe`, toolName]
    : [toolName];

export const resolveTrustedTool = (toolName) => {
  validateToolName(toolName);

  for (const directory of trustedToolDirectories()) {
    for (const executableName of executableNamesForSystemTool(toolName)) {
      const candidate = path.join(directory, executableName);
      if (existsSync(candidate)) return candidate;
    }
  }

  throw new TrustedToolError(
    `${toolName} was not found in trusted tool directories: ${trustedToolDirectories().join(
      ', '
    )}`
  );
};

export const resolveTrustedProjectBin = (toolName, cwd = process.cwd()) => {
  validateToolName(toolName);

  const binDirectory = path.resolve(cwd, 'node_modules', '.bin');
  for (const executableName of executableNamesForProjectBin(toolName)) {
    const candidate = path.join(binDirectory, executableName);
    if (existsSync(candidate)) return candidate;
  }

  throw new TrustedToolError(
    `${toolName} was not found in trusted project bin: ${binDirectory}`
  );
};
