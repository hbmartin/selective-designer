import { toast } from 'sonner';
import { z } from 'zod';

import {
  Form,
  FormField,
  FormFieldLabel,
  useAppForm,
} from '@/platform/components/form';
import { onSubmit } from '@/platform/components/form/docs.utils';

const formSchema = z.object({ file: z.string().nullable() });
const formDefaultValues: z.infer<typeof formSchema> = { file: null };

const Default = () => {
  const form = useAppForm({
    defaultValues: formDefaultValues,
    validators: { onSubmit: formSchema },
    onSubmit: ({ value }) => onSubmit(value),
  });

  return (
    <Form form={form} className="flex flex-col gap-4">
      <FormField>
        <FormFieldLabel>File</FormFieldLabel>
        <form.AppField name="file">
          {(field) => (
            <field.FieldUploadInput
              uploadRoute="baseImage"
              onError={() => toast.error('Upload failed')}
            />
          )}
        </form.AppField>
      </FormField>
      <form.SubmitButton>Submit</form.SubmitButton>
    </Form>
  );
};

export default { Default };
