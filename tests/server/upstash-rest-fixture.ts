import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';

import { UpstashSecondaryStore } from '@/modules/auth/infrastructure/secondary-store/upstash-secondary-store';
import { createNoOpTelemetry } from '@/platform/telemetry';

export async function createUpstashRestFixture() {
  const values = new Map<string, string>();
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const [command, key, value, evalKey] = JSON.parse(
      Buffer.concat(chunks).toString()
    );
    let result: string | number | null = null;
    switch (command) {
      case 'GET':
        result = values.get(key) ?? null;
        break;
      case 'SET':
        values.set(key, value);
        result = 'OK';
        break;
      case 'DEL':
        result = Number(values.delete(key));
        break;
      case 'EVAL':
        result = Number(values.get(evalKey) ?? '0') + 1;
        values.set(evalKey, String(result));
        break;
      default:
        response.writeHead(400).end();
        return;
    }
    response
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('REST fixture failed to bind');
  return {
    store: new UpstashSecondaryStore({
      config: {
        restUrl: `http://127.0.0.1:${address.port}`,
        restToken: randomBytes(16).toString('hex'),
      },
      telemetry: createNoOpTelemetry(),
    }),
    values,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
