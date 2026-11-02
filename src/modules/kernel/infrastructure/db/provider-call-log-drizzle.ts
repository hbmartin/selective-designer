import { Result } from '@bloodyowl/boxed';

import type { ProviderCallLog } from '@/modules/kernel/application/ports/provider-call-log';
import { AppError } from '@/modules/kernel/domain/errors/app-error';
import { observeRepository } from '@/modules/kernel/infrastructure/db/observability';
import { providerCall } from '@/modules/kernel/infrastructure/db/schema/provider-call';
import type { DbLike } from '@/modules/kernel/infrastructure/db/types';

export const createProviderCallLog = ({
  db,
}: {
  db: DbLike;
}): ProviderCallLog =>
  observeRepository<ProviderCallLog>(
    {
      async record(call) {
        const values = {
          id: call.id,
          userId: call.userId ?? null,
          designId: call.designId ?? null,
          purpose: call.purpose,
          provider: call.provider,
          endpoint: call.endpoint,
          subjectId: call.subjectId ?? null,
          providerRequestId: call.providerRequestId ?? null,
          status: call.status,
          costUsdMicros: call.costUsdMicros ?? null,
          costSource: call.costSource,
          details: call.details,
          startedAt: call.startedAt,
          completedAt: call.completedAt ?? null,
        };
        try {
          await db
            .insert(providerCall)
            .values(values)
            .onConflictDoUpdate({
              target: providerCall.id,
              set: {
                providerRequestId: values.providerRequestId,
                status: values.status,
                costUsdMicros: values.costUsdMicros,
                costSource: values.costSource,
                details: values.details,
                completedAt: values.completedAt,
              },
            });
          return Result.Ok({ type: 'provider_call_recorded' as const });
        } catch (error) {
          return Result.Error(
            new AppError({
              code: 'PROVIDER_CALL_LOG_FAILED',
              category: 'system',
              status: 500,
              message: 'Recording a provider call failed',
              cause: error,
            })
          );
        }
      },
    },
    'provider_call'
  );
