import { useStore } from '@tanstack/react-form';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { useHydrated } from '@/platform/hooks/use-hydrated';

import {
  Form,
  FormField,
  FormFieldLabel,
  useAppForm,
} from '@/platform/components/form';

import {
  clearAllQueryStateForAuthBoundary,
  startSignIn,
} from '@/modules/auth/client';

import { authE2eDebug } from './e2e-debug';
import { useMascot } from './mascot';
import { zFormFieldsLogin } from './schema';

export default function PageLogin({ emailHint }: { emailHint?: ReactNode }) {
  const { i18n, t } = useTranslation(['auth']);
  const router = useRouter();
  const queryClient = useQueryClient();
  const hydrated = useHydrated();
  const form = useAppForm({
    defaultValues: { email: '', password: '' },
    validators: { onSubmit: zFormFieldsLogin() },
    onSubmit: async ({ value }) => {
      authE2eDebug('login.password.submit');
      const result = await startSignIn(value);
      if (!result.ok) {
        authE2eDebug('login.password.error', { code: result.code });
        const key = `auth:errorCode.${result.code}`;
        toast.error(
          i18n.t(key, { defaultValue: t('auth:errorCode.UNKNOWN_ERROR') })
        );
        return;
      }

      clearAllQueryStateForAuthBoundary(queryClient);
      await router.invalidate();
    },
  });

  const isInvalidAfterSubmit = useStore(
    form.store,
    (state) => state.isSubmitted && !state.isValid
  );
  useMascot({ isError: isInvalidAfterSubmit });

  return (
    <Form
      form={form}
      className="flex flex-col gap-6"
      data-hydrated={hydrated ? 'true' : 'false'}
      data-testid="auth-login-form"
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-bold">{t('auth:pageLogin.title')}</h1>
        <p className="text-sm text-balance text-muted-foreground">
          {t('auth:pageLogin.description')}
        </p>
      </div>
      <div className="grid gap-4">
        <FormField>
          <FormFieldLabel className="sr-only">
            {t('auth:common.email.label')}
          </FormFieldLabel>
          <form.AppField name="email">
            {(field) => (
              <field.FieldText
                type="email"
                autoComplete="username"
                size="lg"
                placeholder={t('auth:common.email.label')}
              />
            )}
          </form.AppField>
        </FormField>
        <FormField>
          <FormFieldLabel className="sr-only">
            {t('auth:common.password.label')}
          </FormFieldLabel>
          <form.AppField name="password">
            {(field) => (
              <field.FieldText
                type="password"
                autoComplete="current-password"
                size="lg"
                placeholder={t('auth:common.password.label')}
              />
            )}
          </form.AppField>
        </FormField>
        <form.SubmitButton size="lg" className="w-full">
          {t('auth:pageLogin.submit')}
        </form.SubmitButton>
        {emailHint}
      </div>
    </Form>
  );
}
