import { okValue } from '@tests/support/result';
import { describe, expect, it, vi } from 'vitest';

import type { ModelRequest } from '@/modules/rendering';
import {
  createBflFlux3Model,
  createFakeImageModel,
  gptImageInput,
  ideogramInput,
  kreaInput,
  readImageDimensions,
} from '@/modules/rendering/backend';
import { recordedSettings } from '@/modules/rendering/testing';

const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  sourceImageUrl: 'https://storage.test/source.png',
  sourceSize: { width: 2048, height: 1024 },
  referenceUrls: [
    'https://storage.test/ref-1.png',
    'https://storage.test/ref-2.png',
  ],
  boxes: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }],
  maskUrl: null,
  prompt: 'Place it.',
  ...overrides,
});

describe('fal model inputs', () => {
  it('sends Krea the source first, then references, with regional boxes', () => {
    expect(kreaInput(request())).toEqual({
      image_urls: [
        'https://storage.test/source.png',
        'https://storage.test/ref-1.png',
        'https://storage.test/ref-2.png',
      ],
      prompt: 'Place it.',
      regions: [
        {
          image_idx: 0,
          x: 0.1,
          y: 0.2,
          width: 0.3,
          height: 0.4,
          label: 'edit1',
        },
      ],
      regional_edit: true,
      reasoning_level: 'high',
      image_size: 'auto',
      output_format: 'png',
    });
  });

  it('turns regional editing off without boxes', () => {
    expect(kreaInput(request({ boxes: [] }))).not.toHaveProperty(
      'regional_edit'
    );
  });

  it('gives Ideogram its mask with precise editing', () => {
    expect(
      ideogramInput(request({ maskUrl: 'https://storage.test/m-black.png' }))
    ).toEqual({
      prompt: 'Place it.',
      image_url: 'https://storage.test/source.png',
      reference_image_urls: [
        'https://storage.test/ref-1.png',
        'https://storage.test/ref-2.png',
      ],
      mask_url: 'https://storage.test/m-black.png',
      edit_precision: 'high',
      context_window: 'auto',
      quality: 'high',
    });
  });

  it('gives GPT Image 2 the source, references and mask', () => {
    expect(
      gptImageInput(request({ maskUrl: 'https://storage.test/m-white.png' }))
    ).toMatchObject({
      image_urls: [
        'https://storage.test/source.png',
        'https://storage.test/ref-1.png',
        'https://storage.test/ref-2.png',
      ],
      mask_url: 'https://storage.test/m-white.png',
      quality: 'high',
      num_images: 1,
    });
  });

  it('records scalar settings only, never URLs or the prompt', () => {
    expect(recordedSettings(kreaInput(request()))).toEqual({
      regions_count: 1,
      regional_edit: true,
      reasoning_level: 'high',
      image_size: 'auto',
      output_format: 'png',
    });
  });
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('FLUX 3 (BFL direct)', () => {
  it('submits the prompt with the source as the first image, grounding off', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      json(200, {
        id: 'task-1',
        polling_url: 'https://api.bfl.ai/v1/get_result?id=task-1',
      })
    );
    const model = createBflFlux3Model({ apiKey: 'test-key', fetch: fetchMock });
    expect(okValue(await model.submit(request()))).toEqual({
      type: 'model_submitted',
      providerRequestId: 'https://api.bfl.ai/v1/get_result?id=task-1',
      accountingRequestId: 'task-1',
      settings: {
        resolution: 'match_input',
        grounding: false,
        safety_tolerance: 2,
      },
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.bfl.ai/v1/flux-3-image');
    expect(new Headers(init?.headers).get('x-key')).toBe('test-key');
    expect(JSON.parse(String(init?.body))).toEqual({
      prompt: 'Place it.',
      images: [
        'https://storage.test/source.png',
        'https://storage.test/ref-1.png',
        'https://storage.test/ref-2.png',
      ],
      resolution: 'match_input',
      grounding: false,
      safety_tolerance: 2,
    });
  });

  it('treats validation and credit errors as a rejected request', async () => {
    const model = createBflFlux3Model({
      apiKey: 'k',
      fetch: async () => json(422, { detail: 'bad' }),
    });
    expect(okValue(await model.submit(request()))).toEqual({
      type: 'model_rejected',
      reason: 'provider_rejected_422',
    });
  });

  it('retries throttling as a rate limit', async () => {
    const model = createBflFlux3Model({
      apiKey: 'k',
      fetch: async () => json(429, {}),
    });
    const result = await model.submit(request());
    expect(result.isError() && result.getError().category).toBe('rate_limit');
  });

  it('maps poll statuses', async () => {
    const answers = [
      json(200, { status: 'Reasoning' }),
      json(200, {
        status: 'Ready',
        result: { sample: 'https://delivery.bfl.ai/x.png' },
      }),
      json(200, { status: 'Content Moderated' }),
    ];
    const model = createBflFlux3Model({
      apiKey: 'k',
      fetch: async () => answers.shift() ?? json(500, {}),
    });
    expect(okValue(await model.poll('https://api.bfl.ai/p'))).toEqual({
      type: 'model_pending',
    });
    expect(okValue(await model.poll('https://api.bfl.ai/p'))).toMatchObject({
      type: 'model_completed',
      outputUrl: 'https://delivery.bfl.ai/x.png',
    });
    expect(okValue(await model.poll('https://api.bfl.ai/p'))).toEqual({
      type: 'model_failed',
      reason: 'flux_content_moderated',
    });
  });
});

describe('fake model', () => {
  it('returns the source bytes it fetched, at no cost', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(new Uint8Array([7, 8]), {
          headers: { 'content-type': 'image/png' },
        })
    );
    const model = createFakeImageModel({ modelId: 'krea-3', fetch: fetchMock });
    const submission = okValue(await model.submit(request()));
    expect(submission.type).toBe('model_submitted');
    if (submission.type !== 'model_submitted') return;
    const poll = okValue(await model.poll(submission.providerRequestId));
    expect(fetchMock).toHaveBeenCalledWith('https://storage.test/source.png');
    expect(poll).toMatchObject({
      type: 'model_completed',
      outputBytes: { bytes: new Uint8Array([7, 8]), contentType: 'image/png' },
      costUsdMicros: 0,
    });
  });
});

describe('image dimensions', () => {
  it('reads PNG headers and rejects garbage', () => {
    // 1×1 PNG header + IHDR.
    const png = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
      ),
      (c) => c.charCodeAt(0)
    );
    expect(readImageDimensions(png)).toEqual({
      type: 'dimensions',
      width: 1,
      height: 1,
      format: 'png',
    });
    expect(readImageDimensions(new Uint8Array([1, 2, 3]))).toEqual({
      type: 'unreadable',
    });
  });
});
