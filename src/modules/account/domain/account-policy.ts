/**
 * Maximum stored length of an account display name. Shared by the presentation
 * form schema and the server-side transport validator so the bound is enforced
 * at both tiers (A04 "plausibility checks at each tier"). (CWE-1284 / CWE-770.)
 */
export const ACCOUNT_NAME_MAX_LENGTH = 200;
