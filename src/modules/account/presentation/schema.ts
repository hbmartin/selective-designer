import { z } from 'zod';

import { zu } from '@/platform/lib/zod/zod-utils';

import { ACCOUNT_NAME_MAX_LENGTH } from '../domain/account-policy';

export type FormFieldsAccountUpdateName = z.infer<
  ReturnType<typeof zFormFieldsAccountUpdateName>
>;
export const zFormFieldsAccountUpdateName = () =>
  z.object({
    name: zu.fieldText.required({ max: ACCOUNT_NAME_MAX_LENGTH }),
  });
