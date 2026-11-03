import type { FractionalBox } from './edit-set';

/** An item as the render used it: pinned to one version's imagery. */
export type RecipeItem = {
  itemId: string;
  itemVersionId: string;
  name: string;
  kind: 'product' | 'extract' | 'swatch';
  /** Cut-out for products/extracts, the photo for swatches. */
  referenceKey: string;
};

export type RecipeRegion = {
  regionId: string;
  label: string;
  maskKey: string;
  box: FractionalBox;
};

export type RecipeEdit =
  | {
      kind: 'placement';
      id: string;
      item: RecipeItem;
      box: FractionalBox;
      rotationDeg: number;
      note: string;
    }
  | {
      kind: 'replacement';
      id: string;
      item: RecipeItem;
      region: RecipeRegion;
      note: string;
    }
  | { kind: 'removal'; id: string; region: RecipeRegion; note: string }
  | {
      kind: 'material';
      id: string;
      region: RecipeRegion;
      swatch: RecipeItem | null;
      text: string;
    };

/**
 * Everything a render used, captured at submit and never changed: the render
 * source, resolved edits (item versions, region masks), prompt and the
 * combined edit mask. Later draft or item edits do not affect it.
 */
export type RenderRecipe = {
  renderSourceImageId: string;
  source: { workingKey: string; width: number; height: number };
  edits: RecipeEdit[];
  prompt: string;
  /** Union of all target areas (white = edit), at the source's size. */
  editMaskKey: string | null;
};

export const recipeReferences = (recipe: RenderRecipe): RecipeItem[] => {
  const seen = new Set<string>();
  const items: RecipeItem[] = [];
  for (const edit of recipe.edits) {
    const item =
      edit.kind === 'placement' || edit.kind === 'replacement'
        ? edit.item
        : edit.kind === 'material'
          ? edit.swatch
          : null;
    if (item && !seen.has(item.itemVersionId)) {
      seen.add(item.itemVersionId);
      items.push(item);
    }
  }
  return items;
};

export const targetBoxes = (recipe: RenderRecipe): FractionalBox[] =>
  recipe.edits.map((edit) =>
    edit.kind === 'placement' ? edit.box : edit.region.box
  );
