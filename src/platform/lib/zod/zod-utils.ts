import { z } from 'zod';

const emptyStringAsNull = (input: string) =>
  // Cast null value to string for React Hook Form inference
  input.trim() === '' ? (null as unknown as string) : input.trim();

const emptyStringAsUndefined = (input: string) =>
  // Cast undefined value to string for React Hook Form inference
  input.trim() === '' ? (undefined as unknown as string) : input.trim();

const DEFAULT_REQUIRED_ERROR = 'common:errors.required';

export type FieldTextOptions = {
  /** Translation key for the required / invalid-type error. */
  error?: string;
  /**
   * Maximum length enforced on the trimmed value. Emits the static
   * `common:errors.maxLength` key when exceeded, so the same bound can be shared
   * between presentation forms and server-side transport validators.
   */
  max?: number;
};

const inputString = (options?: FieldTextOptions) =>
  z.string({ error: options?.error ?? DEFAULT_REQUIRED_ERROR });

const validatedString = (options?: FieldTextOptions) => {
  const schema = inputString(options);
  return options?.max === undefined
    ? schema
    : schema.max(options.max, { error: 'common:errors.maxLength' });
};

export const zu = {
  fieldText: {
    required: (options?: FieldTextOptions) =>
      inputString(options)
        .transform(emptyStringAsNull)
        .pipe(validatedString(options)),
    nullable: (options?: FieldTextOptions) =>
      inputString(options)
        .transform(emptyStringAsNull)
        .nullable()
        .pipe(validatedString(options).nullable()),
    nullish: (options?: FieldTextOptions) =>
      inputString(options)
        .transform(emptyStringAsNull)
        .nullish()
        .pipe(validatedString(options).nullish()),
    optional: (options?: FieldTextOptions) =>
      inputString(options)
        .transform(emptyStringAsUndefined)
        .optional()
        .pipe(validatedString(options).optional()),
  },
};
