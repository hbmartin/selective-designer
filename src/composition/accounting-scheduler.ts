import { start } from 'workflow/api';

import { accountingReconcileWorkflow } from '@/modules/kernel/workflows/backend';

export const scheduleAccountingReconciliation = async () => {
  await start(accountingReconcileWorkflow, []);
};
