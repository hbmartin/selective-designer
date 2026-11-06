import { getRenderOutputCleanup } from '../src/composition/render-output-cleanup';
import { getDefaultDbClient } from '../src/modules/kernel/backend';
import { actionableErrorCode } from '../src/modules/kernel/domain/errors/actionable-error-code';
import { safeErrorDiagnostics } from '../src/modules/kernel/domain/errors/safe-error-diagnostics';
import { systemClock } from '../src/modules/kernel/infrastructure/clock/system-clock';

let db: ReturnType<typeof getDefaultDbClient> | undefined;
try {
  db = getDefaultDbClient();
  const cleanup = getRenderOutputCleanup();
  const before = systemClock.now().toISOString();
  let after: string | undefined;
  let completed = 0;
  let failed = 0;
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- bounded snapshot pagination.
    const page = await cleanup.list({ before, after });
    if (page.isError()) throw page.getError();
    if (!page.get().ids.length) break;
    for (const id of page.get().ids) {
      // oxlint-disable-next-line no-await-in-loop -- operator redrive uses one short operation at a time.
      const result = await cleanup.process(id);
      if (result.isError()) {
        failed++;
        console.warn('Render cleanup failed.', {
          code: actionableErrorCode(
            result.getError(),
            'RENDER_OUTPUT_CLEANUP_FAILED'
          ),
          ...safeErrorDiagnostics(result.getError()),
        });
      } else if (result.get().type === 'cleanup_completed') completed++;
    }
    after = page.get().ids.at(-1);
  }
  console.log({ completed, failed });
  if (failed) process.exitCode = 1;
} catch (error) {
  console.error('Rendering cleanup failed.', {
    code: actionableErrorCode(error, 'RENDER_OUTPUT_CLEANUP_FAILED'),
    ...safeErrorDiagnostics(error),
  });
  process.exitCode = 1;
} finally {
  try {
    await db?.$close();
  } catch (error) {
    console.error('Closing the cleanup database connection failed.', {
      code: actionableErrorCode(error, 'DATABASE_CLOSE_FAILED'),
      ...safeErrorDiagnostics(error),
    });
    process.exitCode = 1;
  }
}
