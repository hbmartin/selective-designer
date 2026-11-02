import { z } from 'zod';

import {
  Form,
  FormField,
  FormFieldLabel,
  useAppForm,
} from '@/platform/components/form';
import { onSubmit } from '@/platform/components/form/docs.utils';

const options = [
  { value: 'bearstrong', label: 'Bearstrong' },
  { value: 'pawdrin', label: 'Buzz Pawdrin' },
  { value: 'grizzlyrin', label: 'Yuri Grizzlyrin' },
];

const Default = () => {
  const form = useAppForm({
    defaultValues: { bear: '' },
    validators: { onSubmit: z.object({ bear: z.string() }) },
    onSubmit: ({ value }) => onSubmit(value),
  });

  return (
    <Form form={form} className="flex flex-col gap-4">
      <FormField>
        <FormFieldLabel>Bearstronaut</FormFieldLabel>
        <form.AppField name="bear">
          {(field) => <field.FieldCombobox items={options} />}
        </form.AppField>
      </FormField>
      <form.SubmitButton>Submit</form.SubmitButton>
    </Form>
  );
};

export default { Default };
