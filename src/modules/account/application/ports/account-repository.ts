import type { ApplicationResult } from '@/modules/kernel/application/result';
import type { UserId } from '@/modules/kernel/domain/ids';

import type {
  AccountOnboardingUpdate,
  AccountProfileUpdate,
  AccountUpdateResult,
} from '../../domain/account';

export type AccountUpdateRepositoryOutcome =
  | { type: 'account_updated'; account: AccountUpdateResult }
  | { type: 'account_not_found' };

export type AccountOnboardingRepositoryOutcome =
  | AccountUpdateRepositoryOutcome
  | { type: 'account_already_onboarded'; account: AccountUpdateResult };

export interface AccountRepository {
  submitOnboarding(
    userId: UserId,
    input: AccountOnboardingUpdate
  ): Promise<ApplicationResult<AccountOnboardingRepositoryOutcome>>;
  updateInfo(
    userId: UserId,
    input: AccountProfileUpdate
  ): Promise<ApplicationResult<AccountUpdateRepositoryOutcome>>;
}
