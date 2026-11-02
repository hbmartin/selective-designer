import { type Result as BoxedResult, Result } from '@bloodyowl/boxed';

import type { GeneratedId } from './ids';

/**
 * Why a file is being uploaded. Each purpose has its own MIME allowlist, size
 * limit and object-key prefix, so a caller can never store e.g. a 60 MB file
 * under the mask prefix or an HTML file anywhere.
 */
export const uploadPurposes = [
  'base_image',
  'working_image',
  'item_photo',
  'item_cutout',
  'item_mask',
  'source_photo',
  'region_mask',
  'edit_mask',
] as const;

export type UploadPurpose = (typeof uploadPurposes)[number];

const RASTER_PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
const ALPHA_IMAGE_TYPES = ['image/png', 'image/webp'] as const;
const MASK_TYPES = ['image/png'] as const;

const MB = 1024 * 1024;

type UploadPurposePolicy = {
  prefix: string;
  acceptedFileTypes: readonly string[];
  maxFileSizeBytes: number;
};

export const uploadPurposePolicies = {
  base_image: {
    prefix: 'base-images',
    acceptedFileTypes: RASTER_PHOTO_TYPES,
    maxFileSizeBytes: 60 * MB,
  },
  working_image: {
    prefix: 'working-images',
    acceptedFileTypes: RASTER_PHOTO_TYPES,
    maxFileSizeBytes: 15 * MB,
  },
  item_photo: {
    prefix: 'item-photos',
    acceptedFileTypes: RASTER_PHOTO_TYPES,
    maxFileSizeBytes: 25 * MB,
  },
  item_cutout: {
    prefix: 'item-cutouts',
    acceptedFileTypes: ALPHA_IMAGE_TYPES,
    maxFileSizeBytes: 15 * MB,
  },
  item_mask: {
    prefix: 'item-masks',
    acceptedFileTypes: MASK_TYPES,
    maxFileSizeBytes: 10 * MB,
  },
  source_photo: {
    prefix: 'source-photos',
    acceptedFileTypes: RASTER_PHOTO_TYPES,
    maxFileSizeBytes: 25 * MB,
  },
  region_mask: {
    prefix: 'region-masks',
    acceptedFileTypes: MASK_TYPES,
    maxFileSizeBytes: 10 * MB,
  },
  edit_mask: {
    prefix: 'edit-masks',
    acceptedFileTypes: MASK_TYPES,
    maxFileSizeBytes: 10 * MB,
  },
} as const satisfies Record<UploadPurpose, UploadPurposePolicy>;

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** Objects are keyed by a fresh server id and never overwritten. */
export const IMMUTABLE_OBJECT_CACHE_CONTROL =
  'private, max-age=31536000, immutable';

export type UploadPolicyRejection = {
  type: 'upload_file_type_not_allowed';
  purpose: UploadPurpose;
  fileType: string;
};

export const isUploadPurpose = (value: unknown): value is UploadPurpose =>
  typeof value === 'string' &&
  (uploadPurposes as readonly string[]).includes(value);

export const isAcceptedUploadType = (
  purpose: UploadPurpose,
  fileType: string
): boolean =>
  (uploadPurposePolicies[purpose].acceptedFileTypes as readonly string[])
    .map((type) => type.toLowerCase())
    .includes(fileType.trim().toLowerCase());

/**
 * Build the server-decided storage key `<prefix>/<id>.<ext>`. The client
 * filename never participates, so there is no traversal or collision vector.
 */
export const createUploadObjectKey = (input: {
  purpose: UploadPurpose;
  id: GeneratedId;
  fileType: string;
}): BoxedResult<string, UploadPolicyRejection> => {
  const fileType = input.fileType.trim().toLowerCase();
  const extension = EXTENSION_BY_MIME[fileType];
  if (!extension || !isAcceptedUploadType(input.purpose, fileType)) {
    return Result.Error({
      type: 'upload_file_type_not_allowed',
      purpose: input.purpose,
      fileType: input.fileType,
    });
  }
  const { prefix } = uploadPurposePolicies[input.purpose];
  return Result.Ok(`${prefix}/${input.id}.${extension}`);
};

/** True when `objectKey` was minted for `purpose` by {@link createUploadObjectKey}. */
export const objectKeyMatchesPurpose = (
  objectKey: string,
  purpose: UploadPurpose
): boolean => {
  const { prefix } = uploadPurposePolicies[purpose];
  return new RegExp(`^${prefix}/[A-Za-z0-9_-]+\\.(png|jpg|webp)$`, 'u').test(
    objectKey
  );
};
