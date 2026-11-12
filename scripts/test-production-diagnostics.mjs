import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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
const httpEntry = process.env.PRODUCTION_DIAGNOSTICS_HTTP_ENTRY
  ? pathToFileURL(resolve(process.env.PRODUCTION_DIAGNOSTICS_HTTP_ENTRY)).href
  : entry;
const run = promisify(execFile);
const scenarios = [
  { name: 'console without a sink', fallback: 1 },
  { name: 'OTel alone', otel: 200, fallback: 0 },
  { name: 'Sentry alone', sentry: 200, fallback: 0 },
  {
    name: 'Sentry fallback isolates concurrent SSR requests',
    sentry: 200,
    sentryFallback: true,
    requests: true,
    fallback: 0,
  },
  {
    name: 'Both sinks isolate requests and prefer the server DSN',
    otel: 200,
    sentry: 200,
    requests: true,
    fallback: 0,
  },
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
  {
    name: 'a retryable collector rejection gets exactly one attempt',
    otel: 503,
    singleAttempt: true,
    fallback: 1,
  },
  {
    name: 'a partial collector rejection gets exactly one attempt',
    otel: 200,
    partialRejection: true,
    singleAttempt: true,
    fallback: 1,
  },
  { name: 'slow sink falls back at the deadline', otel: 'hang', fallback: 1 },
  {
    name: 'ordinary batch logs survive terminal delivery saturation',
    otel: 'hang',
    saturation: true,
    fallback: 31,
  },
  {
    name: 'Sentry reports a sanitized configuration failure and boot fails closed',
    sentry: 200,
    bootFailure: true,
  },
  {
    name: 'test runtime does not start configured sinks',
    sentry: 200,
    otel: 200,
    testRuntime: true,
    fallback: 1,
  },
  {
    name: 'explicit console mirror writes once on failure',
    sentry: 403,
    mirror: true,
    fallback: 1,
  },
];

const setup = `
  const steps = globalThis[Symbol.for('@workflow/core//registeredSteps')];
  const step = steps?.get(${JSON.stringify(workflow + 'failureDiagnosticStep')});
  assert.equal(typeof step, 'function', 'Generated failure diagnostic step missing');
  const input = { resultId: 'result-1', attempt: 1, workflowRunId: 'workflow-1', providerRequestId: 'private-locator-fixture' };
  const error = { code: 'DB_UNAVAILABLE', errorNames: ['AppError'], errorCodes: ['DB_UNAVAILABLE'], message: 'private-message-fixture' };
`;

const serveRequests = `
  const app = Object.values(globalThis.__nitro__).find(value => value.h3?.config);
  assert(app, 'Nitro request host missing');
  const fetch = built.default?.fetch?.bind(built.default) ?? app.fetch.bind(app);
  const request = (id) => fetch(new Request('http://localhost:3000/api/auth/get-session', {
    headers: id ? { 'x-test-diagnostic-user': id } : {},
  }));
`;

function probe(scenario) {
  if (scenario.bootFailure)
    return `
    ${serveRequests}
    assert.equal((await request()).status, 500);
  `;
  if (scenario.requests)
    return `
    ${setup}
    ${serveRequests}
    function createProbe(prefix) {
      const ready = Promise.withResolvers();
      const second = Promise.withResolvers();
      return async (id) => {
        if (id === 'alpha') {
          runtime.adapter.setUser({ id: prefix + id, role: 'admin' });
          ready.resolve();
          await second.promise;
        } else if (id === 'beta') {
          await ready.promise;
          runtime.adapter.setUser({ id: prefix + id, role: 'user' });
          second.resolve();
        }
        await step({ ...input, resultId: prefix + (id ?? 'anonymous') }, 'UNAVAILABLE', true, error, true);
      };
    }
    const probeNitro = createProbe('nitro-');
    const onRequest = app.h3.config.onRequest;
    app.h3.config.onRequest = async (event) => {
      await onRequest?.(event);
      await probeNitro(event.req.headers.get('x-test-diagnostic-user'));
    };
    const responses = await Promise.all([request('alpha'), request('beta')]);
    for (const response of responses) assert.equal(response.status, 200);
    assert.equal((await request()).status, 200);

    // Observe the URL read inside Start's wrapped fetch, outside Nitro's scope.
    const probeSsr = createProbe('ssr-');
    const ssr = globalThis.__nitro_vite_envs__.ssr;
    const requestSsr = async (id) => {
      const req = new Request('http://localhost:3000/api/auth/get-session');
      const url = req.url;
      let observation;
      Object.defineProperty(req, 'url', {
        get() {
          observation ??= probeSsr(id);
          return url;
        },
      });
      assert.equal((await ssr.fetch(req)).status, 200);
      assert(observation, 'SSR request was not observed');
      await observation;
    };
    await Promise.all([requestSsr('alpha'), requestSsr('beta')]);
    await requestSsr();
  `;
  if (scenario.saturation)
    return `
    ${setup}
    runtime.adapter.emitLog({ event: 'ordinary.batch.probe', level: 'error' });
    // Give the ordinary batch timer a head start over the terminal deadline.
    await new Promise(resolve => setTimeout(resolve, 500));
    const terminals = Array.from({ length: 31 }, (_, index) =>
      step({ ...input, resultId: 'saturation-' + index }, 'UNAVAILABLE', true, error, true)
    );
    const ordinary = fetch(process.env.OTEL_COLLECTOR_URL + '/ordinary-ready');
    await Promise.all(terminals);
    assert.equal((await ordinary).status, 204);
  `;
  return `
    ${setup}
    await step(input, 'PROVIDER_UNAVAILABLE', true, error, false);
    await Promise.all([
      step(input, 'PROVIDER_UNAVAILABLE', true, error, true),
      ${scenario.concurrent ? `steps.get(${JSON.stringify(workflow + 'unresolvedSubmissionStep')})({ ...input, resultId: 'result-2' }, 'DB_UNAVAILABLE', true)` : 'undefined'}
    ]);
  `;
}

