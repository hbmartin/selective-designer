import type { ProviderCallReceipt } from '@/modules/kernel';
import type { ProviderCostSource } from '@/modules/kernel';
import type { ObjectKey, UserId } from '@/modules/kernel/domain/ids';

/** Private output reference for recovery of one background-removal attempt. */
export type CutoutOutputCheckpoint = {
  /** Absent only on checkpoints written before durable accounting. */
  receipt?: ProviderCallReceipt;
  source:
    | { kind: 'url'; url: string }
    | { kind: 'object' }
    | { kind: 'retired' };
  objectKey: ObjectKey;
  contentType: string | null;
  /** Optional only for checkpoints created before accounting recovery. */
  startedAt?: string;
  userId?: UserId | null;
  provider: string;
  endpoint: string;
  providerRequestId: string | undefined;
  costUsdMicros: number | undefined;
  costSource: ProviderCostSource;
  completedAt: string;
};
