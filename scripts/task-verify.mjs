import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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
      current?.log?.end();
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
      `  - Duration: ${result.durationMs ?? 'pending'}ms`,
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
  console.error(`Verification ${stage} failed; retained ${stagingDir}:`, error);
}
async function publish(summaryReady) {
  await mkdir(reportDir, { recursive: true });
  const summaryPath = path.join(reportDir, 'summary.md');
  if (!summaryReady) await rm(summaryPath, { force: true });
  try {
    await cp(stagingDir, reportDir, {
      recursive: true,
      filter: (source) =>
        summaryReady || source !== path.join(stagingDir, 'summary.md'),
    });
    return summaryReady;
  } catch (error) {
    publicationFailure(error, 'publication');
    // One unreadable file must not prevent independent evidence copying.
    await rm(summaryPath, { force: true });
    const names = (await readdir(stagingDir)).filter(
      (name) => name !== 'summary.md'
    );
    const outcomes = await Promise.allSettled(
      names.map((name) =>
        cp(path.join(stagingDir, name), path.join(reportDir, name), {
          recursive: true,
        })
      )
    );
    for (const outcome of outcomes)
      if (outcome.status === 'rejected')
        publicationFailure(outcome.reason, 'artifact copy');
    if (!outcomes.some((outcome) => outcome.status === 'fulfilled'))
      throw error;
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
      const complete = await publish(summaryReady);
      if (forced)
        throw new Error('Verification publication exceeded its deadline');
      if (revision !== publicationRevision) continue;
      if (complete) {
        published = true;
        console.log(
          `\nVerification report: ${path.join(reportDir, 'summary.md')}`
        );
        try {
          await rm(stagingDir, { recursive: true, force: true });
        } catch (error) {
          publicationFailure(error, 'staging removal');
        }
      } else {
        console.error(
          `Incomplete verification artifacts: ${reportDir}; retained staging: ${stagingDir}`
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
