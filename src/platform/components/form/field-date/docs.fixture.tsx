import { useState } from 'react';
import { z } from 'zod';

import {
  Form,
  FormField,
  FormFieldLabel,
  useAppForm,
} from '@/platform/components/form';
import { onSubmit } from '@/platform/components/form/docs.utils';

const Default = () => {
  const [date] = useState(() => new Date());
  const form = useAppForm({
    defaultValues: { date },
    validators: { onSubmit: z.object({ date: z.date() }) },
    onSubmit: ({ value }) => onSubmit(value),
  });

  return (
    <Form form={form} className="flex flex-col gap-4">
      <FormField>
        <FormFieldLabel>Date</FormFieldLabel>
        <form.AppField name="date">
          {(field) => <field.FieldDate />}
        </form.AppField>
      </FormField>
      <form.SubmitButton>Submit</form.SubmitButton>
    </Form>
  );
};

export default { Default };
