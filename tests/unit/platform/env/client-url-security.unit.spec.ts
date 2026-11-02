import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('getEnvClient URL security', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('rejects cleartext VITE_BASE_URL for remote hosts in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITE_BASE_URL', 'http://app.example.com');
    vi.stubEnv('VITE_S3_BUCKET_PUBLIC_URL', 'https://cdn.example.com/bucket');
    const { getEnvClient } = await import('@/platform/env/config');

    expect(() => getEnvClient()).toThrow(/HTTPS in production/);
  });

  it('rejects cleartext VITE_S3_BUCKET_PUBLIC_URL for remote hosts in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITE_BASE_URL', 'https://app.example.com');
    vi.stubEnv('VITE_S3_BUCKET_PUBLIC_URL', 'http://cdn.example.com/bucket');
    const { getEnvClient } = await import('@/platform/env/config');

    expect(() => getEnvClient()).toThrow(/VITE_S3_BUCKET_PUBLIC_URL/);
  });

  it('accepts https production URLs', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITE_BASE_URL', 'https://app.example.com');
    vi.stubEnv('VITE_S3_BUCKET_PUBLIC_URL', 'https://cdn.example.com/bucket');
    const { getEnvClient } = await import('@/platform/env/config');

    expect(getEnvClient().VITE_BASE_URL).toBe('https://app.example.com');
  });

  it('accepts cleartext localhost URLs in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITE_BASE_URL', 'http://localhost:3000');
    vi.stubEnv('VITE_S3_BUCKET_PUBLIC_URL', 'http://127.0.0.1:9000/default');
    const { getEnvClient } = await import('@/platform/env/config');

    expect(getEnvClient().VITE_BASE_URL).toBe('http://localhost:3000');
  });

  it('rejects cleartext VITE_SENTRY_DSN for remote hosts in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITE_BASE_URL', 'https://app.example.com');
    vi.stubEnv('VITE_S3_BUCKET_PUBLIC_URL', 'https://cdn.example.com/bucket');
    vi.stubEnv('VITE_SENTRY_DSN', 'http://sentry.example.com/1');
    const { getEnvClient } = await import('@/platform/env/config');

    expect(() => getEnvClient()).toThrow(/VITE_SENTRY_DSN/);
  });
});
