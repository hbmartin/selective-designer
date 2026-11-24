import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';

const args = new Set(process.argv.slice(2));
const runVisual = args.has('--visual');
const runChromiumE2e = args.has('--e2e-chromium');
const runBuild = args.has('--build');
const checkStep = process.env.CI
  ? { id: 'check-ci', command: 'pnpm', args: ['check:ci'] }
  : { id: 'check', command: 'pnpm', args: ['check'] };

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportDir = path.resolve('test-results', 'task-verification', timestamp);
const stagingDir = await mkdtemp(
  path.join(os.tmpdir(), 'selective-designer-verification-')
);
console.log(`Verification staging: ${stagingDir}`);

const steps = [
  {
    id: 'format-changed',
    command: 'pnpm',
    args: ['format:changed'],
  },
  checkStep,
  {
    id: 'test',
    command: 'pnpm',
    args: ['test'],
  },
  ...(runVisual
    ? [
        {
          id: 'visual',
          command: 'pnpm',
          args: ['test:visual'],
        },
      ]
    : []),
  ...(runChromiumE2e
    ? [
        {
          id: 'e2e-chromium',
          command: 'pnpm',
          args: ['test:e2e:chromium'],
        },
      ]
    : []),
  ...(runBuild
    ? [
        {
          id: 'build',
          command: 'pnpm',
          args: ['build'],
        },
      ]
    : []),
];

const formatCommand = ({ command, args }) =>
  [command, ...args]
    .map((part) => (part.includes(' ') ? `"${part}"` : part))
    .join(' ');

let current;
let interruptedSignal;
let knownFailure;
const initialFailure = process.exitCode || undefined;
let terminalTimer;
let interruptionSummary;
let summaryWrites = Promise.resolve();
let publicationRevision = 0;
let acceptedPublication;
const publicationFailures = new Set();
let originalDestinationStale = false;
let recoveryAllocation;
let ownedRecoveryDirectory;
let forced = false;
const interrupted = Promise.withResolvers();
const results = [];

function failureStatus() {
  return initialFailure ?? knownFailure ?? (process.exitCode || undefined);
}
function exitStatus() {
  return (
    failureStatus() ??
    (interruptedSignal === 'SIGINT' ? 130 : interruptedSignal ? 143 : 1)
  );
}
function armDeadline() {
  terminalTimer ??= setTimeout(() => {
    forced = true;
    try {
      if (!current?.closed) current?.child?.kill('SIGKILL');
      current?.log?.end();
    } finally {
      const attemptedDirectory = acceptedPublication
        ? acceptedPublication.directory
        : ownedRecoveryDirectory;
      const destination =
        acceptedPublication?.type === 'complete'
          ? `report ${path.join(reportDir, 'summary.md')}`
          : acceptedPublication?.type === 'incomplete'
            ? `incomplete artifacts ${acceptedPublication.directory}; retained ${stagingDir}`
            : `retained ${stagingDir}${attemptedDirectory ? `; attempted destination: ${attemptedDirectory}` : ''}`;
      console.error(
        `Verification finalization exceeded ten seconds; ${destination}`
      );
      process.exit(exitStatus());
    }
  }, 10_000);
}
function stopCurrent(signal) {
  try {
    if (!current?.closed) current?.child?.kill(signal);
  } catch (error) {
    console.error('Verification child interruption failed:', error);
  }
}
function onSignal(signal) {
  if (interruptedSignal) return;
  if (acceptedPublication) {
    armDeadline();
    return;
  }
  interruptedSignal = signal;
  publicationRevision++;
  armDeadline();
  stopCurrent(signal);
  interruptionSummary = queueSummary('partial-summary.md').catch((error) => {
    console.error('Verification partial summary failed:', error);
  });
  interrupted.resolve();
}
const onSigint = () => onSignal('SIGINT');
const onSigterm = () => onSignal('SIGTERM');
process.on('SIGINT', onSigint);
process.on('SIGTERM', onSigterm);

