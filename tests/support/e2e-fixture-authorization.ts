type AuthorizationChannel = {
  connected?: boolean;
  send?: (
    message: { type: string },
    callback: (error: Error | null) => void
  ) => unknown;
  on(
    event: 'message' | 'disconnect',
    listener: (value?: unknown) => void
  ): unknown;
  off(
    event: 'message' | 'disconnect',
    listener: (value?: unknown) => void
  ): unknown;
};

/** Bootstrap owns only IPC until the parent authenticates its process group. */
export function waitForE2EFixtureAuthorization(
  channel: AuthorizationChannel = process
) {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      channel.off('message', onMessage);
      channel.off('disconnect', onDisconnect);
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'authorize'
      )
        finish();
    };
    const onDisconnect = () =>
      finish(new Error('Fixture authorization IPC disconnected'));
    const timer = setTimeout(
      () => finish(new Error('Fixture authorization timed out')),
      5_000
    );
    channel.on('message', onMessage);
    channel.on('disconnect', onDisconnect);
    try {
      if (!channel.send || channel.connected === false)
        throw new Error('Fixture authorization requires connected IPC');
      channel.send({ type: 'authorization-ready' }, (error) => {
        if (error) finish(error);
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
