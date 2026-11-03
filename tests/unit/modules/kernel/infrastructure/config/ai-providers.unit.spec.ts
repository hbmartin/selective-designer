import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RENDER_MODEL_IDS,
  getAiProvidersConfig,
  parseEnabledModelIds,
} from '@/modules/kernel/infrastructure/config/ai-providers';

describe('AI providers config', () => {
  it('defaults to fake providers and polling outside production', () => {
    const config = getAiProvidersConfig({ NODE_ENV: 'development' });
    expect(config).toMatchObject({
      mode: 'fake',
      callbackMode: 'poll',
      enabledModelIds: [...DEFAULT_RENDER_MODEL_IDS],
    });
  });

  it('requires both provider keys in live mode', () => {
    expect(() =>
      getAiProvidersConfig({ NODE_ENV: 'development', PROVIDER_MODE: 'live' })
    ).toThrow(/FAL_KEY, BFL_API_KEY/);
    expect(
      getAiProvidersConfig({
        NODE_ENV: 'development',
        PROVIDER_MODE: 'live',
        FAL_KEY: 'fal-key',
        BFL_API_KEY: 'bfl-key',
      }).mode
    ).toBe('live');
  });

  it('defaults to live and forbids fake providers in production', () => {
    expect(() => getAiProvidersConfig({ NODE_ENV: 'production' })).toThrow(
      /FAL_KEY/
    );
    expect(() =>
      getAiProvidersConfig({ NODE_ENV: 'production', PROVIDER_MODE: 'fake' })
    ).toThrow(/PROVIDER_MODE/);
  });

  it('allows compilation placeholders in GitHub Actions and rejects them on Vercel', () => {
    const input = {
      NODE_ENV: 'production',
      GITHUB_ACTIONS: 'true',
      FAL_KEY: 'ci-placeholder',
      BFL_API_KEY: 'ci-placeholder',
    };
    expect(getAiProvidersConfig(input).mode).toBe('live');
    expect(() =>
      getAiProvidersConfig({ ...input, VERCEL_ENV: 'production' })
    ).toThrow(/FAL_KEY, BFL_API_KEY/);
    expect(() =>
      getAiProvidersConfig({ ...input, GITHUB_ACTIONS: undefined })
    ).toThrow(/FAL_KEY, BFL_API_KEY/);
  });

  it('requires a public https base URL for webhook callbacks', () => {
    expect(() =>
      getAiProvidersConfig({
        NODE_ENV: 'development',
        PROVIDER_CALLBACK_MODE: 'webhook',
        PROVIDER_WEBHOOK_BASE_URL: 'http://localhost:3000',
      })
    ).toThrow(/PROVIDER_WEBHOOK_BASE_URL/);
    expect(
      getAiProvidersConfig({
        NODE_ENV: 'development',
        PROVIDER_CALLBACK_MODE: 'webhook',
        PROVIDER_WEBHOOK_BASE_URL: 'https://designer.example.com/',
      }).webhookBaseUrl
    ).toBe('https://designer.example.com');
  });

  it('parses the enabled model list in display order', () => {
    expect(parseEnabledModelIds(' krea-3 , gpt-image-2 ,,')).toEqual([
      'krea-3',
      'gpt-image-2',
    ]);
  });
});
