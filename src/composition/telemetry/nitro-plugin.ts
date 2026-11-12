import { definePlugin } from 'nitro';

import { initTelemetryServer, withServerTelemetryScope } from './sentry.server';

export default definePlugin((app) => {
  initTelemetryServer();
  const fetch = app.fetch.bind(app);
  app.fetch = (request) => withServerTelemetryScope(() => fetch(request));
});
