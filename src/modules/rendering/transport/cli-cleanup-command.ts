import { Result } from '@bloodyowl/boxed';
import { z } from 'zod';

import type { ApplicationResult } from '@/modules/kernel';
import { AppError } from '@/modules/kernel/domain/errors/app-error';
import type { RenderResultId } from '@/modules/kernel/domain/ids';
import { toRenderResultId } from '@/modules/kernel/domain/ids';

import {
  validRenderAttempt,
  validRenderResultIdentity,
} from '../domain/render-output-target';

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/u);
const command = z.union([
  z.tuple([]).transform(() => ({ type: 'sweep' as const })),
  z
    .tuple([
      z.literal('blocked'),
      z
        .string()
        .regex(/^[0-9]+$/u)
        .transform(Number)
        .pipe(z.number().int().min(1).max(100))
        .optional(),
    ])
    .transform(([, limit]) => ({
      type: 'blocked' as const,
      limit: limit ?? 100,
    })),
  z.tuple([z.literal('inspect'), fingerprint]).transform(([, fingerprint]) => ({
    type: 'inspect' as const,
    fingerprint,
  })),
  z
    .tuple([
      z.literal('requeue'),
      fingerprint,
      z.string().refine(validRenderResultIdentity),
      z
        .string()
        .regex(/^[0-9]+$/u)
        .transform(Number)
        .refine(validRenderAttempt),
    ])
    .transform(([, fingerprint, resultId, attempt]) => ({
      type: 'requeue' as const,
      fingerprint,
      resultId,
      attempt,
    })),
]);
type CleanupCommand =
  | Exclude<z.output<typeof command>, { type: 'requeue' }>
  | {
      type: 'requeue';
      fingerprint: string;
      resultId: RenderResultId;
      attempt: number;
    };
export function parseRenderCleanupCommand(
  argv: string[]
): ApplicationResult<CleanupCommand> {
  const parsed = command.safeParse(argv);
  if (!parsed.success)
    return Result.Error(
      new AppError({
        code: 'RENDER_CLEANUP_COMMAND_INVALID',
        category: 'bad_request',
        status: 400,
        retryable: false,
      })
    );
  if (parsed.data.type !== 'requeue') return Result.Ok(parsed.data);
  const resultId = toRenderResultId(parsed.data.resultId);
  return resultId.isError()
    ? Result.Error(resultId.getError())
    : Result.Ok({ ...parsed.data, resultId: resultId.get() });
}