function rememberFailure(code) {
  if (!interruptedSignal && code !== 0) knownFailure ??= code ?? 1;
}
function stepFailure(state, error) {
  if (state.failures.has(error)) return;
  state.failures.add(error);
  state.entry.failures.push(
    error instanceof Error ? error.message : String(error)
  );
  rememberFailure(1);
}
function runStep(step) {
  const startedAt = new Date();
  const logPath = path.join(reportDir, `${step.id}.log`);
  const entry = {
    ...step,
    startedAt,
    logPath,
    code: null,
    signal: null,
    failures: [],
  };
  // Attempt records do not depend on successful spawning or log completion.
  results.push(entry);
  const result = Promise.withResolvers();
  const closure = Promise.withResolvers();
  void result.promise.catch(() => {});
  const state = {
    log: undefined,
    logged: Promise.resolve(),
    promise: result.promise,
    closure: closure.promise,
    closed: false,
    child: undefined,
    step,
    startedAt,
    logPath,
    entry,
    failures: new Set(),
  };
  function finish(code, signal) {
    state.closed = true;
    entry.code = code;
    entry.signal = signal;
    entry.finishedAt = new Date();
    entry.durationMs = entry.finishedAt.getTime() - startedAt.getTime();
    rememberFailure(code);
    closure.resolve();
  }
  try {
    const log = createWriteStream(path.join(stagingDir, `${step.id}.log`), {
      flags: 'a',
    });
    state.log = log;
    state.logged = finished(log);
    void state.logged.catch(() => {});
    log.once('error', (error) => {
      stepFailure(state, error);
      result.reject(error);
    });
    log.write(`$ ${formatCommand(step)}\n\n`);
    console.log(`\n$ ${formatCommand(step)}`);
    state.child = spawn(step.command, step.args, {
      env: process.env,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const child = state.child;
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      if (!log.destroyed && !log.writableEnded) log.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      if (!log.destroyed && !log.writableEnded) log.write(chunk);
    });
    child.on('error', (error) => {
      stepFailure(state, error);
      console.error(error.message);
      if (!log.destroyed && !log.writableEnded) log.write(`${error.message}\n`);
    });
    child.on('close', (code, signal) => {
      finish(code, signal);
      if (!log.destroyed && !log.writableEnded)
        log.end(
          `\nexitCode=${code ?? 'null'} signal=${signal ?? 'null'} durationMs=${entry.durationMs}\n`
        );
      void state.logged.then(() => result.resolve(entry), result.reject);
    });
  } catch (error) {
    stepFailure(state, error);
    finish(null, null);
    if (state.log && !state.log.destroyed && !state.log.writableEnded)
      state.log.end(`${String(error)}\n`);
    result.reject(error);
  }
  return state;
}

