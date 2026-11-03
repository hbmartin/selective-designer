import { adminClient, inferAdditionalFields } from 'better-auth/client/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import { adminAc } from 'better-auth/plugins/admin/access';
import { createAuthClient } from 'better-auth/react';

import { permissionStatements, rolePermissions } from '@/modules/auth';
import { envClient } from '@/platform/env/client';

const ac = createAccessControl(permissionStatements);
const betterAuthClientPermissions = {
  ac,
  roles: {
    admin: ac.newRole({
      ...adminAc.statements,
      ...rolePermissions.admin,
    }),
    user: ac.newRole(rolePermissions.user),
  },
};

const betterAuthClient = createAuthClient({
  baseURL:
    typeof globalThis.window === 'undefined'
      ? envClient.VITE_BASE_URL
      : globalThis.window.location.origin,
  plugins: [
    inferAdditionalFields({
      user: {
        onboardedAt: {
          type: 'date',
          // Mirror the server: server-managed, not client-writable input.
          input: false,
        },
      },
    }),
    adminClient({
      ...betterAuthClientPermissions,
    }),
  ],
});

export const authErrorCodes = betterAuthClient.$ERROR_CODES;

export const betterAuthBrowserClient = {
  signInWithPassword(input: { email: string; password: string }) {
    return betterAuthClient.signIn.email(input);
  },
  signOut() {
    return betterAuthClient.signOut();
  },
};
