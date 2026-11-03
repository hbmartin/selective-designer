import { createRenderingQueries, type RenderingQueryFacade } from './queries';
import {
  renderDraftGet,
  renderDraftSave,
  renderPlanPreview,
  renderResultNameScheme,
  renderResultPrefer,
  renderResultRetry,
  rendersGet,
  renderSourceGet,
  renderSubmit,
  renderSubmitBatch,
} from '../server';

export const renderingQueries = createRenderingQueries({
  renderDraftGet,
  renderDraftSave,
  renderSourceGet,
  renderPlanPreview,
  renderResultNameScheme,
  renderResultPrefer,
  renderResultRetry,
  rendersGet,
  renderSubmit,
  renderSubmitBatch,
} satisfies RenderingQueryFacade);
