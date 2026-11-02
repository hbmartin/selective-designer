import { z } from 'zod';

import {
  Form,
  FormField,
  FormFieldLabel,
  useAppForm,
} from '@/platform/components/form';
import { onSubmit } from '@/platform/components/form/docs.utils';

const Default = () => {
  const form = useAppForm({
    defaultValues: { description: '' },
    validators: { onSubmit: z.object({ description: z.string().min(1) }) },
    onSubmit: ({ value }) => onSubmit(value),
  });

  return (
    <Form form={form} className="flex flex-col gap-4">
      <FormField>
        <FormFieldLabel>Description</FormFieldLabel>
        <form.AppField name="description">
          {(field) => <field.FieldTextarea />}
        </form.AppField>
      </FormField>
      <form.SubmitButton>Submit</form.SubmitButton>
    </Form>
  );
};

export default { Default };
