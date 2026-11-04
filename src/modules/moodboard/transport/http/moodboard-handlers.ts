import { z } from 'zod';

import type { ProtectedContext } from '@/modules/auth/backend';
import { zDesignId, zItemId, zObjectKey } from '@/modules/kernel/domain/ids';
import {
  type OutcomeHandlerConfig,
  unwrapApplicationResult,
} from '@/modules/kernel/transport/tanstack/result-mapper';

import type { ItemView } from '../../application/use-cases/item-view';
import type {
  CreateItemOutcome,
  ListMoodboardOutcome,
  RemoveItemOutcome,
} from '../../application/use-cases/manage-items';
import {
  isHttpUrl,
  ITEM_VENDOR_MAX_LENGTH,
  itemKinds,
  zItemCategory,
  zItemName,
} from '../../domain/item';
import type { MoodboardUseCases } from '../../factory';

const zOptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => value || null);

const zOptionalUrl = () =>
  z
    .string()
    .trim()
    .max(2048)
    .refine((value) => value === '' || isHttpUrl(value), 'invalid_url')
    .nullish()
    .transform((value) => value || null);

export const zMoodboardInput = () => z.object({ designId: zDesignId() });

export const zItemCreateInput = () =>
  z.object({
    designId: zDesignId(),
    kind: z.enum(itemKinds),
    name: zItemName(),
    category: zItemCategory(),
    vendor: zOptionalText(ITEM_VENDOR_MAX_LENGTH),
    productUrl: zOptionalUrl(),
    photo: z.object({
      key: zObjectKey(),
      width: z.number().int().min(1).max(20_000),
      height: z.number().int().min(1).max(20_000),
    }),
  });

export const zItemUpdateInput = () =>
  z.object({
    itemId: zItemId(),
    name: zItemName().optional(),
    category: zItemCategory().optional(),
    vendor: zOptionalText(ITEM_VENDOR_MAX_LENGTH).optional(),
    productUrl: zOptionalUrl().optional(),
  });

export const zItemIdInput = () => z.object({ itemId: zItemId() });

export const zCutoutCorrectionInput = () =>
  z.object({
    itemId: zItemId(),
    cutoutKey: zObjectKey(),
    maskKey: zObjectKey(),
  });

const unowned = {
  code: 'BAD_REQUEST',
  message: 'The upload is no longer valid; please upload again.',
} as const;

const listConfig = {
  moodboard_listed: (outcome) => outcome.items,
  moodboard_forbidden: 'FORBIDDEN',
  design_not_found: 'NOT_FOUND',
} as const satisfies OutcomeHandlerConfig<ListMoodboardOutcome, ItemView[]>;

const createConfig = {
  item_created: (outcome) => outcome.item,
  item_upload_unowned: unowned,
  item_photo_invalid: { code: 'BAD_REQUEST', message: 'Invalid photo.' },
  moodboard_forbidden: 'FORBIDDEN',
  design_not_found: 'NOT_FOUND',
} as const satisfies OutcomeHandlerConfig<CreateItemOutcome, ItemView>;

const mutationConfig = {
  item_updated: (outcome: { item: ItemView }) => outcome.item,
  item_not_found: 'NOT_FOUND',
  moodboard_forbidden: 'FORBIDDEN',
  design_not_found: 'NOT_FOUND',
  item_upload_unowned: unowned,
  cutout_not_retryable: {
    code: 'BAD_REQUEST',
    message: 'This cut-out is not ready to retry.',
  },
} as const;

const removeConfig = {
  item_removed: () => undefined,
  item_not_found: 'NOT_FOUND',
  moodboard_forbidden: 'FORBIDDEN',
} as const satisfies OutcomeHandlerConfig<RemoveItemOutcome, void>;

type Deps = { getUseCases: (ctx: ProtectedContext) => MoodboardUseCases };

export const createMoodboardHandlers = ({ getUseCases }: Deps) => ({
  list: (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zMoodboardInput>>
  ) =>
    unwrapApplicationResult(
      getUseCases(ctx).list({
        currentUserId: ctx.scope.userId,
        designId: data.designId,
      }),
      listConfig
    ),
  create: (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zItemCreateInput>>
  ) =>
    unwrapApplicationResult(
      getUseCases(ctx).createItem({ currentUserId: ctx.scope.userId, ...data }),
      createConfig
    ),
  update: (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zItemUpdateInput>>
  ) => {
    const { itemId, ...changes } = data;
    return unwrapApplicationResult(
      getUseCases(ctx).updateItem({
        currentUserId: ctx.scope.userId,
        itemId,
        changes,
      }),
      mutationConfig
    );
  },
  remove: (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zItemIdInput>>
  ) =>
    unwrapApplicationResult(
      getUseCases(ctx).removeItem({
        currentUserId: ctx.scope.userId,
        itemId: data.itemId,
      }),
      removeConfig
    ),
  correctCutout: (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zCutoutCorrectionInput>>
  ) =>
    unwrapApplicationResult(
      getUseCases(ctx).correctCutout({
        currentUserId: ctx.scope.userId,
        ...data,
      }),
      mutationConfig
    ),
  retryCutout: (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zItemIdInput>>
  ) =>
    unwrapApplicationResult(
      getUseCases(ctx).retryCutout({
        currentUserId: ctx.scope.userId,
        itemId: data.itemId,
      }),
      mutationConfig
    ),
  categories: (ctx: ProtectedContext) =>
    unwrapApplicationResult(
      getUseCases(ctx).suggestCategories({ currentUserId: ctx.scope.userId }),
      {
        category_suggestions: (outcome: { categories: string[] }) =>
          outcome.categories,
      }
    ),
});

export type MoodboardHandlers = ReturnType<typeof createMoodboardHandlers>;
