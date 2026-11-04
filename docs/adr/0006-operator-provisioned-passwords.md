# Use operator-provisioned passwords

Selective Designer serves invited users. Sign-in uses an email address and password, and operators provision accounts and recover access. This replaces email codes and GitHub sign-in, keeping account access independent of mail delivery and external identity providers at the cost of operator involvement in recovery. The email address is a login identifier. Operators can change it without an email verification or confirmation step; the existing password works with the new address.

The operator CLI is the sole provisioning entry point. It creates the credential with the account and displays a generated password once in the operator’s terminal. The manager handles existing users. Demo seeding is restricted to direct local databases to keep fixture credentials away from deployments.
