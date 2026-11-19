import { inspectFixtureProcesses } from './fixture-process-groups';
import fs from 'node:fs';
import path from 'node:path';
import {
  captureFixtureProcessGroup,
  disposeCapturedFixtureProcessGroup,
  registerFixtureProcessGroup,
  runFixtureCommand,
  type FixtureProcessGroupCapability,
  type WorkflowFixture,
} from './workflow-fixtures';

export type ScenarioOptions = {
  detached?: boolean;
  register?: boolean;
  timeoutMs?: number;
  launch?: 'missing' | 'corrupt';
  readiness?: 'missing' | 'corrupt' | 'mismatched';
  bootstrapDelayMs?: number;
  producerFailure?: boolean;
  beforeRegister?: () => void;
  afterOwnership?: () => void;
};

function atomic(file: string, value: string) {
  fs.writeFileSync(`${file}.tmp`, value);
  fs.renameSync(`${file}.tmp`, file);
}
function identity(file: string) {
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (
    typeof value !== 'object' ||
    value === null ||
    !('pid' in value) ||
    !Number.isSafeInteger(value.pid) ||
    Number(value.pid) <= 1 ||
    !('parent' in value) ||
    !Number.isSafeInteger(value.parent) ||
    Number(value.parent) <= 1
  )
    throw new Error(`Invalid scenario identity: ${file}`);
  return value as { pid: number; parent: number };
}
async function waitFor(file: string, finished: () => boolean) {
  const deadline = performance.now() + 5_000;
  while (!fs.existsSync(file)) {
    if (finished())
      throw new Error(`Scenario producer stopped before publishing ${file}`);
    if (performance.now() >= deadline)
      throw new Error(`Scenario readiness deadline: ${file}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

/** Create and retain this scope before calling start, including failed readiness. */
export function createFixtureScenario(
  fixture: WorkflowFixture,
  options: ScenarioOptions = {}
) {
  const { detached = true, register = true, timeoutMs = 10_000 } = options;
  const launch = path.join(fixture.support, 'launch.json');
  const ready = path.join(fixture.support, 'ready.json');
  const acknowledgement = path.join(fixture.support, 'acknowledgement');
  const release = path.join(fixture.support, 'release');
  const cancel = new AbortController();
  let capability: FixtureProcessGroupCapability | undefined;
  let finished = false;
  let running: ReturnType<typeof runFixtureCommand> | undefined;
  let ids: { pid: number; parent: number } | undefined;
  let disposal: Promise<void> | undefined;
  const dispose = () => {
    if (disposal) return disposal;
    cancel.abort('Scenario cleanup');
    disposal = (async () => {
      const results = await Promise.allSettled([
        running,
        capability ? disposeCapturedFixtureProcessGroup(capability) : undefined,
      ]);
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (errors.length)
        throw new AggregateError(errors, 'Scenario cleanup failed');
    })();
    void disposal.catch(() => {
      disposal = undefined;
    });
    return disposal;
  };
  const start = async () => {
    if (running) throw new Error('Scenario already started');
    // The disconnect guard must precede resistant workload. The producer keeps
    // the IPC channel alive until the parent validates and owns the launch PID.
    const descendant = `
      const fs=require('node:fs');
      const disconnect=()=>process.exit(0);
      process.on('disconnect',disconnect);
      if(!process.connected)process.exit(0);
      process.on('message',message=>{
        if(message!=='start')return;
        process.removeListener('disconnect',disconnect);
        process.on('SIGTERM',()=>{});
        setInterval(()=>{},1000);
        fs.writeSync(1,'descendant stdout\\n');fs.writeSync(2,'descendant stderr\\n');
        const value=${JSON.stringify(options.readiness === 'corrupt' ? 'invalid' : undefined)} ?? JSON.stringify({pid:${options.readiness === 'mismatched' ? 2 : 'process.pid'},parent:process.ppid});
        if(${options.readiness !== 'missing'}){fs.writeFileSync(${JSON.stringify(ready + '.tmp')},value);fs.renameSync(${JSON.stringify(ready + '.tmp')},${JSON.stringify(ready)});}
      });
    `;
    const source = options.bootstrapDelayMs
      ? `const until=Date.now()+${options.bootstrapDelayMs};while(Date.now()<until){};${descendant}`
      : descendant;
    const producer = `
      const fs=require('node:fs');
      const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(source)}],{detached:${detached},stdio:['ignore','inherit','inherit','ipc']});
      child.on('error',error=>{console.error(error);process.exit(2)});
      process.on('SIGTERM',()=>{if(!committed)process.exit(0)});
      let committed=false;
      fs.writeFileSync(${JSON.stringify(path.join(fixture.support, 'observed.json'))},JSON.stringify({pid:child.pid,parent:process.pid}));
      ${options.producerFailure ? "console.error('injected producer error');process.exit(3);" : ''}
      if(${options.launch !== 'missing'}){fs.writeFileSync(${JSON.stringify(launch + '.tmp')},${JSON.stringify(options.launch === 'corrupt' ? 'invalid' : undefined)} ?? JSON.stringify({pid:child.pid,parent:process.pid}));fs.renameSync(${JSON.stringify(launch + '.tmp')},${JSON.stringify(launch)});}
      setInterval(()=>{
        if(!committed&&fs.existsSync(${JSON.stringify(acknowledgement)})){committed=true;child.send('start')}
        if(fs.existsSync(${JSON.stringify(release)}))process.exit(0);
      },20);
    `;
    try {
      running = runFixtureCommand(process.execPath, ['-e', producer], fixture, {
        signal: cancel.signal,
        timeoutMs,
      });
      void running.then(() => {
        finished = true;
      });
      await waitFor(launch, () => finished);
      ids = identity(launch);
      if (inspectFixtureProcesses().get(ids.pid)?.parent !== ids.parent)
        throw new Error('Launch identity does not match its active producer');
      if (detached) {
        options.beforeRegister?.();
        capability = await captureFixtureProcessGroup(fixture, ids.pid);
        if (register) await registerFixtureProcessGroup(fixture, ids.pid);
      }
      options.afterOwnership?.();
      atomic(acknowledgement, 'start');
      await waitFor(ready, () => finished);
      const readyIdentity = identity(ready);
      if (readyIdentity.pid !== ids.pid || readyIdentity.parent !== ids.parent)
        throw new Error(
          'Scenario readiness does not match owned launch identity'
        );
      return { ...ids, cancel, running, release, capability, dispose };
    } catch (error) {
      try {
        await dispose();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Scenario setup and cleanup failed'
        );
      }
      throw error;
    }
  };
  return {
    start,
    dispose,
    get running() {
      return running;
    },
  };
}
