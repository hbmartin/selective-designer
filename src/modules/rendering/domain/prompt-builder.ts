import type { FractionalBox } from './edit-set';
import type { ModelId } from './model-catalog';
import { type RecipeEdit, recipeReferences, type RenderRecipe } from './recipe';

const PRESERVE =
  'Keep everything outside the target areas unchanged: the same camera, framing, geometry, lighting and materials.';
const FIDELITY =
  'Reproduce each referenced product faithfully: silhouette, proportions, distinctive details and finish. Perspective, scene lighting, shadows and reflections may adapt to the scene.';

const clampGrid = (value: number) =>
  Math.round(Math.min(1, Math.max(0, value)) * 1000);

/** FLUX 3 box: `[top, left, bottom, right]` on a 0–1000 grid. */
export const toFluxBox = (
  box: FractionalBox
): [number, number, number, number] => [
  clampGrid(box.y),
  clampGrid(box.x),
  clampGrid(box.y + box.height),
  clampGrid(box.x + box.width),
];

/** How each model refers to the n-th reference (1-based; the source is separate). */
const referenceName = (modelId: ModelId, n: number) => {
  switch (modelId) {
    case 'krea-3':
      return `<image-${n + 1}>`; // image_urls[0] is the render source
    case 'flux-3-image':
      return `<ref_image_${n}>`; // ref_image_0 is the render source
    default:
      return `reference image ${n}`;
  }
};

const areaName = (modelId: ModelId, index: number) =>
  modelId === 'krea-3'
    ? `@edit${index + 1}`
    : modelId === 'flux-3-image'
      ? `<edit_${index + 1}>`
      : 'the masked area';

const editBox = (edit: RecipeEdit) =>
  edit.kind === 'placement' ? edit.box : edit.region.box;

const describeEdit = (
  edit: RecipeEdit,
  index: number,
  modelId: ModelId,
  ref: (itemVersionId: string) => string
): string => {
  const area = areaName(modelId, index);
  const note = (text: string) => (text.trim() ? ` ${text.trim()}` : '');
  switch (edit.kind) {
    case 'placement': {
      const rotation = Math.round(edit.rotationDeg) % 360;
      return `Place "${edit.item.name}" (${ref(edit.item.itemVersionId)}) in ${area}${rotation ? `, rotated ${rotation}°` : ''}, sized to fill it.${note(edit.note)}`;
    }
    case 'replacement':
      return `Replace the ${edit.region.label} in ${area} with "${edit.item.name}" (${ref(edit.item.itemVersionId)}).${note(edit.note)}`;
    case 'removal':
      return `Remove the ${edit.region.label} in ${area} and fill the area naturally to match its surroundings.${note(edit.note)}`;
    case 'material':
      return edit.swatch
        ? `Change the surface of the ${edit.region.label} in ${area} to the material in ${ref(edit.swatch.itemVersionId)} ("${edit.swatch.name}"), following its geometry.${note(edit.text)}`
        : `Change the surface of the ${edit.region.label} in ${area} to ${edit.text.trim() || 'the requested material'}, following its geometry.`;
  }
};

/** FLUX 3 element table rows (appended to the prompt as JSON). */
export const fluxElementRows = (recipe: RenderRecipe) =>
  recipe.edits.map((edit, index) => {
    const id = `edit_${index + 1}`;
    const box = toFluxBox(editBox(edit));
    const desc =
      edit.kind === 'placement' || edit.kind === 'replacement'
        ? edit.item.name
        : edit.kind === 'removal'
          ? `${edit.region.label} to remove`
          : `${edit.region.label} with new material`;
    return edit.kind === 'removal'
      ? { id, from: 'ref_image_0', src_bbox: box, tgt_bbox: null, desc }
      : { id, from: null, src_bbox: null, tgt_bbox: box, desc };
  });

/**
 * The model-specific instruction text for a recipe. Reference images are
 * numbered from 1 in the order they are sent after the render source.
 */
export const buildPrompt = (recipe: RenderRecipe, modelId: ModelId): string => {
  const references = recipeReferences(recipe);
  const ref = (itemVersionId: string) =>
    referenceName(
      modelId,
      references.findIndex((item) => item.itemVersionId === itemVersionId) + 1
    );
  const lines = recipe.edits.map((edit, index) =>
    describeEdit(edit, index, modelId, ref)
  );
  const text = [
    modelId === 'flux-3-image' && lines.length > 0 ? 'Edit <ref_image_0>.' : '',
    ...lines,
    recipe.prompt.trim(),
    lines.length > 0 ? PRESERVE : '',
    references.some((item) => item.kind !== 'swatch') ? FIDELITY : '',
  ]
    .filter(Boolean)
    .join('\n');
  return modelId === 'flux-3-image' && recipe.edits.length > 0
    ? `${text} ${JSON.stringify(fluxElementRows(recipe))}`
    : text;
};
