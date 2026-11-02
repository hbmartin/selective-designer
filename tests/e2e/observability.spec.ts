/* oxlint-disable vitest/no-conditional-in-test -- Request capture branches are the browser behavior under test. */

import { expect, test } from '@tests/e2e/utils';
import { USER_FILE } from '@tests/e2e/utils/constants';

const vendorHostPattern =
  /(?:sentry\.io|honeycomb\.io|opentelemetry|otel|collector)/i;

test.describe('browser telemetry transport', () => {
  test.use({ storageState: USER_FILE });

  test('keeps browser telemetry on same-origin proxy routes', async ({
    page,
    baseURL,
  }) => {
    const appOrigin = new URL(baseURL ?? page.url()).origin;
    const directVendorRequests: string[] = [];
    const telemetryRequests: string[] = [];

    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/telemetry/')) {
        telemetryRequests.push(url.href);
        return;
      }

      if (url.origin !== appOrigin && vendorHostPattern.test(url.host)) {
        directVendorRequests.push(url.href);
      }
    });

    await page.goto('/app', { waitUntil: 'commit' });
    await expect(page.getByTestId('layout-app')).toBeVisible();

    const logResponseStatus = await page.evaluate(async () => {
      const response = await fetch('/api/telemetry/logs', {
        body: JSON.stringify({
          records: [
            {
              event: 'e2e.network_smoke',
              level: 'info',
              timestamp: new Date().toISOString(),
            },
          ],
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });

      return response.status;
    });

    expect(directVendorRequests).toEqual([]);
    expect(logResponseStatus).toBe(202);
    expect(telemetryRequests.length).toBeGreaterThan(0);
    expect(
      telemetryRequests.every(
        (requestUrl) => new URL(requestUrl).origin === appOrigin
      )
    ).toBe(true);
  });
});
