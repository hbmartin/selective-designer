import { definePlugin } from 'nitro';

import { initTelemetryServer } from './sentry.server';

export default definePlugin(() => {
  initTelemetryServer();
});
