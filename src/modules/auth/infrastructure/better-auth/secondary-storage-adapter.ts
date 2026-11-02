import type { SecondaryStore } from '../../application/ports/secondary-store';

export type BetterAuthSecondaryStorage = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
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
  async delete(key) {
    const result = await store.delete(key);
    if (result.isError()) throw result.getError();
  },
});
