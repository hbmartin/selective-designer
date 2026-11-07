import { hasCronAuthority } from './cron-authority';
/** Separate cron authority; ordinary sessions cannot invoke reconciliation. */
export async function handleAccountingReconcile(
  request: Request,
  deps: {
    secret: string | undefined;
    start: () => Promise<void>;
  }
) {
  if (!hasCronAuthority(request, deps.secret))
    return new Response('Unauthorized', { status: 401 });
  await deps.start();
  return Response.json(
    { type: 'accounting_reconciliation_scheduled' },
    { status: 202 }
  );
}
