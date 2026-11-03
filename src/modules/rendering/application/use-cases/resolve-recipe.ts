import { Result } from '@bloodyowl/boxed';

import { toObjectKey } from '@/modules/kernel/domain/ids';

import type { RenderingResult, RenderingUseCaseDeps } from './types';
import type { InputItem, MaskShape, SourceImage } from '../ports/ports';
import type { Edit, EditSet } from '../../domain/edit-set';
import type {
  RecipeEdit,
  RecipeItem,
  RecipeRegion,
  RenderRecipe,
} from '../../domain/recipe';

export type RecipeProblem =
  | { type: 'item_missing'; editId: string }
  | { type: 'item_not_ready'; editId: string; itemName: string }
  | { type: 'region_missing'; editId: string }
  | { type: 'nothing_to_render' };

const toRecipeItem = (item: InputItem): RecipeItem | null =>
  item.referenceKey
    ? {
        itemId: item.itemId,
        itemVersionId: item.itemVersionId,
        name: item.name,
        kind: item.kind,
        referenceKey: item.referenceKey,
      }
    : null;

type Deps = Pick<
  RenderingUseCaseDeps,
  'renderInputs' | 'maskCompositor' | 'idGenerator'
>;

type ItemLookup =
  | { type: 'item'; item: RecipeItem }
  | Extract<RecipeProblem, { type: 'item_missing' | 'item_not_ready' }>;
type RegionLookup =
  | { type: 'region'; region: RecipeRegion }
  | Extract<RecipeProblem, { type: 'region_missing' }>;
type ResolvedEdit =
  | { type: 'edit'; edit: RecipeEdit; shape: MaskShape }
  | RecipeProblem;

const loadItem = async (
  deps: Deps,
  source: SourceImage,
  editId: string,
  itemId: string
): Promise<RenderingResult<ItemLookup>> => {
  const found = await deps.renderInputs.item(itemId);
  if (found.isError()) return Result.Error(found.getError());
  const outcome = found.get();
  if (outcome.type === 'missing' || outcome.item.designId !== source.designId) {
    return Result.Ok({ type: 'item_missing', editId });
  }
  const item = toRecipeItem(outcome.item);
  if (!item)
    return Result.Ok({
      type: 'item_not_ready',
      editId,
      itemName: outcome.item.name,
    });
  return Result.Ok({ type: 'item', item });
};

const loadRegion = async (
  deps: Deps,
  source: SourceImage,
  editId: string,
  regionId: string
): Promise<RenderingResult<RegionLookup>> => {
  const found = await deps.renderInputs.region(regionId);
  if (found.isError()) return Result.Error(found.getError());
  const outcome = found.get();
  if (outcome.type === 'missing' || outcome.region.imageId !== source.imageId) {
    return Result.Ok({ type: 'region_missing', editId });
  }
  const { regionId: id, label, maskKey, box } = outcome.region;
  return Result.Ok({
    type: 'region',
    region: { regionId: id, label, maskKey, box },
  });
};

/** Resolve one edit to pinned inputs and the mask shape it contributes. */
const resolveEdit = async (
  deps: Deps,
  source: SourceImage,
  edit: Edit
): Promise<RenderingResult<ResolvedEdit>> => {
  if (edit.kind === 'placement') {
    const item = await loadItem(deps, source, edit.id, edit.itemId);
    if (item.isError()) return Result.Error(item.getError());
    const itemOutcome = item.get();
    if (itemOutcome.type !== 'item') return Result.Ok(itemOutcome);
    return Result.Ok({
      type: 'edit',
      edit: {
        kind: 'placement',
        id: edit.id,
        item: itemOutcome.item,
        box: edit.box,
        rotationDeg: edit.rotationDeg,
        note: edit.note,
      },
      shape: { kind: 'box', box: edit.box, rotationDeg: edit.rotationDeg },
    });
  }

  const region = await loadRegion(deps, source, edit.id, edit.regionId);
  if (region.isError()) return Result.Error(region.getError());
  const regionOutcome = region.get();
  if (regionOutcome.type !== 'region') return Result.Ok(regionOutcome);
  const shape: MaskShape = {
    kind: 'region',
    maskKey: regionOutcome.region.maskKey,
  };

  if (edit.kind === 'removal') {
    return Result.Ok({
      type: 'edit',
      edit: {
        kind: 'removal',
        id: edit.id,
        region: regionOutcome.region,
        note: edit.note,
      },
      shape,
    });
  }

  const itemId = edit.kind === 'replacement' ? edit.itemId : edit.swatchItemId;
  let item: RecipeItem | null = null;
  if (itemId) {
    const loaded = await loadItem(deps, source, edit.id, itemId);
    if (loaded.isError()) return Result.Error(loaded.getError());
    const loadedOutcome = loaded.get();
    if (loadedOutcome.type !== 'item') return Result.Ok(loadedOutcome);
    item = loadedOutcome.item;
  }

  if (edit.kind === 'replacement') {
    if (!item) return Result.Ok({ type: 'item_missing', editId: edit.id });
    return Result.Ok({
      type: 'edit',
      edit: {
        kind: 'replacement',
        id: edit.id,
        item,
        region: regionOutcome.region,
        note: edit.note,
      },
      shape,
    });
  }
  return Result.Ok({
    type: 'edit',
    edit: {
      kind: 'material',
      id: edit.id,
      region: regionOutcome.region,
      swatch: item,
      text: edit.text,
    },
    shape,
  });
};

/**
 * Pin every edit to concrete inputs (item versions, region masks), then
 * compose the edit mask. The result is the immutable render recipe.
 */
export async function resolveRecipe(
  deps: Deps,
  input: { source: SourceImage; editSet: EditSet }
): Promise<
  RenderingResult<{ type: 'recipe'; recipe: RenderRecipe } | RecipeProblem>
> {
  const { source, editSet } = input;
  if (editSet.edits.length === 0 && !editSet.prompt.trim()) {
    return Result.Ok({ type: 'nothing_to_render' });
  }

  const edits: RecipeEdit[] = [];
  const shapes: MaskShape[] = [];
  for (const edit of editSet.edits) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of edits, sequential lookups.
    const resolved = await resolveEdit(deps, source, edit);
    if (resolved.isError()) return Result.Error(resolved.getError());
    const outcome = resolved.get();
    if (outcome.type !== 'edit') return Result.Ok(outcome);
    edits.push(outcome.edit);
    shapes.push(outcome.shape);
  }

  let editMaskKey: string | null = null;
  if (shapes.length > 0) {
    const raw = deps.idGenerator.createId();
    if (raw.isError()) return Result.Error(raw.getError());
    const key = toObjectKey(`edit-masks/${raw.get()}.png`);
    if (key.isError()) return Result.Error(key.getError());
    const composed = await deps.maskCompositor.composeEditMask({
      size: { width: source.width, height: source.height },
      shapes,
      objectKey: key.get(),
    });
    if (composed.isError()) return Result.Error(composed.getError());
    editMaskKey = composed.get().objectKey;
  }

  return Result.Ok({
    type: 'recipe',
    recipe: {
      renderSourceImageId: source.imageId,
      source: {
        workingKey: source.workingKey,
        width: source.width,
        height: source.height,
      },
      edits,
      prompt: editSet.prompt,
      editMaskKey,
    },
  });
}
