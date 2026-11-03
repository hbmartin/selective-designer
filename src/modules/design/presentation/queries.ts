import {
  scopedEntityQueryOptions,
  scopedInfiniteQueryOptions,
  type ScopedQueryInput,
  serverMutationOptions,
} from '@/platform/lib/tanstack-query/scoped-query-options';
import type { ServerFunctionFacade } from '@/platform/lib/tanstack-start/server-function-types';

import type { DesignId, ScopeKey } from '@/modules/kernel/domain/ids';

import type { DesignServerFunctions } from '../server';

export type DesignQueryFacade = ServerFunctionFacade<DesignServerFunctions>;

const designQueryVersion = 'v1';

/**
 * Signed image URLs in design payloads expire after an hour; keep cached data
 * well inside that window.
 */
export const DESIGN_STALE_TIME_MS = 20 * 60 * 1000;

type ListInput = { searchTerm?: string; archived?: boolean };

export const createDesignQueries = <TFacade extends DesignQueryFacade>(
  facade: TFacade
) => {
  const all = () => ['design', designQueryVersion] as const;
  const getAll = (scopeKey: ScopeKey) =>
    [...all(), { scopeKey }, 'getAll'] as const;
  const getByIdBaseKey = (scopeKey: ScopeKey) =>
    [...all(), { scopeKey }, 'getById'] as const;

  return {
    all,
    getAll,
    getAllInfinite: (input: ListInput & ScopedQueryInput<ScopeKey>) => ({
      ...scopedInfiniteQueryOptions({
        baseKey: getAll,
        input,
        queryFn: (data, pageParam: DesignId | undefined) =>
          facade.designGetAll({ data: { ...data, cursor: pageParam } }),
      }),
      staleTime: DESIGN_STALE_TIME_MS,
    }),
    getById: (input: { id: DesignId } & ScopedQueryInput<ScopeKey>) => ({
      ...scopedEntityQueryOptions({
        baseKey: getByIdBaseKey,
        input,
        queryFn: (data) => facade.designGetById({ data }),
      }),
      staleTime: DESIGN_STALE_TIME_MS,
    }),
    sourcePhotos: (
      input: { designId: DesignId } & ScopedQueryInput<ScopeKey>
    ) => ({
      ...scopedEntityQueryOptions({
        baseKey: (scopeKey: ScopeKey) =>
          [...all(), { scopeKey }, 'sourcePhotos'] as const,
        input,
        queryFn: (data) => facade.designListSourcePhotos({ data }),
      }),
      staleTime: DESIGN_STALE_TIME_MS,
    }),
    addSourcePhoto: () =>
      serverMutationOptions({
        mutationKey: [...all(), 'addSourcePhoto'],
        mutationFn: facade.designAddSourcePhoto,
      }),
    create: () =>
      serverMutationOptions({
        mutationKey: [...all(), 'create'],
        mutationFn: facade.designCreate,
      }),
    rename: () =>
      serverMutationOptions({
        mutationKey: [...all(), 'rename'],
        mutationFn: facade.designRename,
      }),
    archive: () =>
      serverMutationOptions({
        mutationKey: [...all(), 'archive'],
        mutationFn: facade.designArchive,
      }),
    unarchive: () =>
      serverMutationOptions({
        mutationKey: [...all(), 'unarchive'],
        mutationFn: facade.designUnarchive,
      }),
  };
};
