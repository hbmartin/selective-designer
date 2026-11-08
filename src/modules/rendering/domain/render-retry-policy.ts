import type { RenderResult } from './render';

export const RENDER_RETRY_AFTER_MS = 30 * 60 * 1000;
export const RENDER_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const isPlausibleRenderStart = (startedAtMs: number, nowMs: number) =>
  Number.isFinite(startedAtMs) &&
  Number.isFinite(nowMs) &&
  startedAtMs <= nowMs + RENDER_CLOCK_SKEW_MS;
export const renderAttemptDeadline = (
  startedAt: Date
):
  | { type: 'render_deadline_valid'; deadlineAt: string }
  | { type: 'render_deadline_invalid' } => {
  const deadline = new Date(startedAt.getTime() + RENDER_RETRY_AFTER_MS);
  return Number.isFinite(deadline.getTime())
    ? { type: 'render_deadline_valid', deadlineAt: deadline.toISOString() }
    : { type: 'render_deadline_invalid' };
};
export const renderRetryCutoff = (now: Date) =>
  now.getTime() - RENDER_RETRY_AFTER_MS;
export const isRenderRetryable = (
  result: Pick<RenderResult, 'status' | 'attemptStartedAt'>,
  cutoffMs: number
) =>
  result.status === 'failed' ||
  ((result.status === 'pending' || result.status === 'submitted') &&
    result.attemptStartedAt.getTime() <= cutoffMs);
