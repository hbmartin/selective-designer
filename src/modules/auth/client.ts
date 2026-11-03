import { createUseAuthSession } from './presentation/client';
import { createAuthQueryHooks } from './presentation/queries';
import { authQueries } from './presentation/wired-queries';
import { createWithPermissions } from './presentation/with-permissions';

export {
  type AuthClientResult,
  authErrorCodes,
  checkRolePermission,
  signOut,
  startSignIn,
} from './presentation/client';
export { ConfirmSignOut } from './presentation/confirm-signout';
export {
  type AuthQueryFacade,
  clearAllQueryStateForAuthBoundary,
  createAuthQueries,
  createAuthQueryHooks,
} from './presentation/queries';
export { isReauthRequiredError } from './presentation/reauth-error';
export type {
  FormFieldsLogin,
  FormFieldsOnboarding,
} from './presentation/schema';
export { zFormFieldsLogin, zFormFieldsOnboarding } from './presentation/schema';
export { authQueries } from './presentation/wired-queries';

const authQueryHooks = createAuthQueryHooks(authQueries);

export const useCurrentSessionQuery = authQueryHooks.useCurrentSessionQuery;
export const useCurrentScopeKey = authQueryHooks.useCurrentScopeKey;
export const useAuthSession = createUseAuthSession(useCurrentSessionQuery);
export const WithPermissions = createWithPermissions(useAuthSession);