function checkRequestIsolation(received, scenario) {
  const events = received.sentry.map((body) => JSON.parse(body.split('\n')[2]));
  for (const [resultId, user, role] of [
    ['nitro-alpha', 'nitro-alpha', 'admin'],
    ['nitro-beta', 'nitro-beta', 'user'],
    ['nitro-anonymous', undefined, undefined],
    ['ssr-alpha', 'ssr-alpha', 'admin'],
    ['ssr-beta', 'ssr-beta', 'user'],
    ['ssr-anonymous', undefined, undefined],
  ]) {
    const event = events.find(
      (item) => item.extra?.details?.resultId === resultId
    );
    assert(event, `Missing Sentry event for ${resultId}`);
    assert.equal(event.user?.id, user);
    assert.equal(event.user?.segment, role);
    if (scenario.otel) {
      const record = received.otel.find((body) =>
        body.includes(`"resultId":"${resultId}"`)
      );
      assert(record, `Missing OTel event for ${resultId}`);
      // The protobuf key is unique in each of these single-record requests.
      assert.equal(record.includes('user.id'), user !== undefined);
      for (const other of [
        'nitro-alpha',
        'nitro-beta',
        'ssr-alpha',
        'ssr-beta',
      ])
        if (resultId !== other) assert(!record.includes(other));
    }
  }
}

