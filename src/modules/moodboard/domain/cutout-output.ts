import type { ProviderCostSource } from '@/modules/kernel';
import type { ObjectKey } from '@/modules/kernel/domain/ids';

/** Private output reference for recovery of one background-removal attempt. */
export type CutoutOutputCheckpoint = {
  source: { kind: 'url'; url: string } | { kind: 'object' };
  objectKey: ObjectKey;
  contentType: string | null;
  provider: string;
  endpoint: string;
  providerRequestId: string | undefined;
  costUsdMicros: number | undefined;
  costSource: ProviderCostSource;
  completedAt: string;
};
