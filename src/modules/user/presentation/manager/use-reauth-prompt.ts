import { useRouter } from '@tanstack/react-router';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { isReauthRequiredError } from '@/modules/auth/client';

/**
 * Returns a guard for destructive-mutation errors. When the server rejects an
 * action because the session is no longer fresh (`reauth_required`), it shows a
 * toast prompting the admin to re-authenticate, with an action that sends them
 * to `/login` carrying a redirect back to the current URL. Re-login (email OTP)
 * mints a fresh session, after which the admin retries — so an admin is never
 * permanently blocked.
 *
 * Returns `true` when it handled a re-auth error (caller should stop), `false`
 * otherwise so the caller can fall back to its normal error handling.
 */
export const useReauthPrompt = () => {
  const { t } = useTranslation(['user']);
  const router = useRouter();

  return useCallback(
    (error: unknown): boolean => {
      if (!isReauthRequiredError(error)) return false;

      const redirect = router.state.location.href;
      toast.error(t('user:manager.reauth.title'), {
        description: t('user:manager.reauth.description'),
        action: {
          label: t('user:manager.reauth.action'),
          onClick: () => {
            void router.navigate({ to: '/login', search: { redirect } });
          },
        },
      });
      return true;
    },
    [router, t]
  );
};
