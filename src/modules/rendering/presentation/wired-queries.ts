import { createRenderingQueries, type RenderingQueryFacade } from './queries';
import {
  renderDraftGet,
  renderDraftSave,
  renderPlanPreview,
  renderResultNameScheme,
  renderResultPrefer,
  renderResultRetry,
  rendersGet,
  renderSubmit,
  renderSubmitBatch,
} from '../server';

export const renderingQueries = createRenderingQueries({
  renderDraftGet,
  renderDraftSave,
  renderPlanPreview,
  renderResultNameScheme,
  renderResultPrefer,
  renderResultRetry,
  rendersGet,
  renderSubmit,
  renderSubmitBatch,
} satisfies RenderingQueryFacade);
