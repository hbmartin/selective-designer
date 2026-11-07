import { randomUUID } from 'node:crypto';

import { getRenderOutputCleanup } from '../src/composition/render-output-cleanup';
import { getDefaultDbClient } from '../src/modules/kernel/backend';
import { actionableErrorCode } from '../src/modules/kernel/domain/errors/actionable-error-code';
import { safeErrorDiagnostics } from '../src/modules/kernel/domain/errors/safe-error-diagnostics';
import {
  type CleanupCursor,
  validateCleanupPage,
} from '../src/modules/rendering';
import { parseRenderCleanupCommand } from '../src/modules/rendering/backend';

async function main() {
  // run-jiti passes the script filename before the operator arguments.
  const parsed = parseRenderCleanupCommand(process.argv.slice(3));
  if (parsed.isError()) {
    console.error(
      'Usage: pnpm rendering:cleanup [blocked [LIMIT] | inspect FINGERPRINT | requeue FINGERPRINT RESULT_ID ATTEMPT]'
    );
    process.exitCode = 1;
    return;
  }
  const command = parsed.get();
  const db = getDefaultDbClient();
  try {
    const cleanup = getRenderOutputCleanup();
    if (command.type === 'blocked') {
      const result = await cleanup.blocked(command.limit);
      if (result.isError()) throw result.getError();
      console.log(JSON.stringify(result.get(), null, 2));
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
    if (command.type === 'requeue') {
      const requestId = randomUUID();
      const result = await cleanup.requeue({ ...command, requestId });
      if (result.isError()) {
        console.error('Repair outcome is uncertain; inspect before retrying.', {
          requestId,
        });
        throw result.getError();
      }
      console.log(result.get());
      if (
        ![
          'cleanup_requeued',
          'cleanup_already_pending',
          'cleanup_already_completed',
        ].includes(result.get().type)
      )
        process.exitCode = 1;
      return;
    }
    const cutoff = await cleanup.cutoff();
    if (cutoff.isError()) throw cutoff.getError();
    const before = cutoff.get().before;
    let after: CleanupCursor | undefined;
    let completed = 0;
    let failed = 0;
    let blockedThisRun = 0;
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- bounded snapshot pagination.
      const result = await cleanup.list({ before, after });
      if (result.isError()) throw result.getError();
      const page = result.get();
      const validated = validateCleanupPage(page, after);
      if (validated.isError()) throw validated.getError();
      if (page.type === 'cleanup_empty') break;
      for (const id of page.ids) {
        // oxlint-disable-next-line no-await-in-loop -- operator redrive uses one short operation at a time.
        const processed = await cleanup.process(id);
        if (processed.isError()) {
          failed++;
          console.warn('Render cleanup failed.', {
            code: actionableErrorCode(
              processed.getError(),
              'RENDER_OUTPUT_CLEANUP_FAILED'
            ),
            ...safeErrorDiagnostics(processed.getError()),
          });
        } else if (processed.get().type === 'cleanup_completed') completed++;
        else if (processed.get().type === 'cleanup_blocked') blockedThisRun++;
      }
      after = page.cursor;
    }
    const summary = await cleanup.summary();
    if (summary.isError()) throw summary.getError();
    console.log({
      completed,
      failed,
      blockedThisRun,
      blockedTotal: summary.get().blockedTotal,
      blockedReasons: summary.get().reasons,
    });
    if (failed) process.exitCode = 1;
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
