import type { ApplicationResult } from '@/modules/kernel/application/result';

import type {
  AuthorizationGateway,
  AuthorizationGatewayOutcome,
} from '../ports/authorization-gateway';
import type {
  SessionGateway,
  SessionGatewayOutcome,
} from '../ports/session-gateway';
import type {
  UserAdminGateway,
  UserAdminRemoveOutcome,
  UserAdminRevokeSessionOutcome,
  UserAdminRevokeSessionsOutcome,
} from '../ports/user-admin-gateway';

export type AuthUseCaseDeps = {
  sessionGateway: SessionGateway;
  authorizationGateway: AuthorizationGateway;
  userAdminGateway: UserAdminGateway;
};

export type AuthSessionOutcome = SessionGatewayOutcome;

export type AuthPermissionOutcome = AuthorizationGatewayOutcome;

export type AuthRemoveUserOutcome = UserAdminRemoveOutcome;

export type AuthRevokeUserSessionsOutcome = UserAdminRevokeSessionsOutcome;

export type AuthRevokeUserSessionOutcome = UserAdminRevokeSessionOutcome;

export type AuthResult<TOutcome> = ApplicationResult<TOutcome>;
