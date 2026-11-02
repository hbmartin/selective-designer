import { AppError } from '@/modules/kernel/domain/errors/app-error';

export function appErrorToResponse(error: unknown): Response {
  if (error instanceof AppError) {
    // Internal (5xx/system) errors must not leak their developer-facing message
    // or details to the client; only client-error categories expose specifics.
    const isInternal = error.category === 'system' || error.status >= 500;
    const payload: {
      code: string;
      category: AppError['category'];
      message: string;
      details?: AppError['details'];
    } = {
      code: error.code,
      category: error.category,
      message: isInternal ? 'Internal server error' : error.message,
    };
    if (!isInternal && error.exposeDetails) payload.details = error.details;

    return Response.json(payload, { status: error.status });
  }

  return Response.json(
    {
      code: 'INTERNAL_SERVER_ERROR',
      category: 'system',
      message: 'Internal server error',
    },
    { status: 500 }
  );
}
