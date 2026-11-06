import { timingSafeEqual } from 'node:crypto';

/** Separate cron authority; ordinary sessions cannot invoke reconciliation. */
export async function handleAccountingReconcile(
  request: Request,
  deps: {
    secret: string | undefined;
    start: () => Promise<void>;
  }
) {
  const supplied = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${deps.secret ?? ''}`);
  if (
    !deps.secret ||
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    return new Response('Unauthorized', { status: 401 });
  await deps.start();
  return Response.json(
    { type: 'accounting_reconciliation_scheduled' },
    { status: 202 }
  );
}
