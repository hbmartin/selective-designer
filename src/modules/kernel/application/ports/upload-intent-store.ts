import type { ApplicationResult } from '../result';
import type { ObjectKey, UserId } from '../../domain/ids';
import type { UploadPurpose } from '../../domain/upload-policy';

export type RememberUploadIntentInput = {
  objectKey: ObjectKey;
  userId: UserId;
  purpose: UploadPurpose;
  contentType: string;
  expiresAt: Date;
};

export type ConsumeUploadIntentInput = {
  objectKey: ObjectKey;
  userId: UserId;
  purpose: UploadPurpose;
  now: Date;
};

export type UploadIntentRememberedOutcome = {
  type: 'upload_intent_remembered';
};

export type UploadIntentConsumeOutcome =
  | { type: 'upload_intent_consumed'; contentType: string }
  /** Never issued to this user/purpose, already consumed, or expired. */
  | { type: 'upload_intent_unowned' };

/**
 * Binds presigned upload keys to the user and purpose they were issued for.
 * Durable (database-backed) so a presign and its registration can land on
 * different serverless instances.
 */
export interface UploadIntentStore {
  remember(
    input: RememberUploadIntentInput
  ): Promise<ApplicationResult<UploadIntentRememberedOutcome>>;
  consume(
    input: ConsumeUploadIntentInput
  ): Promise<ApplicationResult<UploadIntentConsumeOutcome>>;
}
