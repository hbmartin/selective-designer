import { unwrapStepResult } from '../workflow/step-result-mapper';
import { toProviderCallId } from '../../domain/ids';

type RecoveryModule = typeof import('@/composition/accounting-pipeline');
let recoveryModule: Promise<RecoveryModule> | undefined;
const recovery = async () => {
  recoveryModule ??= import('@/composition/accounting-pipeline').catch(
    (error: unknown) => {
      recoveryModule = undefined;
      throw error;
    }
  );
  return (await recoveryModule).getAccountingRecovery();
};

async function deliverStep(receiptId: string) {
  'use step';
  const id = unwrapStepResult(toProviderCallId(receiptId));
  return unwrapStepResult(await (await recovery()).deliver(id));
}
async function listStep(input: { before: string; after?: string }) {
  'use step';
  return unwrapStepResult(await (await recovery()).list(input));
}
async function summaryStep() {
  'use step';
  return unwrapStepResult(await (await recovery()).summary());
}
async function cutoffStep() {
  'use step';
  return (await recovery()).startedAt();
}
export async function accountingDeliveryWorkflow(input: { receiptId: string }) {
  'use workflow';
  return deliverStep(input.receiptId);
}
export async function accountingReconcileWorkflow() {
  'use workflow';
  const before = await cutoffStep();
  let after: string | undefined;
  let delivered = 0;
  let failed = 0;
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- durable cursor advances after a bounded batch.
    const page = await listStep({ before, after });
    if (!page.ids.length) break;
    // oxlint-disable-next-line no-await-in-loop -- isolate exhausted receipts and continue the batch.
    for (let offset = 0; offset < page.ids.length; offset += 5) {
      // oxlint-disable-next-line no-await-in-loop -- cap database delivery concurrency independently of page size.
      const results = await Promise.allSettled(
        page.ids.slice(offset, offset + 5).map((id) => deliverStep(id))
      );
      delivered += results.filter(
        (result) =>
          result.status === 'fulfilled' &&
          result.value.type === 'receipt_delivered'
      ).length;
      failed += results.filter((result) => result.status === 'rejected').length;
    }
    after = page.ids.at(-1);
  }
  const summary = await summaryStep();
  return { delivered, failed, pending: summary.pending };
}
