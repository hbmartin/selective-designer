import type { SecondaryStore } from '../../application/ports/secondary-store';

export type BetterAuthSecondaryStorage = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  getAndDelete(key: string): Promise<string | null>;
  increment(key: string, ttlSeconds: number): Promise<number>;
  delete(key: string): Promise<void>;
};

export const createBetterAuthSecondaryStorage = (
  store: SecondaryStore
): BetterAuthSecondaryStorage => ({
  async get(key) {
    const result = await store.get(key);
    if (result.isError()) throw result.getError();

    const outcome = result.get();
    return outcome.type === 'secondary_store_hit' ? outcome.value : null;
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
