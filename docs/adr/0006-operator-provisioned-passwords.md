# Use operator-provisioned passwords

Selective Designer serves invited users. Sign-in uses an email address and password, and operators provision accounts and recover access. This replaces email codes and GitHub sign-in, keeping account access independent of mail delivery and external identity providers at the cost of operator involvement in recovery. The email address is a login identifier. Operators can change it without an email verification or confirmation step; the existing password works with the new address.

The operator CLI is the sole provisioning entry point. It creates the credential with the account and displays a generated password once in the operator’s terminal. The manager handles existing users. Demo seeding is restricted to direct local databases to keep fixture credentials away from deployments.

Reset commits a credential version increment with the new password. Sessions retain the version captured before password verification, and both native and app session reads validate it against the database. A fixed 30-second cache limits database traffic at the cost of a short revocation window. Redis expiry handles old records; recovery does not need Redis access. Native password mutation and impersonation remain disabled, and sessions without a version stamp are rejected.

A required credential-version read that fails or reaches the freshness limit denies the request while preserving the cookie. A later request can use that cookie if a fresh database read still matches the session version. An authoritative mismatch invalidates the session.
