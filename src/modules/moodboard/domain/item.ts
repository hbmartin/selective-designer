import { type Result as BoxedResult, Result } from '@bloodyowl/boxed';
import { z } from 'zod';

import type {
  DesignId,
  ItemId,
  ItemVersionId,
  ObjectKey,
} from '@/modules/kernel/domain/ids';

export const ITEM_NAME_MAX_LENGTH = 120;
export const ITEM_CATEGORY_MAX_LENGTH = 60;
export const ITEM_VENDOR_MAX_LENGTH = 120;

export const zItemNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(ITEM_NAME_MAX_LENGTH)
  .brand<'ItemName'>();
export type ItemName = z.infer<typeof zItemNameSchema>;
export const zItemName = () => zItemNameSchema;

export const zItemCategorySchema = z
  .string()
  .trim()
  .min(1)
  .max(ITEM_CATEGORY_MAX_LENGTH)
  .brand<'ItemCategory'>();
export type ItemCategory = z.infer<typeof zItemCategorySchema>;
export const zItemCategory = () => zItemCategorySchema;

export const toItemName = (value: string): BoxedResult<ItemName, 'invalid'> => {
  const parsed = zItemNameSchema.safeParse(value);
  return parsed.success ? Result.Ok(parsed.data) : Result.Error('invalid');
};

export const toItemCategory = (
  value: string
): BoxedResult<ItemCategory, 'invalid'> => {
  const parsed = zItemCategorySchema.safeParse(value);
  return parsed.success ? Result.Ok(parsed.data) : Result.Error('invalid');
};

/**
 * - `product`: from a product photo, background removed.
 * - `extract`: cut out of a source photo.
 * - `swatch`: a material for region-wide changes (no cut-out).
 */
export const itemKinds = ['product', 'extract', 'swatch'] as const;
export type ItemKind = (typeof itemKinds)[number];

export const cutoutStatuses = [
  'not_needed',
  'pending',
  'ready',
  'failed',
] as const;
export type CutoutStatus = (typeof cutoutStatuses)[number];

export type PhotoInfo = {
  key: ObjectKey;
  contentType: string;
  width: number;
  height: number;
};

/**
 * One immutable state of an item's imagery. Corrections create a new version,
 * so render recipes that pinned an older version keep their exact inputs.
 */
export type ItemVersion = {
  id: ItemVersionId;
  itemId: ItemId;
  number: number;
  photo: PhotoInfo;
  cutoutKey: ObjectKey | null;
  maskKey: ObjectKey | null;
  cutoutStatus: CutoutStatus;
  cutoutAttemptStartedAt: Date | null;
  createdAt: Date;
};

export type Item = {
  id: ItemId;
  designId: DesignId;
  kind: ItemKind;
  name: ItemName;
  category: ItemCategory;
  vendor: string | null;
  productUrl: string | null;
  currentVersion: ItemVersion;
  createdAt: Date;
  updatedAt: Date;
};

/** Categories offered before the user has made any of their own. */
export const DEFAULT_ITEM_CATEGORIES = [
  'Furniture',
  'Lighting',
  'Plants',
  'Materials',
  'Hardware',
  'Fixtures',
  'Decor',
] as const;

/** A swatch needs no cut-out; products and extracts get their background removed. */
export const initialCutoutStatus = (kind: ItemKind): CutoutStatus =>
  kind === 'swatch' ? 'not_needed' : 'pending';

/**
 * Suggestions: the user's own categories first (most used first), then the
 * defaults they have not used yet. Case-insensitive de-duplication.
 */
export const categorySuggestions = (
  used: readonly { category: string; count: number }[]
): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of [...used].sort((a, b) => b.count - a.count)) {
    const key = entry.category.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(entry.category.trim());
  }
  for (const category of DEFAULT_ITEM_CATEGORIES) {
    if (!seen.has(category.toLowerCase())) result.push(category);
  }
  return result;
};

export const isHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
};
