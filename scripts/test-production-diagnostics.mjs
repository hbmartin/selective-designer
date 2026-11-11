import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
// oxlint-disable-next-line vitest/no-import-node-test -- Run against the built app without Vite or Vitest runtime hooks.
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

const terminal = 'rendering.result.failure_persistence_unresolved';
const sibling = 'rendering.result.submission_unresolved';
const workflow =
  'step//./src/modules/rendering/transport/workflows/render-workflow//';
const entry = pathToFileURL(
  resolve(
    process.env.PRODUCTION_DIAGNOSTICS_ENTRY ?? '.output/server/index.mjs'
  )
).href;
const run = promisify(execFile);
const scenarios = [
  { name: 'console without a sink', fallback: 1 },
  { name: 'OTel alone', otel: 200, fallback: 0 },
  { name: 'Sentry alone', sentry: 200, fallback: 0 },
  {
    name: 'both sinks with concurrent steps',
    otel: 200,
    sentry: 200,
    concurrent: true,
    fallback: 0,
  },
  {
    name: 'OTel rejects while Sentry succeeds',
    otel: 403,
    sentry: 200,
    fallback: 1,
  },
  {
    name: 'Sentry rejects while OTel succeeds',
    otel: 200,
    sentry: 403,
    fallback: 1,
  },
  {
    name: 'configured sink fails initialization',
    otel: 200,
    invalidSentry: true,
    fallback: 1,
  },
  { name: 'slow sink falls back at the deadline', otel: 'hang', fallback: 1 },
  {
    name: 'explicit console mirror writes once on failure',
    sentry: 403,
    mirror: true,
    fallback: 1,
  },
];

for (const scenario of scenarios) {
  test(scenario.name, async () => {
    const received = { otel: [], sentry: [] };
    const receiver = createServer(async (req, res) => {
      const sink = req.url?.startsWith('/v1/') ? 'otel' : 'sentry';
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      received[sink].push(
        (req.headers['content-encoding'] === 'gzip'
          ? gunzipSync(body)
          : body
        ).toString()
      );
      const status = scenario[sink];
      if (status === 'hang') return;
      res.writeHead(status ?? 404);
      res.end();
    });
    await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    try {
      const port = receiver.address().port;
      const env = {
        ...process.env,
        NODE_ENV: 'production',
        NITRO_HOST: '127.0.0.1',
        NITRO_PORT: '0',
        SENTRY_DSN: scenario.invalidSentry
          ? 'http://127.0.0.1/invalid-dsn'
          : scenario.sentry
            ? `http://public@127.0.0.1:${port}/1`
            : '',
        VITE_SENTRY_DSN: '',
        OTEL_COLLECTOR_URL: scenario.otel ? `http://127.0.0.1:${port}` : '',
        OTEL_COLLECTOR_BEARER_TOKEN: '',
      };
      delete env.LOGGER_LEVEL;
      delete env.LOGGER_PRETTY;
      delete env.LOGGER_CONSOLE_MIRROR;
      if (scenario.mirror) env.LOGGER_CONSOLE_MIRROR = 'true';
      const { stdout, stderr } = await run(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
          import assert from 'node:assert/strict';
          await import(${JSON.stringify(entry)});
          assert(globalThis[Symbol.for('selective-designer.server-telemetry')], 'Nitro telemetry plugin did not initialize');
          const steps = globalThis[Symbol.for('@workflow/core//registeredSteps')];
          const step = steps?.get(${JSON.stringify(workflow + 'failureDiagnosticStep')});
          assert.equal(typeof step, 'function', 'Generated failure diagnostic step missing');
          const input = { resultId: 'result-1', attempt: 1, workflowRunId: 'workflow-1', providerRequestId: 'private-locator-fixture' };
          const error = { code: 'DB_UNAVAILABLE', errorNames: ['AppError'], errorCodes: ['DB_UNAVAILABLE'], message: 'private-message-fixture' };
          await step(input, 'PROVIDER_UNAVAILABLE', true, error, false);
          await Promise.all([
            step(input, 'PROVIDER_UNAVAILABLE', true, error, true),
            ${scenario.concurrent ? `steps.get(${JSON.stringify(workflow + 'unresolvedSubmissionStep')})({ ...input, resultId: 'result-2' }, 'DB_UNAVAILABLE', true)` : 'undefined'}
          ]);
          // Exit as soon as the real step resolves. No test-only export or flush.
          process.exit(0);
        `,
        ],
        { env, timeout: 15_000 }
      );
      const output = stdout + stderr;
      assert.equal(
        output.split('\n').filter((line) => line.startsWith(terminal)).length,
        scenario.fallback
      );
      const allLogs =
        output + received.otel.join('') + received.sentry.join('');
      assert(!allLogs.includes('private-locator-fixture'));
      assert(!allLogs.includes('private-message-fixture'));
      assert(!allLogs.includes('failure_persistence_exception'));
      if (scenario.otel)
        assert(
          received.otel.some(
            (body) => body.includes(terminal) && body.includes('DB_UNAVAILABLE')
          )
        );
      if (scenario.sentry) {
        assert(
          received.sentry.some(
            (body) =>
              body.includes(terminal) && body.includes('terminal-diagnostic')
          )
        );
      }
      if (scenario.concurrent) {
        assert(
          received.otel.some(
            (body) => body.includes(sibling) && body.includes('result-2')
          )
        );
        assert(
          received.sentry.some(
            (body) => body.includes(sibling) && body.includes('result-2')
          )
        );
      }
    } finally {
      receiver.closeAllConnections();
      await new Promise((resolve) => receiver.close(resolve));
    }
  });
}
