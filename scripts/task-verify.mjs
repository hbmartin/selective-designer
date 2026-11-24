import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
let publicationRevision = 0;
let published = false;
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
      current?.log.end();
    } finally {
      console.error(
        `Verification finalization exceeded ten seconds; ${published ? `report ${path.join(reportDir, 'summary.md')}` : `retained ${stagingDir}`}`
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
  if (published) {
    armDeadline();
    return;
  }
  interruptedSignal = signal;
  publicationRevision++;
  armDeadline();
  stopCurrent(signal);
  interruptionSummary = writeSummary();
  void interruptionSummary.catch((error) =>
    console.error('Verification partial summary failed:', error)
  );
  interrupted.resolve();
}
const onSigint = () => onSignal('SIGINT');
const onSigterm = () => onSignal('SIGTERM');
process.on('SIGINT', onSigint);
process.on('SIGTERM', onSigterm);

function rememberFailure(code) {
  if (!interruptedSignal && code !== 0) knownFailure ??= code ?? 1;
}
function runStep(step) {
  const startedAt = new Date();
  const logPath = path.join(reportDir, `${step.id}.log`);
  const log = createWriteStream(path.join(stagingDir, `${step.id}.log`), {
    flags: 'a',
  });
  const logged = finished(log);
  void logged.catch(() => {});
  const result = Promise.withResolvers();
  const closure = Promise.withResolvers();
  void result.promise.catch(() => {});
  const state = {
    log,
    logged,
    promise: result.promise,
    closure: closure.promise,
    closed: false,
    child: undefined,
    step,
    startedAt,
    logPath,
  };
  log.once('error', (error) => {
    rememberFailure(1);
    result.reject(error);
  });
  log.write(`$ ${formatCommand(step)}\n\n`);
  console.log(`\n$ ${formatCommand(step)}`);
  try {
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
      rememberFailure(1);
      console.error(error.message);
      if (!log.destroyed && !log.writableEnded) log.write(`${error.message}\n`);
    });
    child.on('close', (code, signal) => {
      state.closed = true;
      closure.resolve();
      rememberFailure(code);
      const finishedAt = new Date();
      const entry = {
        ...step,
        code,
        signal,
        startedAt,
        finishedAt,
        logPath,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      };
      state.entry = entry;
      if (!log.writableEnded)
        log.end(
          `\nexitCode=${code ?? 'null'} signal=${signal ?? 'null'} durationMs=${entry.durationMs}\n`
        );
      void logged.then(() => result.resolve(entry), result.reject);
    });
  } catch (error) {
    state.closed = true;
    closure.resolve();
    rememberFailure(1);
    log.end(`${String(error)}\n`);
    result.reject(error);
  }
  return state;
}

async function writeSummary() {
  const failed = results.find((result) => result.code !== 0);
  const status = interruptedSignal
    ? 'interrupted'
    : failed || failureStatus()
      ? 'failed'
      : 'passed';
  const lines = [
    '# Task Verification Report',
    '',
    `- Started: ${results[0]?.startedAt.toISOString() ?? current?.startedAt.toISOString() ?? new Date().toISOString()}`,
    `- Finished: ${new Date().toISOString()}`,
    `- Status: ${status}`,
    `- Directory: ${reportDir}`,
    ...(interruptedSignal ? [`- Interrupted: ${interruptedSignal}`] : []),
    '',
    '## Steps',
    '',
    ...results.flatMap((result) => [
      `- ${result.code === 0 ? 'PASS' : 'FAIL'} \`${formatCommand(result)}\``,
      `  - Duration: ${result.durationMs}ms`,
      `  - Log: ${path.relative(process.cwd(), result.logPath)}`,
      `  - Exit: ${result.code ?? 'null'}; signal: ${result.signal ?? 'null'}`,
    ]),
    ...(current && !current.closed
      ? [
          `- INCOMPLETE \`${formatCommand(current.step)}\``,
          '  - Child exit or output closure remains unconfirmed; staging retained.',
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
  await writeFile(path.join(stagingDir, 'summary.md'), lines.join('\n'));
}

async function finalize() {
  try {
    if (current && !current.closed) {
      // A log failure may precede child closure. Use the same bounded finalizer.
      armDeadline();
      if (!interruptedSignal) stopCurrent('SIGTERM');
    }
    if (current) {
      await current.closure;
      try {
        const result = await current.promise;
        if (!results.includes(result)) results.push(result);
      } catch (error) {
        console.error('Verification step finalization failed:', error);
      }
      await current.logged;
    }
    while (true) {
      const revision = publicationRevision;
      await interruptionSummary;
      await writeSummary();
      if (forced)
        throw new Error(
          'Verification finalization already exceeded its deadline'
        );
      await mkdir(reportDir, { recursive: true });
      await cp(stagingDir, reportDir, { recursive: true });
      if (forced)
        throw new Error('Verification publication exceeded its deadline');
      if (revision === publicationRevision) break;
    }
    published = true;
    console.log(`\nVerification report: ${path.join(reportDir, 'summary.md')}`);
    try {
      await rm(stagingDir, { recursive: true, force: true });
    } catch (error) {
      if (!interruptedSignal) knownFailure ??= 1;
      console.error(
        `Verification staging removal failed; published ${reportDir}:`,
        error
      );
    }
  } catch (error) {
    if (!interruptedSignal) knownFailure ??= 1;
    console.error(
      `Verification publication failed; retained ${stagingDir}:`,
      error
    );
  } finally {
    if (interruptedSignal) process.exitCode = exitStatus();
    else if (failureStatus()) process.exitCode = failureStatus();
    // Retain signal ownership through the final output flush.
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
    if (!result) break;
    results.push(result);
    if (result.code !== 0) break;
  }
} catch (error) {
  rememberFailure(1);
  console.error('Task verification failed:', error);
} finally {
  await finalize();
}
