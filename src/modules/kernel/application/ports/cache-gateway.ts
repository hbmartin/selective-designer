import type { Option } from '@bloodyowl/boxed';

import type { CacheKey } from '../../domain/ids';

export interface CacheGateway {
  get<T>(key: CacheKey): Promise<Option<T>>;
  set<T>(key: CacheKey, value: T, options?: { ttlMs?: number }): Promise<void>;
  delete(key: CacheKey): Promise<void>;
}
