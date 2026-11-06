import type { RenderResult } from './render';

export const RENDER_RETRY_AFTER_MS = 30 * 60 * 1000;
export const renderRetryCutoff = (now: Date) =>
  now.getTime() - RENDER_RETRY_AFTER_MS;
export const isRenderRetryable = (
  result: Pick<RenderResult, 'status' | 'attemptStartedAt'>,
  cutoffMs: number
) =>
  result.status === 'failed' ||
  ((result.status === 'pending' || result.status === 'submitted') &&
    result.attemptStartedAt.getTime() <= cutoffMs);
