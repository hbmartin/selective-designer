const VERSION_TTL_MS = 30_000;
const MAX_ENTRIES = 1_024;

type VersionRead = { version: number; startedAt: number };

export function createCredentialVersionCache(
  readVersion: (userId: string) => Promise<number | undefined>,
  now = () => performance.now()
) {
  const entries = new Map<string, VersionRead>();
  const pending = new Map<string, Promise<VersionRead | undefined>>();

  const remember = (userId: string, entry: VersionRead) => {
    const previous = entries.get(userId);
    if (
      previous &&
      (previous.version > entry.version || previous.startedAt > entry.startedAt)
    )
      return;
    entries.delete(userId);
    entries.set(userId, entry);
    if (entries.size > MAX_ENTRIES) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
  };

  const read = (userId: string) => {
    const existing = pending.get(userId);
    if (existing) return existing;
    const startedAt = now();
    const task = readVersion(userId)
      .then((version) => {
        if (version === undefined || now() - startedAt >= VERSION_TTL_MS)
          return undefined;
        const entry = { version, startedAt };
        remember(userId, entry);
        return entries.get(userId);
      })
      .finally(() => pending.delete(userId));
    pending.set(userId, task);
    return task;
  };

  return async (userId: string, stamp: number) => {
    const cached = entries.get(userId);
    if (cached && stamp < cached.version) return false;
    if (
      cached &&
      stamp === cached.version &&
      now() - cached.startedAt < VERSION_TTL_MS
    )
      return true;
    const joinedRead = pending.has(userId);
    let version = await read(userId);
    // A joined read may have started before the reset that issued this stamp.
    if (joinedRead && version && stamp > version.version) {
      version = await read(userId);
    }
    return (
      version?.version === stamp && now() - version.startedAt < VERSION_TTL_MS
    );
  };
}
