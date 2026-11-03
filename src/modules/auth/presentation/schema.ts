import { z } from 'zod';

import { zu } from '@/platform/lib/zod/zod-utils';

import { ACCOUNT_NAME_MAX_LENGTH } from '@/modules/account';

import { PASSWORD_MAX_LENGTH } from '../domain/password-policy';

export type FormFieldsLogin = z.infer<ReturnType<typeof zFormFieldsLogin>>;
export const zFormFieldsLogin = () =>
  // This object defines validation rules for the form fields.
  // nosemgrep: token-or-secret-logging
  z.object({
    email: zu.fieldText.required({ error: 'auth:common.email.required' }).pipe(
      z.email({
        error: (issue) =>
          issue.input
            ? 'auth:common.email.invalid'
            : 'auth:common.email.required',
      })
    ),
    password: z
      .string()
      .min(1, 'auth:common.password.required')
      .max(PASSWORD_MAX_LENGTH, 'auth:errorCode.PASSWORD_TOO_LONG'),
  });

export type FormFieldsOnboarding = z.infer<
  ReturnType<typeof zFormFieldsOnboarding>
>;
export const zFormFieldsOnboarding = () =>
  z.object({
    name: zu.fieldText.required({ max: ACCOUNT_NAME_MAX_LENGTH }),
  });
