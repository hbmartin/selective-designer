import { z } from 'zod';

import type { ProtectedContext } from '@/modules/auth/backend';
import { zImageId, zObjectKey, zRegionId } from '@/modules/kernel/domain/ids';
import { unwrapApplicationResult } from '@/modules/kernel/transport/tanstack/result-mapper';

import type {
  RegionListView,
  RegionView,
} from '../../application/use-cases/regions';
import { REGION_LABEL_MAX_LENGTH } from '../../domain/region';
import type { SegmentationUseCases } from '../../factory';

const zFraction = () => z.number().min(0).max(1);
const zBox = () =>
  z.object({
    x: zFraction(),
    y: zFraction(),
    width: zFraction(),
    height: zFraction(),
  });

export const zRegionsInput = () => z.object({ imageId: zImageId() });

export const zSegmentInput = () =>
  z.object({
    imageId: zImageId(),
    label: z.string().trim().max(REGION_LABEL_MAX_LENGTH).prefault(''),
    prompt: z.discriminatedUnion('type', [
      z.object({
        type: z.literal('click'),
        points: z
          .array(
            z.object({ x: zFraction(), y: zFraction(), positive: z.boolean() })
          )
          .min(1)
          .max(10),
      }),
      z.object({ type: z.literal('box'), box: zBox() }),
      z.object({
        type: z.literal('text'),
        text: z.string().trim().min(1).max(REGION_LABEL_MAX_LENGTH),
      }),
    ]),
  });

export const zManualRegionInput = () =>
  z.object({
    imageId: zImageId(),
    source: z.enum(['brush', 'lasso']),
    label: z.string().trim().max(REGION_LABEL_MAX_LENGTH).prefault(''),
    maskKey: zObjectKey(),
    box: zBox(),
  });

export const zRegionUpdateInput = () =>
  z.object({
    regionId: zRegionId(),
    label: z.string().trim().max(REGION_LABEL_MAX_LENGTH).optional(),
    confirm: z.boolean().optional(),
  });

export const zRegionIdInput = () => z.object({ regionId: zRegionId() });

const common = {
  segmentation_forbidden: 'FORBIDDEN',
  image_not_found: 'NOT_FOUND',
  region_not_found: 'NOT_FOUND',
} as const;

export const createSegmentationHandlers = ({
  getUseCases,
}: {
  getUseCases: (ctx: ProtectedContext) => SegmentationUseCases;
}) => ({
  list: (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zRegionsInput>>
  ) =>
    unwrapApplicationResult(
      getUseCases(ctx).list({
        currentUserId: ctx.scope.userId,
        imageId: data.imageId,
      }),
      {
        ...common,
        regions_listed: ({
          regions,
          detection,
        }: RegionListView): RegionListView => ({ regions, detection }),
      }
    ),
  retryDetection: (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zRegionsInput>>
  ) =>
    unwrapApplicationResult(
      getUseCases(ctx).retryDetection({
        currentUserId: ctx.scope.userId,
        imageId: data.imageId,
      }),
      {
        ...common,
        auto_detection_scheduled: () => undefined,
        detection_queue_uncertain: () => undefined,
        detection_queue_rejected: () => undefined,
        detection_not_retryable: () => undefined,
      }
    ),
  segment: (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zSegmentInput>>
  ) =>
    unwrapApplicationResult(
      getUseCases(ctx).segment({ currentUserId: ctx.scope.userId, ...data }),
      {
        ...common,
        regions_created: (outcome: { regions: RegionView[] }) =>
          outcome.regions,
        segmentation_failed: {
          code: 'BAD_REQUEST',
          message: 'Segmentation failed for this image.',
        },
      }
    ),
  createManual: (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zManualRegionInput>>
  ) =>
    unwrapApplicationResult(
      getUseCases(ctx).createManual({
        currentUserId: ctx.scope.userId,
        ...data,
      }),
      {
        ...common,
        regions_created: (outcome: { regions: RegionView[] }) =>
          outcome.regions,
        region_upload_unowned: {
          code: 'BAD_REQUEST',
          message: 'Upload the mask again.',
        },
        region_invalid: { code: 'BAD_REQUEST', message: 'Invalid region.' },
      }
    ),
  update: (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zRegionUpdateInput>>
  ) =>
    unwrapApplicationResult(
      getUseCases(ctx).update({ currentUserId: ctx.scope.userId, ...data }),
      {
        ...common,
        region_updated: (outcome: { region: RegionView }): RegionView | null =>
          outcome.region,
        region_removed: () => null,
      }
    ),
  remove: (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zRegionIdInput>>
  ) =>
    unwrapApplicationResult(
      getUseCases(ctx).remove({ currentUserId: ctx.scope.userId, ...data }),
      {
        ...common,
        region_removed: () => null,
        region_updated: () => null,
      }
    ),
});

export type SegmentationHandlers = ReturnType<
  typeof createSegmentationHandlers
>;
