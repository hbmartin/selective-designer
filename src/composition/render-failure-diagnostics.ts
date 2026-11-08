import { createTelemetryLogger } from '@/modules/kernel/backend';

import { createCachedFactory } from './shared/singleton';
import { telemetryProxy } from './telemetry';

// Failure reporting must remain available when rendering or database setup fails.
const factory = createCachedFactory(() =>
  createTelemetryLogger({ telemetry: telemetryProxy })
);
export const getRenderFailureLogger = () => factory.get();
