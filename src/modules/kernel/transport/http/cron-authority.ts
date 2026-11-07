import { timingSafeEqual } from 'node:crypto';

/** Cron authority is independent of user sessions and endpoint purpose. */
export function hasCronAuthority(
  request: Request,
  secret: string | undefined
): boolean {
  if (!secret) return false;
  const supplied = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}
