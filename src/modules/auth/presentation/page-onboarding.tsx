import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { LogOutIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import {
  Form,
  FormField,
  FormFieldLabel,
  useAppForm,
} from '@/platform/components/form';
import { Button } from '@/platform/components/ui/button';

import { accountQueries } from '@/modules/account/client';
import {
  clearAllQueryStateForAuthBoundary,
  useAuthSession,
} from '@/modules/auth/client';
import { ConfirmSignOut } from '@/modules/auth/presentation/confirm-signout';
import { LayoutLogin } from '@/modules/auth/presentation/layout-login';
import { zFormFieldsOnboarding } from '@/modules/auth/presentation/schema';

export const PageOnboarding = () => {
  const { t } = useTranslation(['auth']);
  const session = useAuthSession();
  const router = useRouter();
  const queryClient = useQueryClient();

  const submitOnboarding = useMutation({
    ...accountQueries.submitOnboarding(),
    onError: () => {
      toast.error(t('auth:pageOnboarding.errorMessage'));
    },
  });

  const form = useAppForm({
    defaultValues: {
      name: session.data?.user.name ?? '',
    },
    validators: { onSubmit: zFormFieldsOnboarding() },
    onSubmit: async ({ value, formApi }) => {
      if (!submitOnboarding.isSuccess) {
        try {
          await submitOnboarding.mutateAsync(value);
        } catch {
          return; // Persistence errors are reported by the mutation.
        }
      }
      try {
        const refreshed = await session.refetch({ throwOnError: true });
        if (refreshed.data?.user) {
          formApi.setFieldValue('name', refreshed.data.user.name ?? '');
        }
        clearAllQueryStateForAuthBoundary(queryClient);
        await router.invalidate();
        if (refreshed.data?.user) {
          toast.success(
            t('auth:pageOnboarding.successMessage', {
              name: refreshed.data.user.name,
            })
          );
        }
      } catch {
        toast.error(t('auth:pageOnboarding.refreshErrorMessage'));
      }
    },
  });

  return (
    <LayoutLogin
      footer={
        <div className="flex flex-col items-center justify-center text-center">
          <p className="pt-8 text-xs text-balance break-words text-muted-foreground">
            {t('auth:pageOnboarding.loggedWith', {
              email: session.data?.user.email,
            })}
          </p>
          <ConfirmSignOut>
            <Button size="xs" variant="link" className="opacity-80">
              <LogOutIcon />
              {t('auth:signOut.action')}
            </Button>
          </ConfirmSignOut>
        </div>
      }
    >
      <Form form={form} className="flex flex-col gap-4 pb-12">
        <div className="flex flex-col gap-1">
          <h1 className="font-display text-2xl font-medium tracking-tight text-balance">
            {t('auth:pageOnboarding.title')}
          </h1>
          <p className="text-sm text-balance break-words text-muted-foreground">
            {t('auth:pageOnboarding.description')}
          </p>
        </div>

        <FormField>
          <FormFieldLabel>
            {t('auth:common.name.onboardingLabel')}
          </FormFieldLabel>
          <form.AppField name="name">
            {(field) => (
              <form.Subscribe selector={(state) => state.isSubmitting}>
                {(isSubmitting) => (
                  <field.FieldText
                    type="text"
                    size="lg"
                    readOnly={isSubmitting || submitOnboarding.isSuccess}
                  />
                )}
              </form.Subscribe>
            )}
          </form.AppField>
        </FormField>
        <form.SubmitButton size="lg">
          {t('auth:pageOnboarding.submit')}
        </form.SubmitButton>
      </Form>
    </LayoutLogin>
  );
};
