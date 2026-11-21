import { startE2EWebserver } from '../tests/server/e2e-webserver';

try {
  await startE2EWebserver();
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'E2E webserver startup failed'
  );
  process.exitCode = 1;
}
