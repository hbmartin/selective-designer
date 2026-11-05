import type { ProviderCostSource } from '@/modules/kernel';
import type { ObjectKey } from '@/modules/kernel/domain/ids';

/** Server-only recovery data; never part of RenderResult or browser views. */
export type RenderOutputCheckpoint = {
  source: { kind: 'url'; url: string } | { kind: 'object' };
  objectKey: ObjectKey;
  contentType: string | null;
  modelVersion: string | null;
  costUsdMicros: number | null;
  costSource: ProviderCostSource;
  completedAt: string;
};
