import type { ProviderCallRecord } from './provider-call-log';
import type { ApplicationResult } from '../result';

/** Serializable, server-only evidence of one performed provider request. */
export type ProviderCallReceipt = Omit<
  ProviderCallRecord,
  'startedAt' | 'completedAt'
> & {
  startedAt: string;
  completedAt: string | undefined;
};
export type ReceiptCaptured = {
  type: 'receipt_captured';
  receiptId: ProviderCallRecord['id'];
};
export interface ProviderAccounting {
  /** Durably capture before allowing output to publish. Delivery is independent. */
  capture(
    receipt: ProviderCallReceipt
  ): Promise<ApplicationResult<ReceiptCaptured>>;
  /** Best effort from output flows; failure never invalidates a captured output. */
  deliver(
    receiptId: ProviderCallRecord['id']
  ): Promise<
    ApplicationResult<
      | { type: 'receipt_delivered' }
      | { type: 'receipt_pending' }
      | { type: 'receipt_missing' }
    >
  >;
}
