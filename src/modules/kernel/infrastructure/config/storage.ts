import { z } from 'zod';

import {
  baseEnvSchema,
  isProdRuntimeEnvironment,
  parseEnv,
  zNonEmptyEnvString,
} from './env-schema';

const PLACEHOLDER_STORAGE_SECRET_VALUES = new Set([
  'access-key',
  'changeme',
  'change-me',
  'change_me',
  'minioadmin',
  'replace me',
  'secret',
  'secret-key',
  'startui-access-key',
  'startui-secret-key',
]);
const LOCAL_STORAGE_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

const isPlaceholderStorageSecret = (value: string) =>
  PLACEHOLDER_STORAGE_SECRET_VALUES.has(value.trim().toLowerCase());

const stripIpv6Brackets = (value: string) =>
  value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;

const storageHostUrl = (value: string) => {
  if (value.includes('://')) return value;

  const [host = '', ...pathParts] = value.split('/');
  const path = pathParts.length ? `/${pathParts.join('/')}` : '';
  if (host === '::1') return `http://[::1]${path}`;
  if (host.startsWith('::1:') && /^\d+$/.test(host.slice('::1:'.length))) {
    return `http://[::1]:${host.slice('::1:'.length)}${path}`;
  }
  if ((host.match(/:/g) ?? []).length > 1 && !host.startsWith('[')) {
    return `http://[${host}]${path}`;
  }

  return `http://${value}`;
};

const hostnameFromStorageHost = (value: string) => {
  try {
    return new URL(storageHostUrl(value)).hostname;
  } catch {
    return undefined;
  }
};

const isLocalStorageHost = (value: string) => {
  const hostname = hostnameFromStorageHost(value);
  return hostname
    ? LOCAL_STORAGE_HOSTS.has(stripIpv6Brackets(hostname))
    : false;
};

const storageEnvSchema = baseEnvSchema
  .extend({
    S3_ACCESS_KEY_ID: zNonEmptyEnvString(),
    S3_SECRET_ACCESS_KEY: zNonEmptyEnvString(),
    S3_BUCKET_NAME: zNonEmptyEnvString().default('default'),
    S3_REGION: zNonEmptyEnvString().default('auto'),
    S3_HOST: zNonEmptyEnvString(),
    S3_SECURE: z.stringbool().default(true),
    S3_FORCE_PATH_STYLE: z.stringbool().default(false),
  })
  .superRefine((env, ctx) => {
    if (!isProdRuntimeEnvironment(env)) return;

    if (!env.S3_SECURE && !isLocalStorageHost(env.S3_HOST)) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_SECURE'],
        message: 'S3_SECURE=false is only allowed for local storage hosts',
      });
    }

    for (const field of ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
      if (isPlaceholderStorageSecret(env[field])) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} must not use a placeholder value in production`,
        });
      }
    }
  });

export type StorageConfig = {
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  region: string;
  host: string;
  secure: boolean;
  forcePathStyle: boolean;
};

let cachedStorageConfig: StorageConfig | undefined;

export function getStorageConfig(): StorageConfig {
  if (cachedStorageConfig) return cachedStorageConfig;

  const env = parseEnv(storageEnvSchema);
  cachedStorageConfig = {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    bucketName: env.S3_BUCKET_NAME,
    region: env.S3_REGION,
    host: env.S3_HOST,
    secure: env.S3_SECURE,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  };
  return cachedStorageConfig;
}
