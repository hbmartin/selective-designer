import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectFixtureProcesses } from './fixture-process-snapshot.mjs';
import {
  FIXTURE_PROTOCOL_VERSION,
  readSupervisorControl,
  serializeFixtureError,
} from './fixture-command-protocol.mjs';

/** Fixed trusted bootstrap. Tests inject Node I/O; workloads receive no IPC fd. */
export function runFixtureCommandSupervisor({
  ipc = process,
  spawnTarget = spawn,
  inspect = inspectFixtureProcesses,
} = {}) {
  const nonce = ipc.argv[2];
  let released = false;
  let terminal = false;
  let failed = false;
  let retirePending = false;
  const send = (message, done = () => {}) => {
    if (!ipc.connected) {
      done();
      return;
    }
    try {
      ipc.send(
        { version: FIXTURE_PROTOCOL_VERSION, nonce, ...message },
        (error) => {
          if (error) failed = true;
          done();
        }
      );
    } catch {
      failed = true;
      done();
    }
  };
  const retire = () => {
    if (!terminal || retirePending) return;
    retirePending = true;
    send({ type: 'retired' }, () => ipc.exit(0));
  };
  // This guard precedes inspection and every possible workload launch.
  ipc.on('disconnect', () => {
    if (!released) ipc.exit(0);
  });
  ipc.on('SIGTERM', () => {
    if (!released) ipc.exit(0);
  });
  if (!ipc.connected) {
    ipc.exit(0);
    return;
  }
  ipc.on('message', (value) => {
    const message = readSupervisorControl(value, nonce);
    if (message?.type === 'retire') {
      retire();
      return;
    }
    if (!message || failed) {
      failed = true;
      send({
        type: 'protocol-failed',
        error: serializeFixtureError(
          new Error('Invalid fixture supervisor control')
        ),
      });
      if (!released) ipc.exit(1);
      return;
    }
    if (released) {
      failed = true;
      send({
        type: 'protocol-failed',
        error: serializeFixtureError(
          new Error('Duplicate fixture workload release')
        ),
      });
      return;
    }
    released = true;
    let target;
    try {
      target = spawnTarget(message.command, message.args, {
        cwd: message.cwd,
        env: message.env,
        detached: false,
        shell: false,
        stdio: ['ignore', 'inherit', 'inherit'],
      });
    } catch (error) {
      terminal = true;
      send({ type: 'spawn-failed', error: serializeFixtureError(error) });
      return;
    }
    target.on('error', (error) => {
      if (terminal) return;
      terminal = true;
      send({ type: 'spawn-failed', error: serializeFixtureError(error) });
    });
    target.on('exit', (status, signal) => {
      if (terminal) return;
      terminal = true;
      send({ type: 'target-exit', status, signal });
    });
    if (target.pid === undefined) return;
    // No await/yield here: the direct child has not been reaped by this loop.
    try {
      const row = inspect().get(target.pid);
      if (!row || row.parent !== ipc.pid || row.group !== ipc.pid)
        throw new Error('Invalid original fixture workload identity');
      send({ type: 'workload', identity: row });
    } catch (error) {
      failed = true;
      send({
        type: 'inspection-failed',
        stage: 'workload',
        error: serializeFixtureError(error),
      });
    }
  });
  try {
    const row = inspect().get(ipc.pid);
    if (
      !row ||
      row.parent !== ipc.ppid ||
      row.group !== ipc.pid ||
      row.state.startsWith('Z')
    )
      throw new Error('Invalid original fixture supervisor identity');
    send({ type: 'owned', identity: row });
  } catch (error) {
    failed = true;
    send(
      {
        type: 'inspection-failed',
        stage: 'self',
        error: serializeFixtureError(error),
      },
      () => ipc.exit(1)
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  runFixtureCommandSupervisor();
