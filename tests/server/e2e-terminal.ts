export function describeE2EFailure(error: unknown): string {
  if (error instanceof AggregateError)
    return `${error.message}\n${error.errors.map(describeE2EFailure).join('\n')}`;
  return error instanceof Error ? error.message : String(error);
}

export async function flushE2EOutput() {
  await Promise.all(
    [process.stdout, process.stderr].map(
      (stream) =>
        new Promise<void>((resolve) => stream.write('', () => resolve()))
    )
  );
}

/** Only command/signal boundaries may terminate the process. */
export function createE2ETerminal() {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let forceStop = () => {};
  const reported = new Set<unknown>();
  function begin() {
    if (deadline) return;
    process.exitCode ??= 0;
    deadline = setTimeout(() => {
      try {
        forceStop();
      } finally {
        console.error('E2E webserver termination exceeded ten seconds');
        process.exit(1);
      }
    }, 10_000);
  }
  return {
    get active() {
      return deadline !== undefined;
    },
    begin,
    setForceStop(action: () => void) {
      forceStop = action;
    },
    fail(error: unknown, label: string) {
      begin();
      process.exitCode = 1;
      if (reported.has(error)) return;
      reported.add(error);
      console.error(`${label}: ${describeE2EFailure(error)}`);
    },
    async finish(): Promise<never> {
      begin();
      await flushE2EOutput();
      process.exit(process.exitCode ?? 0);
    },
  };
}
