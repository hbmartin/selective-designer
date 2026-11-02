import { z } from 'zod';

import type { ProtectedContext } from '@/modules/auth/backend';
import { zDesignId, zImageId, zObjectKey } from '@/modules/kernel/domain/ids';
import {
  type OutcomeHandlerConfig,
  unwrapApplicationResult,
} from '@/modules/kernel/transport/tanstack/result-mapper';

import type { DesignCreateOutcome } from '../../application/use-cases/create-design';
import type { DesignView } from '../../application/use-cases/design-view';
import type { DesignGetOutcome } from '../../application/use-cases/get-design';
import type { ImageDownloadOutcome } from '../../application/use-cases/image-access';
import type {
  DesignListOutcome,
  DesignViewPage,
} from '../../application/use-cases/list-designs';
import type { DesignUpdateOutcome } from '../../application/use-cases/update-design';
import { zDesignName } from '../../domain/design';
import { MAX_IMAGE_EDGE } from '../../domain/image-policy';
import type { DesignUseCases } from '../../factory';

const zDimensions = () =>
  z.object({
    width: z.number().int().min(1).max(MAX_IMAGE_EDGE),
    height: z.number().int().min(1).max(MAX_IMAGE_EDGE),
  });

export const zDesignListInput = () =>
  z
    .object({
      cursor: zDesignId().optional(),
      limit: z.coerce.number().int().min(1).max(100).prefault(24),
      searchTerm: z.string().trim().max(120).optional(),
      archived: z.boolean().prefault(false),
    })
    .prefault({});

export const zDesignByIdInput = () => z.object({ id: zDesignId() });

export const zDesignCreateInput = () =>
  z.object({
    name: zDesignName(),
    baseImage: z.object({
      originalKey: zObjectKey(),
      original: zDimensions(),
      workingKey: zObjectKey(),
      working: zDimensions(),
    }),
    copiedFromDesignId: zDesignId().optional(),
  });

export const zDesignRenameInput = () =>
  z.object({ id: zDesignId(), name: zDesignName() });

export const zImageByIdInput = () => z.object({ imageId: zImageId() });

const listConfig = {
  design_forbidden: 'FORBIDDEN',
  design_listed: (outcome) => outcome.page,
} as const satisfies OutcomeHandlerConfig<DesignListOutcome, DesignViewPage>;

const getConfig = {
  design_forbidden: 'FORBIDDEN',
  design_found: (outcome) => outcome.design,
  design_not_found: 'NOT_FOUND',
} as const satisfies OutcomeHandlerConfig<DesignGetOutcome, DesignView>;

const createConfig = {
  design_created: (outcome) => outcome.design,
  design_forbidden: 'FORBIDDEN',
  design_not_found: 'NOT_FOUND',
  design_upload_unowned: {
    code: 'BAD_REQUEST',
    message: 'The upload is no longer valid; please upload the image again.',
  },
  design_image_invalid: {
    code: 'BAD_REQUEST',
    message: 'The uploaded image is not a valid base image.',
  },
} as const satisfies OutcomeHandlerConfig<DesignCreateOutcome, DesignView>;

const updateConfig = {
  design_forbidden: 'FORBIDDEN',
  design_not_found: 'NOT_FOUND',
  design_updated: (outcome) => outcome.design,
} as const satisfies OutcomeHandlerConfig<DesignUpdateOutcome, DesignView>;

export const imageDownloadConfig = {
  design_forbidden: 'FORBIDDEN',
  image_not_found: 'NOT_FOUND',
  image_download_url: (outcome) => outcome.url,
} as const satisfies OutcomeHandlerConfig<ImageDownloadOutcome, string>;

type DesignHandlerDeps = {
  getUseCases: (ctx: ProtectedContext) => DesignUseCases;
};

export const createDesignHandlers = ({ getUseCases }: DesignHandlerDeps) => ({
  getAll: (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zDesignListInput>>
  ) =>
    unwrapApplicationResult(
      getUseCases(ctx).list({
        currentUserId: ctx.scope.userId,
        archived: data.archived,
        searchTerm: data.searchTerm ?? '',
        cursor: data.cursor,
        limit: data.limit,
      }),
      listConfig
    ),
  getById: (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zDesignByIdInput>>
  ) =>
    unwrapApplicationResult(
      getUseCases(ctx).get({ currentUserId: ctx.scope.userId, id: data.id }),
      getConfig
    ),
  create: (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zDesignCreateInput>>
  ) =>
    unwrapApplicationResult(
      getUseCases(ctx).create({
        currentUserId: ctx.scope.userId,
        name: data.name,
        baseImage: data.baseImage,
        ...(data.copiedFromDesignId
          ? { copiedFromDesignId: data.copiedFromDesignId }
          : {}),
      }),
      createConfig
    ),
  rename: (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zDesignRenameInput>>
  ) =>
    unwrapApplicationResult(
      getUseCases(ctx).update({
        currentUserId: ctx.scope.userId,
        id: data.id,
        change: { type: 'rename', name: data.name },
      }),
      updateConfig
    ),
  archive: (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zDesignByIdInput>>
  ) =>
    unwrapApplicationResult(
      getUseCases(ctx).update({
        currentUserId: ctx.scope.userId,
        id: data.id,
        change: { type: 'archive' },
      }),
      updateConfig
    ),
  unarchive: (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zDesignByIdInput>>
  ) =>
    unwrapApplicationResult(
      getUseCases(ctx).update({
        currentUserId: ctx.scope.userId,
        id: data.id,
        change: { type: 'unarchive' },
      }),
      updateConfig
    ),
});

export type DesignHandlers = ReturnType<typeof createDesignHandlers>;
