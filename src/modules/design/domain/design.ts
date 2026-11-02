import { type Result as BoxedResult, Result } from '@bloodyowl/boxed';
import { z } from 'zod';

import type {
  DesignId,
  ImageId,
  ObjectKey,
  UserId,
} from '@/modules/kernel/domain/ids';

export const DESIGN_NAME_MAX_LENGTH = 120;

export const zDesignNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(DESIGN_NAME_MAX_LENGTH)
  .brand<'DesignName'>();

export type DesignName = z.infer<typeof zDesignNameSchema>;

export const zDesignName = () => zDesignNameSchema;

export type DesignNameError = { type: 'design_name_invalid' };

export const toDesignName = (
  value: string
): BoxedResult<DesignName, DesignNameError> => {
  const parsed = zDesignNameSchema.safeParse(value);
  return parsed.success
    ? Result.Ok(parsed.data)
    : Result.Error({ type: 'design_name_invalid' });
};

/**
 * What an image is within a design: the uploaded base image, a model's render
 * result, or a source photo items are cut from.
 */
export const designImageKinds = ['base', 'result', 'source_photo'] as const;
export type DesignImageKind = (typeof designImageKinds)[number];

export type ImageDimensions = { width: number; height: number };

/**
 * A stored image. `originalKey` is the bytes exactly as uploaded or returned;
 * `workingKey` is a copy at most {@link WORKING_IMAGE_LONG_EDGE} px on its long
 * edge that models receive. For small images both keys may be equal.
 */
export type DesignImage = {
  id: ImageId;
  designId: DesignId;
  kind: DesignImageKind;
  originalKey: ObjectKey;
  originalContentType: string;
  original: ImageDimensions;
  workingKey: ObjectKey;
  working: ImageDimensions;
  createdAt: Date;
};

export type Design = {
  id: DesignId;
  ownerId: UserId;
  name: DesignName;
  baseImage: DesignImage;
  /** Set when this design was created from a revised architect image. */
  copiedFromDesignId: DesignId | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type DesignListPage = {
  items: Design[];
  nextCursor: DesignId | undefined;
  total: number;
};
