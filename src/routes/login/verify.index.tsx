import {
  createFileRoute,
  Navigate,
  useRouterState,
} from '@tanstack/react-router';
import { fallback, zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

import { LoginEmailOtpHint } from '@/app/devtools/presentation';
import { PageLoginVerify } from '@/modules/auth/presentation';

const loginEmailStateSchema = z.email();

// The email being verified is passed through router navigation `state` (not the
// URL) so it never lands in browser history, server logs, or referrer headers.
declare module '@tanstack/react-router' {
  interface HistoryState {
    loginEmail?: string;
  }
}

export const Route = createFileRoute('/login/verify/')({
  component: RouteComponent,
  validateSearch: zodValidator(
    z.object({
      redirect: fallback(z.string(), '').optional(),
    })
  ),
});

function RouteComponent() {
  const search = Route.useSearch();
  const loginEmail = useRouterState({
    select: (state) => {
      const locationState = state.location.state as
        | { loginEmail?: unknown }
        | null
        | undefined;
      return locationState?.loginEmail;
    },
  });
  const parsedLoginEmail = loginEmailStateSchema.safeParse(loginEmail);

  // On a direct load / refresh there is no navigation state, so we have no
  // email to verify. Bounce back to the email step instead of crashing.
  if (!parsedLoginEmail.success) {
    return (
      <Navigate to="/login" search={{ redirect: search.redirect }} replace />
    );
  }

  return (
    <PageLoginVerify
      emailOtpHint={<LoginEmailOtpHint />}
      search={search}
      email={parsedLoginEmail.data}
    />
  );
}
