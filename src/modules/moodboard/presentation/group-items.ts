import type { ItemView } from '../application/use-cases/item-view';

/** Items grouped by category, categories in first-use order. */
export const groupByCategory = <TItem extends Pick<ItemView, 'category'>>(
  items: readonly TItem[]
) => {
  const groups = new Map<string, TItem[]>();
  for (const item of items) {
    const group = groups.get(item.category) ?? [];
    group.push(item);
    groups.set(item.category, group);
  }
  return [...groups.entries()].map(([category, entries]) => ({
    category,
    items: entries,
  }));
};
