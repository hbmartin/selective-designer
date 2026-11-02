import { z } from 'zod';

import type { AccountUseCases } from '@/modules/account';
import type { ProtectedContext } from '@/modules/auth/backend';
import { unwrapApplicationResult } from '@/modules/kernel/transport/tanstack/result-mapper';

import { zAccountName } from '../../domain/account';

export const zSubmitOnboardingInput = () => z.object({ name: zAccountName() });
export const zUpdateInfoInput = () => z.object({ name: zAccountName() });

type AccountHandlerDeps = {
  getUseCases: (ctx: ProtectedContext) => AccountUseCases;
};

const accountReasonConfig = {
  account_forbidden: { code: 'FORBIDDEN', message: 'Forbidden' },
  account_not_found: { code: 'NOT_FOUND', message: 'Account not found' },
  account_updated: () => undefined,
} as const;

export const createAccountHandlers = ({ getUseCases }: AccountHandlerDeps) => {
  const submitOnboarding = async (
    ctx: ProtectedContext,
    data: z.infer<ReturnType<typeof zSubmitOnboardingInput>>
  ) => {
    await unwrapApplicationResult(
      getUseCases(ctx).submitOnboarding({
        currentUserId: ctx.scope.userId,
        name: data.name,
      }),
      accountReasonConfig
    );
  };

  const updateInfo = async (
    ctx: ProtectedContext,
    data: z.infer<ReturnType<typeof zUpdateInfoInput>>
  ) => {
    await unwrapApplicationResult(
      getUseCases(ctx).updateInfo({
        currentUserId: ctx.scope.userId,
        name: data.name,
      }),
      accountReasonConfig
    );
  };

  return {
    submitOnboarding,
    updateInfo,
  };
};

export type AccountHandlers = ReturnType<typeof createAccountHandlers>;