for (const scenario of scenarios) {
  test(scenario.name, async () => {
    const received = { otel: [], sentry: [] };
    const sentryPaths = [];
    const collectorHeaders = [];
    const ordinary = Promise.withResolvers();
    let terminalInFlight = 0;
    let ordinaryOverlapped = false;
    const receiver = createServer(async (req, res) => {
      if (req.url === '/ordinary-ready') {
        await ordinary.promise;
        res.writeHead(204).end();
        return;
      }
      const sink = req.url?.startsWith('/v1/') ? 'otel' : 'sentry';
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const content = (
        req.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body
      ).toString();
      received[sink].push(content);
      if (req.url === '/v1/logs')
        collectorHeaders.push(req.headers['x-test-otel']);
      if (sink === 'sentry') sentryPaths.push(req.url?.split('?')[0]);
      if (scenario.saturation && content.includes('ordinary.batch.probe')) {
        ordinaryOverlapped = terminalInFlight === 30;
        ordinary.resolve();
        res.writeHead(200).end();
        return;
      }
      const status = scenario[sink];
      if (status === 'hang') {
        terminalInFlight++;
        res.on('close', () => terminalInFlight--);
        return;
      }
      res.writeHead(status ?? 404);
      // ExportLogsServiceResponse.partial_success.rejected_log_records = 1.
      res.end(
        sink === 'otel' && scenario.partialRejection
          ? Buffer.from([0x0a, 0x02, 0x08, 0x01])
          : undefined
      );
    });
    await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    try {
      const port = receiver.address().port;
      const sentryDsn = `http://public@127.0.0.1:${port}/1`;
      const invalidDsnMarker = randomBytes(12).toString('hex');
      const invalidDsn = new URL('https://host!invalid/1');
      invalidDsn.username = 'public';
      invalidDsn.password = invalidDsnMarker;
      const env = {
        NODE_ENV: scenario.testRuntime ? 'test' : 'production',
        NITRO_HOST: '127.0.0.1',
        NITRO_PORT: '0',
        VITE_BASE_URL: 'http://localhost:3000',
        VITE_S3_BUCKET_URL: 'http://localhost:9000/default',
        DATABASE_URL: 'postgres://localhost/diagnostics_fixture',
        DATABASE_DRIVER: 'node-pg',
        CRON_SECRET: randomBytes(32).toString('hex'),
        AUTH_SECRET: randomBytes(32).toString('hex'),
        S3_ACCESS_KEY_ID: randomBytes(12).toString('hex'),
        S3_SECRET_ACCESS_KEY: randomBytes(24).toString('hex'),
        S3_HOST: 'localhost:9000',
        S3_SECURE: 'false',
        EMAIL_DELIVERY_DISABLED: 'true',
        FAL_KEY: randomBytes(16).toString('hex'),
        BFL_API_KEY: randomBytes(16).toString('hex'),
        SENTRY_DSN: scenario.invalidSentry
          ? invalidDsn.href
          : scenario.sentry && !scenario.sentryFallback
            ? sentryDsn
            : '',
        VITE_SENTRY_DSN: scenario.sentryFallback
          ? sentryDsn
          : scenario.requests
            ? `http://public@127.0.0.1:${port}/2`
            : '',
        OTEL_COLLECTOR_URL: scenario.otel ? `http://127.0.0.1:${port}` : '',
        OTEL_COLLECTOR_BEARER_TOKEN: '',
        OTEL_EXPORTER_OTLP_LOGS_HEADERS: 'x-test-otel=local-fixture',
        OTEL_EXPORTER_OTLP_LOGS_COMPRESSION: scenario.saturation
          ? 'gzip'
          : 'none',
        OTEL_TRACES_SAMPLE_RATE: scenario.bootFailure
          ? 'private-invalid-sample-rate-probe'
          : '',
      };
      if (scenario.testRuntime) {
        env.LOGGER_LEVEL = 'error';
        env.LOGGER_CONSOLE_MIRROR = 'false';
      }
      if (scenario.mirror) env.LOGGER_CONSOLE_MIRROR = 'true';
      const { stdout, stderr } = await run(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
          import assert from 'node:assert/strict';
          try {
            const built = await import(${JSON.stringify(scenario.requests || scenario.bootFailure ? httpEntry : entry)});
            const runtime = globalThis[Symbol.for('selective-designer.server-telemetry')];
            assert(runtime, 'Nitro telemetry plugin did not initialize');
            ${probe(scenario)}
            process.exit(0);
          } catch (error) {
            console.error(error);
            process.exit(1);
          }
        `,
        ],
        { env, timeout: 15_000, killSignal: 'SIGKILL' }
      );
      const output = stdout + stderr;
      assert.equal(
        output.split('\n').filter((line) => line.startsWith(terminal)).length,
        scenario.fallback ?? 0
      );
      const allLogs =
        output + received.otel.join('') + received.sentry.join('');
      assert(!allLogs.includes('private-locator-fixture'));
      assert(!allLogs.includes('private-message-fixture'));
      assert(!allLogs.includes(invalidDsnMarker));
      assert(!allLogs.includes('private-invalid-sample-rate-probe'));
      assert(!allLogs.includes('failure_persistence_exception'));
      if (scenario.bootFailure) {
        assert.equal(received.sentry.length, 1);
        assert(received.sentry[0].includes('server.config_validation_failed'));
        assert(received.sentry[0].includes('OTEL_TRACES_SAMPLE_RATE'));
        return;
      }
      if (scenario.invalidSentry)
        assert.equal(
          output
            .split('\n')
            .filter((line) => line.startsWith('telemetry.server_init_failed'))
            .length,
          1
        );
      if (scenario.testRuntime) {
        assert.deepEqual(received, { otel: [], sentry: [] });
        return;
      }
      if (scenario.singleAttempt) assert.equal(received.otel.length, 1);
      assert(collectorHeaders.every((header) => header === 'local-fixture'));
      if (scenario.saturation) {
        assert(ordinaryOverlapped);
        assert.equal(
          received.otel.filter((body) => body.includes(terminal)).length,
          30
        );
        assert.equal(
          received.otel.filter((body) => body.includes('ordinary.batch.probe'))
            .length,
          1
        );
      }
      if (scenario.requests) {
        assert.deepEqual(sentryPaths, Array(6).fill('/api/1/envelope/'));
        checkRequestIsolation(received, scenario);
      }
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
      ordinary.resolve();
      receiver.closeAllConnections();
      await new Promise((resolve) => receiver.close(resolve));
    }
  });
}
