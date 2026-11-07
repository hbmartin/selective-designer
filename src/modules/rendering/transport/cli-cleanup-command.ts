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
const requestId = z.uuid().optional();
const cursor = z.object({ createdAt: z.iso.datetime(), fingerprint }).strict();
const command = z.discriminatedUnion('type', [
  z.object({ type: z.literal('sweep') }).strict(),
  z
    .object({
      type: z.literal('blocked'),
      limit: z
        .string()
        .regex(/^[0-9]+$/u)
        .transform(Number)
        .pipe(z.number().int().min(1).max(100)),
      after: cursor.optional(),
      outstanding: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal('inspect'), fingerprint }).strict(),
  z.object({ type: z.literal('acknowledge'), fingerprint, requestId }).strict(),
  z
    .object({
      type: z.literal('requeue'),
      fingerprint,
      resultId: z.string().refine(validRenderResultIdentity),
      attempt: z
        .string()
        .regex(/^[0-9]+$/u)
        .transform(Number)
        .refine(validRenderAttempt),
      requestId,
    })
    .strict(),
]);
export const encodeBlockedCursor = (value: z.output<typeof cursor>) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

/** Tokenization and one boundary schema parse; unknown, duplicate and incomplete flags fail. */
function commandInput(argv: string[]) {
  if (!argv.length) return { type: 'sweep' };
  const [type, ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, unknown> = {};
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index]!;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key =
      (
        {
          '--request-id': 'requestId',
          '--outstanding': 'outstanding',
          '--after': 'after',
        } as Record<string, string>
      )[token] ?? token;
    if (key in flags) return { invalid: true };
    if (key === 'outstanding') flags[key] = true;
    else {
      const value = rest[++index];
      if (value === undefined || value.startsWith('--'))
        return { invalid: true };
      flags[key] = value;
    }
  }
  if ('after' in flags) {
    try {
      flags.after = JSON.parse(
        Buffer.from(String(flags.after), 'base64url').toString('utf8')
      );
    } catch {
      return { invalid: true };
    }
  }
  if (type === 'blocked' && positional.length <= 1)
    return { type, limit: positional[0] ?? '100', ...flags };
  if ((type === 'inspect' || type === 'acknowledge') && positional.length === 1)
    return { type, fingerprint: positional[0], ...flags };
  if (type === 'requeue' && positional.length === 3)
    return {
      type,
      fingerprint: positional[0],
      resultId: positional[1],
      attempt: positional[2],
      ...flags,
    };
  return { invalid: true };
}
type CleanupCommand =
  | Exclude<z.output<typeof command>, { type: 'requeue' }>
  | (Omit<
      Extract<z.output<typeof command>, { type: 'requeue' }>,
      'resultId'
    > & { resultId: RenderResultId });
export function parseRenderCleanupCommand(
  argv: string[]
): ApplicationResult<CleanupCommand> {
  const parsed = command.safeParse(commandInput(argv));
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
  if (resultId.isError()) return Result.Error(resultId.getError());
  return Result.Ok({ ...parsed.data, resultId: resultId.get() });
}