async function writeSummary(filename) {
  const failed = results.some(
    (result) =>
      result.failures.length || (result.finishedAt && result.code !== 0)
  );
  const status = failureStatus()
    ? 'failed'
    : interruptedSignal
      ? 'interrupted'
      : failed
        ? 'failed'
        : 'passed';
  const lines = [
    '# Task Verification Report',
    '',
    `- Started: ${results[0]?.startedAt.toISOString() ?? new Date().toISOString()}`,
    `- Finished: ${new Date().toISOString()}`,
    `- Status: ${status}`,
    `- Directory: ${reportDir}`,
    ...(interruptedSignal ? [`- Interrupted: ${interruptedSignal}`] : []),
    '',
    '## Steps',
    '',
    ...results.flatMap((result) => [
      `- ${!result.finishedAt ? 'INCOMPLETE' : result.code === 0 && result.failures.length === 0 ? 'PASS' : 'FAIL'} \`${formatCommand(result)}\``,
      `  - Duration: ${result.durationMs === undefined ? 'pending' : `${result.durationMs}ms`}`,
      `  - Log: ${path.relative(process.cwd(), result.logPath)}`,
      `  - Exit: ${result.code ?? 'null'}; signal: ${result.signal ?? 'null'}`,
      ...result.failures.map((failure) => `  - Diagnostic: ${failure}`),
    ]),
    ...(current && !current.closed
      ? [
          '- Child exit or output closure remains unconfirmed; staging retained.',
        ]
      : []),
    '',
    '## Artifact Conventions',
    '',
    '- Playwright traces, screenshots, and videos remain under `test-results/`.',
    '- This report directory stores the command logs for the task verification run.',
    '- If a command fails, inspect the step log first, then the linked Playwright artifacts.',
    '',
  ];
  await writeFile(path.join(stagingDir, filename), lines.join('\n'));
}
function queueSummary(filename = 'summary.md') {
  const writing = summaryWrites.then(() => writeSummary(filename));
  // A failed earlier write is observed, but does not poison the next writer.
  summaryWrites = writing.catch(() => {});
  return writing;
}
function publicationFailure(error, stage) {
  rememberFailure(1);
  if (publicationFailures.has(error)) return;
  publicationFailures.add(error);
  console.error(`Verification ${stage} failed; retained ${stagingDir}:`, error);
}
async function recoverArtifacts() {
  const summaryPath = path.join(reportDir, 'summary.md');
  if (!originalDestinationStale) {
    try {
      await rm(summaryPath, { force: true });
    } catch (error) {
      originalDestinationStale = true;
      publicationFailure(error, 'summary removal');
      console.error(`Stale/untrusted verification destination: ${summaryPath}`);
    }
  }
  let directory = reportDir;
  if (originalDestinationStale) {
    try {
      recoveryAllocation ??= (async () => {
        const allocated = await mkdtemp(
          path.join(path.dirname(reportDir), `${timestamp}-incomplete-`)
        );
        ownedRecoveryDirectory = allocated;
        try {
          const ordinary = await stat(reportDir);
          if (!ordinary.isDirectory())
            throw new Error(
              'Verification report destination is not a directory'
            );
          const mode = 0o700 | (ordinary.mode & 0o3075);
          await chmod(allocated, mode);
          const recovery = await stat(allocated);
          const actualMode = recovery.mode & 0o7777;
          const clearedSetgid =
            (mode & 0o2000) !== 0 &&
            actualMode === (mode & ~0o2000) &&
            recovery.gid === ordinary.gid;
          if (
            !recovery.isDirectory() ||
            (actualMode !== mode && !clearedSetgid)
          )
            throw new Error(
              'Verification recovery directory permissions do not match the requested mode and group'
            );
        } catch (error) {
          publicationFailure(error, 'recovery permissions');
          throw error;
        }
        return allocated;
      })();
      directory = await recoveryAllocation;
    } catch (error) {
      publicationFailure(error, 'recovery allocation');
      return { type: 'retained_only', directory: ownedRecoveryDirectory };
    }
  }
  let names;
  try {
    names = (await readdir(stagingDir)).filter(
      (name) => name !== 'summary.md' && name !== 'partial-summary.md'
    );
  } catch (error) {
    publicationFailure(error, 'artifact listing');
    return { type: 'retained_only', directory };
  }
  const outcomes = await Promise.allSettled(
    names.map((name) =>
      Promise.resolve().then(() =>
        cp(path.join(stagingDir, name), path.join(directory, name), {
          recursive: true,
        })
      )
    )
  );
  for (const outcome of outcomes)
    if (outcome.status === 'rejected')
      publicationFailure(outcome.reason, 'artifact copy');
  return outcomes.some((outcome) => outcome.status === 'fulfilled')
    ? { type: 'incomplete', directory }
    : { type: 'retained_only', directory };
}
async function publish(summaryReady) {
  try {
    await mkdir(reportDir, { recursive: true });
    if (summaryReady && !originalDestinationStale) {
      await cp(stagingDir, reportDir, {
        recursive: true,
        filter: (source) =>
          source !== path.join(stagingDir, 'partial-summary.md'),
      });
      return { type: 'complete', directory: reportDir };
    }
  } catch (error) {
    publicationFailure(error, 'publication');
  }
  // Recovery has one boundary. A rejection here must not re-enter recovery.
  try {
    return await recoverArtifacts();
  } catch (error) {
    publicationFailure(error, 'recovery');
    return {
      type: 'retained_only',
      directory: ownedRecoveryDirectory ?? reportDir,
    };
  }
}
async function removeEmptyRecoveryDirectory() {
  if (!ownedRecoveryDirectory || forced) return false;
  try {
    const names = await readdir(ownedRecoveryDirectory);
    if (names.length || forced) return false;
    // Nonrecursive removal preserves any partial data or a racing writer.
    await rmdir(ownedRecoveryDirectory);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    publicationFailure(error, 'recovery cleanup');
    return false;
  }
}
async function finalize() {
  try {
    if (current && !current.closed) {
      armDeadline();
      if (!interruptedSignal) stopCurrent('SIGTERM');
    }
    if (current) {
      await current.closure;
      try {
        await current.promise;
      } catch (error) {
        console.error('Verification step finalization failed:', error);
      }
      try {
        await current.logged;
      } catch (error) {
        stepFailure(current, error);
      }
    }
    while (true) {
      const revision = publicationRevision;
      await interruptionSummary;
      let summaryReady = false;
      try {
        await queueSummary();
        summaryReady = true;
      } catch (error) {
        publicationFailure(error, 'summary');
      }
      if (forced)
        throw new Error(
          'Verification finalization already exceeded its deadline'
        );
      const outcome = await publish(summaryReady);
      if (forced)
        throw new Error('Verification publication exceeded its deadline');
      if (revision !== publicationRevision) continue;
      acceptedPublication = outcome;
      if (outcome.type === 'retained_only') {
        const removed = await removeEmptyRecoveryDirectory();
        if (forced)
          throw new Error(
            'Verification recovery cleanup exceeded its deadline'
          );
        if (removed && outcome.directory === ownedRecoveryDirectory)
          outcome.directory = undefined;
      }
      if (outcome.type === 'complete') {
        console.log(
          `\nVerification report: ${path.join(reportDir, 'summary.md')}`
        );
        try {
          await rm(stagingDir, { recursive: true, force: true });
        } catch (error) {
          publicationFailure(error, 'staging removal');
        }
      } else if (outcome.type === 'incomplete') {
        console.error(
          `Incomplete verification artifacts: ${outcome.directory}; retained staging: ${stagingDir}`
        );
      } else {
        console.error(
          `Verification artifacts remain unpublished; retained staging: ${stagingDir}${outcome.directory ? `; attempted destination: ${outcome.directory}` : ''}`
        );
      }
      break;
    }
  } catch (error) {
    publicationFailure(error, 'publication');
  } finally {
    if (interruptedSignal) process.exitCode = exitStatus();
    else if (failureStatus()) process.exitCode = failureStatus();
    await Promise.all(
      [process.stdout, process.stderr].map(
        (stream) => new Promise((resolve) => stream.write('', resolve))
      )
    );
    clearTimeout(terminalTimer);
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}

try {
  for (const step of steps) {
    if (interruptedSignal) break;
    current = runStep(step);
    const result = await Promise.race([current.promise, interrupted.promise]);
    if (!result || result.code !== 0 || result.failures.length) break;
  }
} catch (error) {
  rememberFailure(1);
  console.error('Task verification failed:', error);
} finally {
  await finalize();
}
