import type { ApplicationResult } from '../result';
import type { ProviderCallId, UserId } from '../../domain/ids';

export const providerCallPurposes = [
  'render',
  'segmentation',
  'background_removal',
] as const;
export type ProviderCallPurpose = (typeof providerCallPurposes)[number];

export const providerCallStatuses = [
  'submitted',
  'succeeded',
  'failed',
] as const;
export type ProviderCallStatus = (typeof providerCallStatuses)[number];

/**
 * Where a cost figure came from. `unavailable` is explicit: unknown cost is
 * never recorded as zero.
 */
export const providerCostSources = [
  'reported',
  'price_table',
  'unavailable',
] as const;
export type ProviderCostSource = (typeof providerCostSources)[number];

export type ProviderCallRecord = {
  id: ProviderCallId;
  userId: UserId | undefined;
  designId: string | undefined;
  purpose: ProviderCallPurpose;
  provider: string;
  endpoint: string;
  subjectId: string | undefined;
  providerRequestId: string | undefined;
  status: ProviderCallStatus;
  costUsdMicros: number | undefined;
  costSource: ProviderCostSource;
  details: Record<string, unknown>;
  startedAt: Date;
  completedAt: Date | undefined;
};

export type ProviderCallRecordedOutcome = { type: 'provider_call_recorded' };

/** Append/update log of paid provider calls. Logging only — no caps. */
export interface ProviderCallLog {
  /** Insert or update by `id`; safe to repeat when a workflow step retries. */
  record(
    call: ProviderCallRecord
  ): Promise<ApplicationResult<ProviderCallRecordedOutcome>>;
}
