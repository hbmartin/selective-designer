import { start } from 'workflow/api';

import { renderOutputCleanupWorkflow } from '@/modules/rendering/workflows/backend';
export const scheduleRenderOutputCleanup = async () => {
  await start(renderOutputCleanupWorkflow, []);
};
