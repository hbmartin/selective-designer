import { Result } from '@bloodyowl/boxed';
import { describe, expect, it, vi } from 'vitest';

import type { AuthSession } from '@/modules/auth';
import type { DesignUseCases } from '@/modules/design';
import {
  designUploadRouteDefinitions,
  handleImageDownload,
} from '@/modules/design/backend';
import { toObjectKey } from '@/modules/kernel/domain/ids';
import { unwrapParseResult } from '@/modules/kernel/testing';

const session = { user: { id: 'owner-1' } } as unknown as AuthSession;
const telemetry = {
  startSpan: <T>(_options: unknown, fn: () => T) => fn(),
} as never;

describe('design upload routes', () => {
  const routes = (
    prepareUpload: DesignUseCases['prepareUpload'],
    current: AuthSession | null = session
  ) =>
    designUploadRouteDefinitions(
      {
        getCurrentSession: async () => current,
        getUseCases: () => ({ prepareUpload }),
        telemetry,
      },
      ['base_image', 'region_mask']
    );

  it('exposes one route per purpose with that purpose policy', () => {
    const definitions = routes(vi.fn<DesignUseCases['prepareUpload']>());
    expect(Object.keys(definitions)).toEqual(['base_image', 'region_mask']);
    expect(definitions.region_mask?.fileTypes).toEqual(['image/png']);
    expect(definitions.base_image?.maxFileSize).toBe(60 * 1024 * 1024);
  });

  it('pins immutable private caching on prepared uploads', async () => {
    const prepareUpload = vi.fn(async () =>
      Result.Ok({
        type: 'design_upload_prepared' as const,
        objectKey: unwrapParseResult(toObjectKey('base-images/abc.png')),
      })
    );
    const prepared = await routes(prepareUpload).base_image?.prepare({
      headers: new Headers(),
      fileType: 'image/png',
    });
    expect(prepared?.isOk() && prepared.get()).toEqual({
      objectKey: 'base-images/abc.png',
      cacheControl: 'private, max-age=31536000, immutable',
    });
    expect(prepareUpload).toHaveBeenCalledWith({
      currentUserId: 'owner-1',
      purpose: 'base_image',
      fileType: 'image/png',
    });
  });

  it('rejects anonymous and forbidden uploads with translation keys', async () => {
    const anonymous = await routes(
      vi.fn<DesignUseCases['prepareUpload']>(),
      null
    ).base_image?.prepare({
      headers: new Headers(),
      fileType: 'image/png',
    });
    expect(anonymous?.isError() && anonymous.getError().messageKey).toBe(
      'design:upload.errors.NOT_AUTHENTICATED'
    );

    const forbidden = await routes(
      vi.fn(async () => Result.Ok({ type: 'design_upload_forbidden' as const }))
    ).base_image?.prepare({ headers: new Headers(), fileType: 'image/png' });
    expect(forbidden?.isError() && forbidden.getError().messageKey).toBe(
      'design:upload.errors.UNAUTHORIZED'
    );
  });
});

describe('image download handler', () => {
  const request = new Request('https://app.test/api/images/img-1/download');

  it('requires a session and hides unknown images', async () => {
    const getImageDownloadUrl = vi.fn(async () =>
      Result.Ok({ type: 'image_not_found' as const })
    );
    expect(
      (
        await handleImageDownload(
          {
            getCurrentSession: async () => null,
            getUseCases: () => ({ getImageDownloadUrl }),
          },
          { request, imageId: 'img-1' }
        )
      ).status
    ).toBe(401);
    expect(
      (
        await handleImageDownload(
          {
            getCurrentSession: async () => session,
            getUseCases: () => ({ getImageDownloadUrl }),
          },
          { request, imageId: 'img-1' }
        )
      ).status
    ).toBe(404);
  });

  it('redirects owners to the signed download URL', async () => {
    const response = await handleImageDownload(
      {
        getCurrentSession: async () => session,
        getUseCases: () => ({
          getImageDownloadUrl: async () =>
            Result.Ok({
              type: 'image_download_url' as const,
              url: 'https://storage.test/base-images/abc.png?sig=1',
            }),
        }),
      },
      { request, imageId: 'img-1' }
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://storage.test/base-images/abc.png?sig=1'
    );
  });
});
