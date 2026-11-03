import { z } from 'zod';

import { zu } from '@/platform/lib/zod/zod-utils';

import {
  ITEM_CATEGORY_MAX_LENGTH,
  ITEM_NAME_MAX_LENGTH,
  ITEM_VENDOR_MAX_LENGTH,
} from '../domain/item';

export const zFormFieldsItem = () =>
  z.object({
    name: zu.fieldText.required({ max: ITEM_NAME_MAX_LENGTH }),
    category: zu.fieldText.required({ max: ITEM_CATEGORY_MAX_LENGTH }),
    vendor: z.string().trim().max(ITEM_VENDOR_MAX_LENGTH),
    productUrl: z
      .string()
      .trim()
      .max(2048)
      .refine(
        (value) => value === '' || /^https?:\/\/\S+$/iu.test(value),
        'moodboard:form.invalidUrl'
      ),
  });

export type FormFieldsItem = z.infer<ReturnType<typeof zFormFieldsItem>>;
