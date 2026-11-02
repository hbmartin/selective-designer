import type { ComponentProps } from 'react';

import { Button } from '@/platform/components/ui/button';

import { useFormContext } from './use-app-form-contexts';

export const FormSubmitButton = ({
  loading,
  ...props
}: ComponentProps<typeof Button>) => {
  const form = useFormContext();

  return (
    <form.Subscribe selector={(state) => state.isSubmitting}>
      {(isSubmitting) => (
        <Button
          {...props}
          type="submit"
          loading={Boolean(loading) || isSubmitting}
        />
      )}
    </form.Subscribe>
  );
};
