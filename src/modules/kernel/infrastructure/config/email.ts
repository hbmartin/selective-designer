import { z } from 'zod';

import {
  baseEnvSchema,
  isProdRuntimeEnvironment,
  parseEnv,
  unsetBlankServiceValue,
  zNonEmptyEnvString,
  zOptionalServiceString,
} from './env-schema';

const PLACEHOLDER_EMAIL_SECRET_VALUES = new Set([
  'changeme',
  'change-me',
  'change_me',
  'replace me',
  'secret',
  'webhook-secret',
]);

const isPlaceholderEmailSecret = (value: string) =>
  PLACEHOLDER_EMAIL_SECRET_VALUES.has(value.trim().toLowerCase());

const isSupportedEmailServer = (value: string) => {
  try {
    return new URL(value).protocol === 'smtp:';
  } catch {
    return false;
  }
};

const sendingEnvSchema = baseEnvSchema.extend({
  RESEND_API_KEY: zOptionalServiceString(zNonEmptyEnvString()),
  EMAIL_SERVER: zOptionalServiceString(zNonEmptyEnvString()),
  EMAIL_FROM: zOptionalServiceString(zNonEmptyEnvString()),
  EMAIL_DELIVERY_DISABLED: z.stringbool().default(false),
});

const enabledSendingEnvSchema = sendingEnvSchema
  .omit({ EMAIL_DELIVERY_DISABLED: true })
  .extend({ EMAIL_FROM: zNonEmptyEnvString() })
  .superRefine((env, ctx) => {
    if (env.EMAIL_SERVER) {
      if (!isSupportedEmailServer(env.EMAIL_SERVER)) {
        ctx.addIssue({
          code: 'custom',
          path: ['EMAIL_SERVER'],
          message: 'EMAIL_SERVER must use the smtp:// protocol',
        });
      } else if (isProdRuntimeEnvironment(env)) {
        ctx.addIssue({
          code: 'custom',
          path: ['EMAIL_SERVER'],
          message: 'EMAIL_SERVER is only supported for local and test delivery',
        });
      }
    } else if (!env.RESEND_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['RESEND_API_KEY'],
        message: 'RESEND_API_KEY is required when EMAIL_SERVER is not set',
      });
    } else if (
      isProdRuntimeEnvironment(env) &&
      isPlaceholderEmailSecret(env.RESEND_API_KEY)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['RESEND_API_KEY'],
        message: 'Update RESEND_API_KEY for production',
      });
    }
  });

const webhookEnvSchema = baseEnvSchema
  .extend({
    RESEND_WEBHOOK_SECRET: zOptionalServiceString(zNonEmptyEnvString()),
    RESEND_WEBHOOK_MAX_BYTES: z.preprocess(
      unsetBlankServiceValue,
      z.coerce.number().int().positive().default(1_000_000)
    ),
  })
  .superRefine((env, ctx) => {
    if (
      isProdRuntimeEnvironment(env) &&
      env.RESEND_WEBHOOK_SECRET &&
      isPlaceholderEmailSecret(env.RESEND_WEBHOOK_SECRET)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['RESEND_WEBHOOK_SECRET'],
        message:
          'RESEND_WEBHOOK_SECRET must not use a placeholder value in production',
      });
    }
  });

export type EmailConfig =
  | { deliveryDisabled: true; server?: string; resendApiKey?: undefined }
  | {
      deliveryDisabled: false;
      from: string;
      server?: string;
      resendApiKey?: string;
    };

let cachedEmailConfig: EmailConfig | undefined;

export function getEmailConfig(): EmailConfig {
  if (cachedEmailConfig) return cachedEmailConfig;

  const env = parseEnv(sendingEnvSchema);
  if (
    env.EMAIL_DELIVERY_DISABLED ||
    !(env.EMAIL_SERVER || env.EMAIL_FROM || env.RESEND_API_KEY)
  ) {
    cachedEmailConfig = { deliveryDisabled: true, server: env.EMAIL_SERVER };
  } else {
    const enabled = parseEnv(enabledSendingEnvSchema, env);
    cachedEmailConfig = {
      deliveryDisabled: false,
      from: enabled.EMAIL_FROM,
      server: enabled.EMAIL_SERVER,
      resendApiKey: enabled.RESEND_API_KEY,
    };
  }
  return cachedEmailConfig;
}

let cachedWebhookConfig: { secret?: string; maxBodyBytes: number } | undefined;

export function getResendWebhookConfig() {
  if (cachedWebhookConfig) return cachedWebhookConfig;
  const env = parseEnv(webhookEnvSchema);
  cachedWebhookConfig = {
    secret: env.RESEND_WEBHOOK_SECRET,
    maxBodyBytes: env.RESEND_WEBHOOK_MAX_BYTES,
  };
  return cachedWebhookConfig;
}
