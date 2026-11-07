import { randomUUID } from 'node:crypto';

import { getRenderOutputCleanup } from '../src/composition/render-output-cleanup';
import type { ApplicationResult } from '../src/modules/kernel';
import { getDefaultDbClient } from '../src/modules/kernel/backend';
import { actionableErrorCode } from '../src/modules/kernel/domain/errors/actionable-error-code';
import { safeErrorDiagnostics } from '../src/modules/kernel/domain/errors/safe-error-diagnostics';
import type {
  CleanupAcknowledgmentOutcome,
  CleanupRepairOutcome,
} from '../src/modules/rendering';
import {
  encodeBlockedCursor,
  parseRenderCleanupCommand,
  runRenderCleanupSweep,
} from '../src/modules/rendering/backend';

async function main() {
  // run-jiti passes the script filename before the operator arguments.
  const parsed = parseRenderCleanupCommand(process.argv.slice(3));
  if (parsed.isError()) {
    console.error(
      'Usage: pnpm rendering:cleanup [blocked [LIMIT] [--after CURSOR] [--outstanding] | inspect FINGERPRINT | requeue FINGERPRINT RESULT_ID ATTEMPT [--request-id UUID] | acknowledge FINGERPRINT [--request-id UUID]]'
    );
    process.exitCode = 1;
    return;
  }
  const command = parsed.get();
  const db = getDefaultDbClient();
  try {
    const cleanup = getRenderOutputCleanup();
    if (command.type === 'blocked') {
      const result = await cleanup.blocked(command);
      if (result.isError()) throw result.getError();
      const page = result.get();
      console.log(
        JSON.stringify(
          {
            ...page,
            nextCursor:
              page.pagination.type === 'blocked_more'
                ? encodeBlockedCursor(page.pagination.cursor)
                : undefined,
          },
          null,
          2
        )
      );
      return;
    }
    if (command.type === 'inspect') {
      const result = await cleanup.inspect(command.fingerprint);
      if (result.isError()) throw result.getError();
      // Explicit privileged inspection is the only command that discloses a safe locator.
      console.log(JSON.stringify(result.get(), null, 2));
      if (result.get().type === 'blocked_not_found') process.exitCode = 1;
      return;
    }
    if (command.type === 'requeue' || command.type === 'acknowledge') {
      const requestId = command.requestId ?? randomUUID();
      console.log({ requestId });
      const result: ApplicationResult<
        CleanupAcknowledgmentOutcome | CleanupRepairOutcome
      > =
        command.type === 'requeue'
          ? await cleanup.requeue({ ...command, requestId })
          : await cleanup.acknowledge({ ...command, requestId });
      if (result.isError()) {
        console.error(
          'Repair outcome is uncertain; inspect or replay using this request ID.',
          {
            requestId,
          }
        );
        throw result.getError();
      }
      console.log(result.get());
      if (
        ![
          'cleanup_acknowledged',
          'cleanup_requeued',
          'cleanup_already_pending',
          'cleanup_already_completed',
        ].includes(result.get().type)
      )
        process.exitCode = 1;
      return;
    }
    const sweep = await runRenderCleanupSweep(
      {
        cutoff: async () => {
          const result = await cleanup.cutoff();
          if (result.isError()) throw result.getError();
          return result.get().before;
        },
        list: async (input) => {
          const result = await cleanup.list(input);
          if (result.isError()) throw result.getError();
          return result.get();
        },
        process: async (id) => {
          const result = await cleanup.process(id);
          if (result.isError()) {
            console.warn('Render cleanup failed.', {
              code: actionableErrorCode(
                result.getError(),
                'RENDER_OUTPUT_CLEANUP_FAILED'
              ),
              ...safeErrorDiagnostics(result.getError()),
            });
            throw result.getError();
          }
          return result.get();
        },
        summary: async () => {
          const result = await cleanup.summary();
          if (result.isError()) throw result.getError();
          return result.get();
        },
      },
      1
    );
    console.log(sweep);
    if (sweep.failed) process.exitCode = 1;
  } finally {
    try {
      await db.$close();
    } catch (error) {
      console.error('Closing the cleanup database connection failed.', {
        code: actionableErrorCode(error, 'DATABASE_CLOSE_FAILED'),
        ...safeErrorDiagnostics(error),
      });
      process.exitCode = 1;
    }
  }
}
try {
  await main();
} catch (error) {
  console.error('Rendering cleanup failed.', {
    code: actionableErrorCode(error, 'RENDER_OUTPUT_CLEANUP_FAILED'),
    ...safeErrorDiagnostics(error),
  });
  process.exitCode = 1;
}
