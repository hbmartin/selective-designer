import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RENDER_MODEL_IDS,
  getAiProvidersConfig,
  parseEnabledModelIds,
  validateAiProvidersBuildConfig,
} from '@/modules/kernel/infrastructure/config/ai-providers';

describe('AI providers config', () => {
  it('defaults to fake providers outside production', () => {
    const config = getAiProvidersConfig({ NODE_ENV: 'development' });
    expect(config).toMatchObject({
      mode: 'fake',
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

  it('allows placeholders only in the explicit CI build context', () => {
    const input = {
      NODE_ENV: 'production',
      GITHUB_ACTIONS: 'true',
      CI_PROVIDER_KEY_PLACEHOLDERS: 'true',
      FAL_KEY: 'ci-placeholder',
      BFL_API_KEY: 'ci-placeholder',
    };
    expect(() => validateAiProvidersBuildConfig(input)).not.toThrow();
    expect(() => getAiProvidersConfig(input)).toThrow(/FAL_KEY, BFL_API_KEY/);
    expect(() =>
      validateAiProvidersBuildConfig({ ...input, VERCEL_ENV: 'production' })
    ).toThrow(/FAL_KEY, BFL_API_KEY/);
    expect(() =>
      validateAiProvidersBuildConfig({
        ...input,
        CI_PROVIDER_KEY_PLACEHOLDERS: undefined,
      })
    ).toThrow(/FAL_KEY, BFL_API_KEY/);
  });

  it('rejects unimplemented webhook mode', () => {
    expect(() =>
      getAiProvidersConfig({
        NODE_ENV: 'development',
        PROVIDER_CALLBACK_MODE: 'webhook',
      })
    ).toThrow(/PROVIDER_CALLBACK_MODE/);
  });

  it('parses the enabled model list in display order', () => {
    expect(parseEnabledModelIds(' krea-3 , gpt-image-2 ,,')).toEqual([
      'krea-3',
      'gpt-image-2',
    ]);
  });
});
