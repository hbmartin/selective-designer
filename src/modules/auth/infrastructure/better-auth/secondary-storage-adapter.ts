import { z } from 'zod';

import type { SecondaryStore } from '../../application/ports/secondary-store';

export type BetterAuthSecondaryStorage = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  getAndDelete(key: string): Promise<string | null>;
  increment(key: string, ttlSeconds: number): Promise<number>;
  delete(key: string): Promise<void>;
};

const sessionEnvelope = z.object({
  session: z.object({
    userId: z.string(),
    credentialVersion: z.number().int().nonnegative(),
    impersonatedBy: z.nullish(z.string()),
  }),
  user: z.object({ id: z.string() }),
});

function sessionPayload(value: string) {
  try {
    const payload: unknown = JSON.parse(value);
    return payload && typeof payload === 'object' && 'session' in payload
      ? payload
      : undefined;
  } catch {
    return undefined;
  }
}

export const createBetterAuthSecondaryStorage = (
  store: SecondaryStore,
  validateVersion?: (userId: string, version: number) => Promise<boolean>
): BetterAuthSecondaryStorage => ({
  async get(key) {
    const result = await store.get(key);
    if (result.isError()) throw result.getError();

    const outcome = result.get();
    if (outcome.type !== 'secondary_store_hit') return null;
    const { value } = outcome;
    const payload = validateVersion && sessionPayload(value);
    if (!payload || !validateVersion) return value;
    const parsed = sessionEnvelope.safeParse(payload);
    if (!parsed.success) return null;
    const { session, user } = parsed.data;
    if (session.userId !== user.id || session.impersonatedBy != null)
      return null;
    return (await validateVersion(user.id, session.credentialVersion))
      ? value
      : null;
  },
  async set(key, value, ttlSeconds) {
    const result = await store.set(key, value, ttlSeconds);
    if (result.isError()) throw result.getError();
  },
  async getAndDelete(key) {
    const result = await store.getAndDelete(key);
    if (result.isError()) throw result.getError();

    const outcome = result.get();
    return outcome.type === 'secondary_store_taken' ? outcome.value : null;
  },
  async increment(key, ttlSeconds) {
    const result = await store.increment(key, ttlSeconds);
    if (result.isError()) throw result.getError();
    return result.get().value;
  },
  async delete(key) {
    const result = await store.delete(key);
    if (result.isError()) throw result.getError();
  },
});
