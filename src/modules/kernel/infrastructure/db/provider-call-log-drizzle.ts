import { Result } from '@bloodyowl/boxed';
import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';

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
          const written = await db
            .insert(providerCall)
            .values(values)
            .onConflictDoUpdate({
              target: providerCall.id,
              setWhere: and(
                ne(providerCall.status, 'succeeded'),
                eq(providerCall.provider, values.provider),
                eq(providerCall.endpoint, values.endpoint),
                or(
                  and(
                    eq(providerCall.status, 'submitted'),
                    isNull(providerCall.providerRequestId)
                  ),
                  sql`${providerCall.providerRequestId} is not distinct from ${values.providerRequestId}`
                ),
                or(
                  eq(providerCall.status, 'submitted'),
                  sql`${values.status} = 'succeeded'`
                )
              ),
              set: {
                providerRequestId: values.providerRequestId,
                status: values.status,
                costUsdMicros: sql`coalesce(${values.costUsdMicros}, ${providerCall.costUsdMicros})`,
                costSource: sql`case when ${values.costUsdMicros}::bigint is null and ${providerCall.costUsdMicros} is not null then ${providerCall.costSource} else ${values.costSource} end`,
                details: values.details,
                completedAt: values.completedAt,
              },
            })
            .returning({ id: providerCall.id });
          if (!written.length) {
            const [existing] = await db
              .select()
              .from(providerCall)
              .where(eq(providerCall.id, call.id));
            if (
              !existing ||
              existing.provider !== call.provider ||
              existing.endpoint !== call.endpoint ||
              existing.providerRequestId !== (call.providerRequestId ?? null)
            )
              return Result.Error(
                new AppError({
                  code: 'PROVIDER_CALL_IDENTITY_MISMATCH',
                  category: 'system',
                  status: 500,
                  message:
                    'Provider call identity does not match its recorded request',
                })
              );
          }
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
