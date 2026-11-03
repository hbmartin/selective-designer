import type { ModelId, ModelSpec } from './model-catalog';
import { recipeReferences, type RenderRecipe } from './recipe';

export type ModelPlan =
  | { modelId: ModelId; decision: 'include' }
  | {
      modelId: ModelId;
      decision: 'skip';
      reason: 'too_many_references';
      limit: number;
      references: number;
    };

export type SmallItemWarning = {
  editId: string;
  modelId: ModelId;
  sizePx: { width: number; height: number };
  minPx: { width: number; height: number };
};

export type RenderPlan = {
  models: ModelPlan[];
  warnings: SmallItemWarning[];
};

/**
 * Decide which models can take the recipe. A model that cannot take every
 * reference is skipped with a reason; edits are never silently dropped.
 */
export const planRender = (
  recipe: Pick<RenderRecipe, 'edits' | 'editMaskKey' | 'source'>,
  models: readonly ModelSpec[]
): RenderPlan => {
  const references = recipeReferences({
    ...recipe,
    prompt: '',
    renderSourceImageId: '',
  }).length;
  const plans: ModelPlan[] = models.map((model) => {
    const usesMask = model.targeting === 'mask' && recipe.editMaskKey !== null;
    const limit = usesMask ? model.maxReferencesWithMask : model.maxReferences;
    return references > limit
      ? {
          modelId: model.id,
          decision: 'skip',
          reason: 'too_many_references',
          limit,
          references,
        }
      : { modelId: model.id, decision: 'include' };
  });

  const warnings: SmallItemWarning[] = [];
  for (const edit of recipe.edits) {
    if (edit.kind !== 'placement') continue;
    const sizePx = {
      width: Math.round(edit.box.width * recipe.source.width),
      height: Math.round(edit.box.height * recipe.source.height),
    };
    for (const model of models) {
      if (
        sizePx.width < model.minTargetPx.width ||
        sizePx.height < model.minTargetPx.height
      ) {
        warnings.push({
          editId: edit.id,
          modelId: model.id,
          sizePx,
          minPx: model.minTargetPx,
        });
      }
    }
  }
  return { models: plans, warnings };
};
