import { createRenderingQueries, type RenderingQueryFacade } from './queries';
import {
  renderDraftFromOriginal,
  renderDraftGet,
  renderDraftSave,
  renderGet,
  renderPlanPreview,
  renderResultNameScheme,
  renderResultPrefer,
  renderResultRetry,
  renderScorecardGet,
  rendersGet,
  renderSourceGet,
  renderSubmit,
  renderSubmitBatch,
} from '../server';

export const renderingQueries = createRenderingQueries({
  renderDraftFromOriginal,
  renderDraftGet,
  renderDraftSave,
  renderGet,
  renderScorecardGet,
  renderSourceGet,
  renderPlanPreview,
  renderResultNameScheme,
  renderResultPrefer,
  renderResultRetry,
  rendersGet,
  renderSubmit,
  renderSubmitBatch,
} satisfies RenderingQueryFacade);
