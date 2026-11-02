export {
  __resetAccountComposition,
  type AccountOverrides,
  getAccountUseCases,
} from './account';
export {
  __resetAuthComposition,
  type AuthOverrides,
  getAuthUseCases,
} from './auth';
export {
  __resetEmailComposition,
  type EmailOverrides,
  getEmailGateway,
  getEmailServices,
  getEmailUseCases,
} from './email';
export {
  __resetKernelComposition,
  getKernel,
  type KernelOverrides,
} from './kernel';
export {
  __resetUserComposition,
  getUserUseCases,
  type UserOverrides,
} from './user';

import { type AccountOverrides, getAccountUseCases } from './account';
import { type EmailOverrides, getEmailServices } from './email';
import { getKernel, type KernelOverrides } from './kernel';
import { getUserUseCases, type UserOverrides } from './user';

export type ServicesOverrides = {
  kernel?: KernelOverrides;
  user?: Omit<UserOverrides, 'kernel'>;
  account?: Omit<AccountOverrides, 'kernel'>;
  email?: Omit<EmailOverrides, 'kernel' | 'db'>;
};

export function getServices(overrides?: ServicesOverrides) {
  if (overrides === undefined) {
    return {
      kernel: getKernel(),
      user: getUserUseCases(),
      account: getAccountUseCases(),
      email: getEmailServices(),
    } as const;
  }

  const kernel = getKernel(overrides.kernel ?? {});
  return {
    kernel,
    user: getUserUseCases({ ...overrides.user, kernel }),
    account: getAccountUseCases({ ...overrides.account, kernel }),
    email: getEmailServices({ ...overrides.email, kernel }),
  } as const;
}
