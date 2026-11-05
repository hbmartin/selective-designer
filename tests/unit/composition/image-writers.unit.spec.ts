import { Result } from '@bloodyowl/boxed';
import { okValue } from '@tests/support/result';
import { makeTestKernel } from '@tests/unit/composition/helpers';
import { expect, it, vi } from 'vitest';

import { getDesignUseCases } from '@/composition/design';
import {
  writeImageWithDetection,
  writeRenderImageWithDetection,
  findRegisteredRenderImage,
} from '@/composition/image-detection-intent';
import { createResultImages } from '@/composition/rendering-pipeline';
import { toDesignName } from '@/modules/design';
import {
  AppError,
  toDesignId,
  toImageId,
  toObjectKey,
  toUserId,
  toRenderResultId,
} from '@/modules/kernel';

vi.mock('@/composition/image-detection-intent', async (original) => ({
  ...(await original<typeof import('@/composition/image-detection-intent')>()),
  writeImageWithDetection: vi.fn(),
  writeRenderImageWithDetection: vi.fn(),
  findRegisteredRenderImage: vi.fn(),
}));

const failure = new AppError({
  code: 'TEST_ATOMIC_WRITE',
  category: 'system',
  status: 500,
});

it('routes production base-image creation through the explicit atomic writer', async () => {
  const kernel = makeTestKernel();
  const userId = okValue(toUserId('owner'));
  const originalKey = okValue(toObjectKey('base-images/original.png'));
  const workingKey = okValue(toObjectKey('working-images/working.png'));
  for (const [key, purpose] of [
    [originalKey, 'base_image'],
    [workingKey, 'working_image'],
  ] as const) {
    await kernel.uploadIntentStore.remember({
      objectKey: key,
      userId,
      purpose,
      contentType: 'image/png',
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    });
  }
  vi.mocked(writeImageWithDetection).mockResolvedValueOnce(
    Result.Error(failure)
  );
  const listener = { imageArrived: vi.fn() };
  const result = await getDesignUseCases({
    kernel,
    imageArrivedListener: listener,
  }).create({
    currentUserId: userId,
    name: okValue(toDesignName('Villa')),
    baseImage: {
      originalKey,
      workingKey,
      original: { width: 100, height: 100 },
      working: { width: 100, height: 100 },
    },
  });
  expect(result.isError() && result.getError()).toBe(failure);
  expect(writeImageWithDetection).toHaveBeenCalledWith(
    kernel,
    expect.objectContaining({
      copiedFromDesignId: null,
      baseImage: expect.objectContaining({
        kind: 'base',
        originalKey,
        workingKey,
      }),
    })
  );
  expect(listener.imageArrived).not.toHaveBeenCalled();
});

it('allocates a render image before handing its write to transaction recovery', async () => {
  const kernel = makeTestKernel();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
    'base64'
  );
  const objectKey = okValue(toObjectKey('renders/output.png'));
  await kernel.objectStorage.putObject({
    objectKey,
    body: png,
    contentType: 'image/png',
  });
  const scheduler = { schedule: vi.fn() };
  vi.mocked(writeRenderImageWithDetection).mockResolvedValueOnce(
    Result.Error(failure)
  );
  vi.mocked(findRegisteredRenderImage).mockResolvedValueOnce(
    Result.Ok({ type: 'result_image_not_registered' })
  );
  const result = await createResultImages(kernel, scheduler).register({
    resultId: okValue(toRenderResultId('result')),
    attempt: 1,
    providerRequestId: 'provider',
    completion: {
      modelVersion: null,
      costUsdMicros: null,
      costSource: 'unavailable',
      completedAt: new Date(),
    },
    sourceSize: { width: 1, height: 1 },
    designId: okValue(toDesignId('design')),
    renderSourceImageId: okValue(toImageId('source')),
    objectKey,
    contentType: 'image/png',
  });
  expect(result.isError() && result.getError()).toBe(failure);
  expect(writeRenderImageWithDetection).toHaveBeenLastCalledWith(
    kernel,
    expect.objectContaining({
      image: expect.objectContaining({
        kind: 'result',
        originalKey: objectKey,
      }),
    })
  );
  expect(scheduler.schedule).not.toHaveBeenCalled();
});
