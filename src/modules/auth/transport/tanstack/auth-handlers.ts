import type { PublicContext } from './server-context';
import { sanitizeCurrentSession } from '../../domain/request-scope';

export const createAuthHandlers = () => {
  const currentSession = (ctx: PublicContext) => {
    const result = sanitizeCurrentSession(
      ctx.user && ctx.session ? { user: ctx.user, session: ctx.session } : null
    );
    if (result.isError()) throw result.getError();
    return result.get();
  };

  return {
    currentSession,
  };
};

export type AuthHandlers = ReturnType<typeof createAuthHandlers>;
