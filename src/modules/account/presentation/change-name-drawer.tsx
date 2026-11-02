import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ReactElement, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import {
  Form,
  FormField,
  FormFieldLabel,
  useAppForm,
} from '@/platform/components/form';
import {
  ResponsiveDrawer,
  ResponsiveDrawerBody,
  ResponsiveDrawerContent,
  ResponsiveDrawerDescription,
  ResponsiveDrawerFooter,
  ResponsiveDrawerHeader,
  ResponsiveDrawerTitle,
  ResponsiveDrawerTrigger,
} from '@/platform/components/ui/responsive-drawer';

import { accountQueries } from '@/modules/account/client';
import { authQueries, useAuthSession } from '@/modules/auth/client';

import {
  beginOptimisticCurrentSessionNameUpdate,
  reconcileOptimisticCurrentSessionNameUpdate,
  rollbackOptimisticCurrentSessionNameUpdate,
} from './optimistic-current-session';
import { zFormFieldsAccountUpdateName } from './schema';

export const ChangeNameDrawer = (props: { children: ReactElement }) => {
  const { t } = useTranslation(['account']);
  const [open, setOpen] = useState(false);
  const session = useAuthSession();
  const queryClient = useQueryClient();
  const sessionName = session.data?.user.name ?? '';
  const currentSessionQuery = authQueries.currentSession();

  const updateUser = useMutation({
    ...accountQueries.updateInfo(),
    onMutate: ({ name }) =>
      beginOptimisticCurrentSessionNameUpdate({
        queryClient,
        queryKey: currentSessionQuery.queryKey,
        name,
      }),
    onError: (_error, _variables, mutationResult) => {
      rollbackOptimisticCurrentSessionNameUpdate({
        queryClient,
        queryKey: currentSessionQuery.queryKey,
        context: mutationResult,
      });
      toast.error(t('account:changeNameDrawer.errorMessage'));
    },
    onSettled: async (_data, error, variables) => {
      await reconcileOptimisticCurrentSessionNameUpdate({
        queryClient,
        queryKey: currentSessionQuery.queryKey,
      });

      if (error) return;

      toast.success(t('account:changeNameDrawer.successMessage'));
      form.reset({ name: variables.name });
      setOpen(false);
    },
  });

  const form = useAppForm({
    defaultValues: {
      name: session.data?.user.name ?? '',
    },
    validators: { onSubmit: zFormFieldsAccountUpdateName() },
    onSubmit: async ({ value: { name } }) => {
      await updateUser.mutateAsync({ name });
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({ name: sessionName });
    }
  }, [form, open, sessionName]);

  return (
    <ResponsiveDrawer
      open={open}
      onOpenChange={(isOpen: boolean) => {
        setOpen(isOpen);
        form.reset({ name: sessionName });
      }}
    >
      <ResponsiveDrawerTrigger render={props.children} />

      <ResponsiveDrawerContent className="sm:max-w-xs">
        <Form form={form} className="flex flex-col gap-4">
          <ResponsiveDrawerHeader>
            <ResponsiveDrawerTitle>
              {t('account:changeNameDrawer.title')}
            </ResponsiveDrawerTitle>
            <ResponsiveDrawerDescription className="sr-only">
              {t('account:changeNameDrawer.description')}
            </ResponsiveDrawerDescription>
          </ResponsiveDrawerHeader>
          <ResponsiveDrawerBody>
            <FormField>
              <FormFieldLabel className="sr-only">
                {t('account:changeNameDrawer.label')}
              </FormFieldLabel>
              <form.AppField name="name">
                {(field) => <field.FieldText type="text" size="lg" autoFocus />}
              </form.AppField>
            </FormField>
          </ResponsiveDrawerBody>
          <ResponsiveDrawerFooter>
            <form.SubmitButton className="w-full" size="lg">
              {t('account:changeNameDrawer.submitButton')}
            </form.SubmitButton>
          </ResponsiveDrawerFooter>
        </Form>
      </ResponsiveDrawerContent>
    </ResponsiveDrawer>
  );
};
