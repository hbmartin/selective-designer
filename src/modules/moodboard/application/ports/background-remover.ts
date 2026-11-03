import type { ApplicationResult, ProviderCostSource } from '@/modules/kernel';
import type { ObjectKey } from '@/modules/kernel/domain/ids';

export type BackgroundRemovalResult = {
  type: 'background_removed';
  /** Provider-hosted result, or bytes for adapters that produce them locally. */
  result:
    | { kind: 'url'; url: string }
    | { kind: 'bytes'; bytes: Uint8Array; contentType: string };
  provider: string;
  endpoint: string;
  providerRequestId: string | undefined;
  costUsdMicros: number | undefined;
  costSource: ProviderCostSource;
};

export type BackgroundRemovalFailed = {
  type: 'background_removal_failed';
  reason: string;
  provider: string;
  endpoint: string;
};

/** Removes the background of a product photo, returning an alpha PNG. */
export interface BackgroundRemover {
  removeBackground(input: {
    sourceKey: ObjectKey;
    sourceUrl: string;
  }): Promise<
    ApplicationResult<BackgroundRemovalResult | BackgroundRemovalFailed>
  >;
}

/** Starts durable background removal for an item version. */
export interface BackgroundRemovalScheduler {
  schedule(input: {
    itemVersionId: string;
  }): Promise<ApplicationResult<{ type: 'background_removal_scheduled' }>>;
}
