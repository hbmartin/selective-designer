/**
 * Rejects an object-storage upload from a `prepare` hook. Carries a stable
 * translation KEY (never a translated string) so the client translates it at
 * render time; the storage adapter maps it to its provider's rejection
 * mechanism. This is a transport-boundary, exception-driven contract (permitted
 * by the project's Result policy for adapter boundaries), not application flow.
 */
export class UploadRejectedError extends Error {
  constructor(public readonly messageKey: string) {
    super(messageKey);
    this.name = 'UploadRejectedError';
  }
}
