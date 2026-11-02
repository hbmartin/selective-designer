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
    defaultValues: { name: '' },
    validators: { onSubmit: z.object({ name: z.string().min(1) }) },
    onSubmit: ({ value }) => onSubmit(value),
  });

  return (
    <Form form={form} className="flex flex-col gap-4">
      <FormField>
        <FormFieldLabel>Name</FormFieldLabel>
        <form.AppField name="name">
          {(field) => <field.FieldText type="text" />}
        </form.AppField>
      </FormField>
      <form.SubmitButton>Submit</form.SubmitButton>
    </Form>
  );
};

export default { Default };
