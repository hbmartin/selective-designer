const AUTH_FILE_BASE = 'tests/e2e/.auth';

// Seed account emails are sourced from the same env vars the seed + CI use
// (see drizzle/seed/user.ts and .github/workflows/e2e-tests.yml). Run the seed
// with matching SEED_USER_EMAIL / SEED_ADMIN_EMAIL values locally to use these.
export const USER_FILE = `${AUTH_FILE_BASE}/user.json`;
const normalizeSeedEmail = (value: string | undefined, fallback: string) => {
  const normalized = value?.trim().toLowerCase();
  return normalized || fallback;
};

export const USER_EMAIL = normalizeSeedEmail(
  process.env.SEED_USER_EMAIL,
  'user@e2e.local'
);

export const ADMIN_FILE = `${AUTH_FILE_BASE}/admin.json`;
export const ADMIN_EMAIL = normalizeSeedEmail(
  process.env.SEED_ADMIN_EMAIL,
  'admin@e2e.local'
);
