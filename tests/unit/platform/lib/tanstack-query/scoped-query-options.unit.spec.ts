import { describe, expect, it, vi } from 'vitest';

import {
  scopedEntityQueryOptions,
  scopedInfiniteQueryOptions,
  scopedListQueryOptions,
  serverMutationOptions,
} from '@/platform/lib/tanstack-query/scoped-query-options';

describe('scoped query option helpers', () => {
  it('builds list, infinite, entity, and mutation options without leaking scope into data', async () => {
    const listFn = vi.fn(async () => ({ items: [], total: 0 }));
    const list = scopedListQueryOptions({
      baseKey: (scopeKey) => ['design', 'v1', { scopeKey }, 'getAll'] as const,
      input: { scopeKey: 'scope-a', searchTerm: 'villa' },
      queryFn: listFn,
    });

    expect(list.queryKey).toEqual([
      'design',
      'v1',
      { scopeKey: 'scope-a' },
      'getAll',
      { searchTerm: 'villa' },
    ]);
    await (list.queryFn as unknown as () => Promise<unknown>)();
    expect(listFn).toHaveBeenCalledWith({ searchTerm: 'villa' });

    const infinite = scopedInfiniteQueryOptions({
      baseKey: (scopeKey) => ['design', 'v1', { scopeKey }, 'getAll'] as const,
      input: { scopeKey: 'scope-a', searchTerm: 'villa' },
      queryFn: async (_data, cursor: string | undefined) => ({
        items: [],
        total: 0,
        nextCursor: cursor,
      }),
    });
    expect(infinite.queryKey).toEqual([
      'design',
      'v1',
      { scopeKey: 'scope-a' },
      'getAll',
      'infinite',
      { searchTerm: 'villa' },
    ]);
    const infiniteQueryFn = infinite.queryFn as unknown as (context: {
      pageParam: string;
    }) => Promise<{
      items: [];
      total: number;
      nextCursor: string;
    }>;
    await expect(infiniteQueryFn({ pageParam: 'cursor-1' })).resolves.toEqual({
      items: [],
      total: 0,
      nextCursor: 'cursor-1',
    });
    const getNextPageParam =
      infinite.getNextPageParam as unknown as (lastPage: {
        items: [];
        total: number;
        nextCursor: string;
      }) => string | undefined;
    expect(
      getNextPageParam({
        items: [],
        total: 0,
        nextCursor: 'cursor-2',
      })
    ).toBe('cursor-2');
    expect(infinite.maxPages).toBe(10);

    const limitedInfinite = scopedInfiniteQueryOptions({
      baseKey: (scopeKey) => ['design', 'v1', { scopeKey }, 'getAll'] as const,
      input: { scopeKey: 'scope-a', searchTerm: 'villa' },
      maxPages: 3,
      queryFn: async () => ({
        items: [],
        total: 0,
        nextCursor: undefined,
      }),
    });
    expect(limitedInfinite.maxPages).toBe(3);

    const entity = scopedEntityQueryOptions({
      baseKey: (scopeKey) => ['design', 'v1', { scopeKey }, 'getById'] as const,
      input: { scopeKey: 'scope-a', id: 'design-1' },
      queryFn: async (data) => data.id,
    });
    expect(entity.queryKey).toEqual([
      'design',
      'v1',
      { scopeKey: 'scope-a' },
      'getById',
      { id: 'design-1' },
    ]);
    const entityQueryFn = entity.queryFn as unknown as () => Promise<string>;
    await expect(entityQueryFn()).resolves.toBe('design-1');

    const mutationFn = vi.fn(async (_input: { data: { id: string } }) => true);
    const mutation = serverMutationOptions({
      mutationKey: ['design', 'v1', 'deleteById'],
      mutationFn,
    });
    await (
      mutation.mutationFn as unknown as (data: {
        id: string;
      }) => Promise<unknown>
    )({ id: 'design-1' });
    expect(mutationFn).toHaveBeenCalledWith({ data: { id: 'design-1' } });
  });
});
