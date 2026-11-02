import { z } from 'zod';

import { zu } from '@/platform/lib/zod/zod-utils';

import { DESIGN_NAME_MAX_LENGTH } from '../domain/design';

export type FormFieldsDesignName = z.infer<
  ReturnType<typeof zFormFieldsDesignName>
>;

export const zFormFieldsDesignName = () =>
  z.object({
    name: zu.fieldText.required({ max: DESIGN_NAME_MAX_LENGTH }),
  });
