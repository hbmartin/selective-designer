import { toProviderCallId } from './ids';

/** Native request identity deduplicates replay; fallback identifies an actual invocation. */
export const providerCallIdentity = (input: {
  provider: string;
  endpoint: string;
  providerRequestId?: string;
  invocationId: string;
}) =>
  toProviderCallId(
    input.providerRequestId
      ? `request:${encodeURIComponent(input.provider)}:${encodeURIComponent(input.endpoint)}:${encodeURIComponent(input.providerRequestId)}`
      : `invocation:${input.invocationId}`
  );
