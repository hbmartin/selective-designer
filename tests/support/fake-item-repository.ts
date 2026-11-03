import { Result } from '@bloodyowl/boxed';

import type { Item, ItemRepository, ItemVersion } from '@/modules/moodboard';

/** In-memory {@link ItemRepository} for use-case tests. */
export const createFakeItemRepository = (now: () => Date) => {
  const items = new Map<string, Item & { removed: boolean }>();
  const versions = new Map<string, ItemVersion>();

  const visible = (id: string) => {
    const item = items.get(id);
    return item && !item.removed ? item : undefined;
  };

  const repository: ItemRepository = {
    async listByDesign(designId) {
      return Result.Ok({
        type: 'items_listed',
        items: [...items.values()].filter(
          (i) => i.designId === designId && !i.removed
        ),
      });
    },
    async findInDesign(input) {
      const item = visible(input.itemId);
      return Result.Ok(
        item && item.designId === input.designId
          ? { type: 'item_found', item }
          : { type: 'item_not_found' }
      );
    },
    async findById(itemId) {
      const item = visible(itemId);
      return Result.Ok(
        item ? { type: 'item_found', item } : { type: 'item_not_found' }
      );
    },
    async create(input) {
      const version: ItemVersion = {
        ...input.version,
        itemId: input.id,
        number: 1,
        createdAt: now(),
      };
      versions.set(version.id, version);
      const item = {
        id: input.id,
        designId: input.designId,
        kind: input.kind,
        name: input.name,
        category: input.category,
        vendor: input.vendor,
        productUrl: input.productUrl,
        currentVersion: version,
        createdAt: now(),
        updatedAt: now(),
        removed: false,
      };
      items.set(item.id, item);
      return Result.Ok({ type: 'item_created', item });
    },
    async update(input) {
      const item = visible(input.itemId);
      if (!item) return Result.Ok({ type: 'item_not_found' });
      Object.assign(item, input.changes);
      return Result.Ok({ type: 'item_found', item });
    },
    async addVersion(input) {
      const item = visible(input.itemId);
      if (!item) return Result.Ok({ type: 'item_not_found' });
      const version: ItemVersion = {
        ...input.version,
        itemId: item.id,
        number: item.currentVersion.number + 1,
        createdAt: now(),
      };
      versions.set(version.id, version);
      item.currentVersion = version;
      return Result.Ok({ type: 'item_found', item });
    },
    async remove(input) {
      const item = visible(input.itemId);
      if (!item) return Result.Ok({ type: 'item_not_found' });
      item.removed = true;
      return Result.Ok({ type: 'item_removed' });
    },
    async findVersion(versionId) {
      const version = versions.get(versionId);
      const item = version ? items.get(version.itemId) : undefined;
      return Result.Ok(
        version && item
          ? { type: 'item_version_found', version, designId: item.designId }
          : { type: 'item_version_not_found' }
      );
    },
    async setCutoutResult(input) {
      const version = versions.get(input.versionId);
      if (version) {
        version.cutoutStatus = input.cutoutStatus;
        version.cutoutKey = input.cutoutKey;
      }
      return Result.Ok({ type: 'cutout_result_saved' });
    },
    async categoryUsage() {
      const counts = new Map<string, number>();
      for (const item of items.values()) {
        if (!item.removed)
          counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
      }
      return Result.Ok({
        type: 'category_usage',
        usage: [...counts.entries()].map(([category, count]) => ({
          category,
          count,
        })),
      });
    },
  };
  return { repository, items, versions };
};
