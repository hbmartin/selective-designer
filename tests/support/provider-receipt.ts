import type { ProviderCallReceipt } from '@/modules/kernel';
import { providerCallIdentity } from '@/modules/kernel/domain/provider-call-identity';

import { okValue } from './result';

export const makeProviderReceipt = (
  overrides: Partial<ProviderCallReceipt> = {}
): ProviderCallReceipt => {
  const receipt = {
    userId: undefined,
    designId: 'receipt-design',
    subjectId: 'receipt-subject',
    purpose: 'render' as const,
    provider: 'fal',
    endpoint: 'test-model',
    providerRequestId: 'native-1',
    status: 'succeeded' as const,
    costUsdMicros: 123,
    costSource: 'reported' as const,
    details: { attempt: 1 },
    startedAt: '2026-11-06T00:00:00.000Z',
    completedAt: '2026-11-06T00:00:01.000Z',
    ...overrides,
  };
  return JSON.parse(
    JSON.stringify({
      ...receipt,
      id:
        overrides.id ??
        okValue(
          providerCallIdentity({ ...receipt, invocationId: 'fallback-one' })
        ),
    })
  ) as ProviderCallReceipt;
};
