import { z } from 'zod';

import {
  baseEnvSchema,
  isProdRuntimeEnvironment,
  parseEnv,
} from './env-schema';

/** Model ids enabled when `RENDER_ENABLED_MODELS` is unset. */
export const DEFAULT_RENDER_MODEL_IDS = [
  'krea-3',
  'flux-3-image',
  'ideogram-4-5',
  'gpt-image-2',
] as const;

const optionalSecret = () =>
  z.preprocess(
    (value) =>
      typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().trim().min(1).optional()
  );

const aiProvidersEnvSchema = baseEnvSchema
  .extend({
    GITHUB_ACTIONS: z.string().optional(),
    VERCEL: z.string().optional(),
    FAL_KEY: optionalSecret(),
    BFL_API_KEY: optionalSecret(),
    /**
     * `fake` serves deterministic local results with no network or cost; it is
     * the default outside production so tests and local work never spend money.
     */
    PROVIDER_MODE: z.enum(['live', 'fake']).optional(),
    /**
     * `webhook` needs a public HTTPS base URL (fal refuses localhost);
     * `poll` works everywhere and is the default.
     */
    PROVIDER_CALLBACK_MODE: z.enum(['webhook', 'poll']).default('poll'),
    PROVIDER_WEBHOOK_BASE_URL: optionalSecret(),
    VERCEL_AUTOMATION_BYPASS_SECRET: optionalSecret(),
    RENDER_ENABLED_MODELS: optionalSecret(),
  })
  .superRefine((env, ctx) => {
    const mode =
      env.PROVIDER_MODE ?? (isProdRuntimeEnvironment(env) ? 'live' : 'fake');

    if (isProdRuntimeEnvironment(env) && mode === 'fake') {
      ctx.addIssue({
        code: 'custom',
        path: ['PROVIDER_MODE'],
        message: 'PROVIDER_MODE=fake is not allowed in production',
      });
    }

    if (mode === 'live') {
      const ciBuild =
        env.GITHUB_ACTIONS === 'true' && !env.VERCEL && !env.VERCEL_ENV;
      for (const field of ['FAL_KEY', 'BFL_API_KEY'] as const) {
        const key = env[field]?.toLowerCase();
        if (
          !key ||
          key === 'replace me' ||
          (key === 'ci-placeholder' && !ciBuild)
        ) {
          ctx.addIssue({
            code: 'custom',
            path: [field],
            message: `${field} is required when PROVIDER_MODE=live`,
          });
        }
      }
    }

    if (env.PROVIDER_CALLBACK_MODE === 'webhook') {
      const base = env.PROVIDER_WEBHOOK_BASE_URL;
      if (!base || !base.startsWith('https://')) {
        ctx.addIssue({
          code: 'custom',
          path: ['PROVIDER_WEBHOOK_BASE_URL'],
          message:
            'PROVIDER_WEBHOOK_BASE_URL must be a public https:// URL when PROVIDER_CALLBACK_MODE=webhook',
        });
      }
    }
  });

export type AiProvidersConfig = {
  mode: 'live' | 'fake';
  falKey: string | undefined;
  bflApiKey: string | undefined;
  callbackMode: 'webhook' | 'poll';
  /** Public origin providers call back to, e.g. `https://app.example.com`. */
  webhookBaseUrl: string | undefined;
  /** Appended to webhook URLs so Vercel deployment protection lets them in. */
  vercelAutomationBypassSecret: string | undefined;
  /** Model ids in the order the UI shows them; validated by `rendering`. */
  enabledModelIds: string[];
};

let cachedAiProvidersConfig: AiProvidersConfig | undefined;

export const parseEnabledModelIds = (value: string | undefined): string[] =>
  value === undefined
    ? [...DEFAULT_RENDER_MODEL_IDS]
    : value
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0);

export function getAiProvidersConfig(
  source?: Record<string, unknown>
): AiProvidersConfig {
  if (cachedAiProvidersConfig && source === undefined) {
    return cachedAiProvidersConfig;
  }

  const env = parseEnv(aiProvidersEnvSchema, source);
  const config: AiProvidersConfig = {
    mode:
      env.PROVIDER_MODE ?? (isProdRuntimeEnvironment(env) ? 'live' : 'fake'),
    falKey: env.FAL_KEY,
    bflApiKey: env.BFL_API_KEY,
    callbackMode: env.PROVIDER_CALLBACK_MODE,
    webhookBaseUrl: env.PROVIDER_WEBHOOK_BASE_URL?.replace(/\/+$/u, ''),
    vercelAutomationBypassSecret: env.VERCEL_AUTOMATION_BYPASS_SECRET,
    enabledModelIds: parseEnabledModelIds(env.RENDER_ENABLED_MODELS),
  };
  if (source === undefined) cachedAiProvidersConfig = config;
  return config;
}
