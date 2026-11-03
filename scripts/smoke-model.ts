import { encode } from 'fast-png';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { toObjectKey } from '@/modules/kernel';
import {
  BetterUploadObjectStorage,
  getAiProvidersConfig,
} from '@/modules/kernel/backend';
import {
  buildPrompt,
  isModelId,
  MODEL_CATALOG,
  type ModelId,
  modelIds,
  type ModelRequest,
  type RenderRecipe,
} from '@/modules/rendering';
import {
  createBflFlux3Model,
  createFalImageModel,
  gptImageInput,
  ideogramInput,
  kreaInput,
  readImageDimensions,
} from '@/modules/rendering/backend';

const size = { width: 768, height: 512 };
const target = { x: 0.6, y: 0.44, width: 0.24, height: 0.34 };
const isTarget = (x: number, y: number) =>
  x >= target.x &&
  x < target.x + target.width &&
  y >= target.y &&
  y < target.y + target.height;

const png = (
  width: number,
  height: number,
  channels: 1 | 3,
  pixel: (x: number, y: number) => number[]
) => {
  const data = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data.set(pixel(x / width, y / height), (y * width + x) * channels);
    }
  }
  return encode({ width, height, channels, data, depth: 8 });
};

const sourceName = 'source.png';
const referenceName = 'reference.png';
const maskName = 'model-mask.png';

const recipe: RenderRecipe = {
  renderSourceImageId: 'smoke-source',
  source: { workingKey: sourceName, ...size },
  edits: [
    {
      kind: 'placement',
      id: 'smoke-placement',
      box: target,
      rotationDeg: 0,
      note: 'Replace the blue rectangle with the red sphere. Keep the yellow stripes and green square unchanged.',
      item: {
        itemId: 'smoke-sphere',
        itemVersionId: 'smoke-sphere-v1',
        name: 'red sphere',
        kind: 'product',
        referenceKey: referenceName,
      },
    },
  ],
  prompt: '',
  editMaskKey: maskName,
};

const fixtureFiles = (modelId: ModelId) => {
  const polarity = MODEL_CATALOG[modelId].maskPolarity;
  const assets = new Map([
    [
      sourceName,
      png(size.width, size.height, 3, (x, y) => {
        if (isTarget(x, y)) return [45, 107, 198];
        if (x > 0.16 && x < 0.36 && y > 0.24 && y < 0.54) return [36, 134, 88];
        if (y < 0.12 && Math.floor(x * 20) % 2 === 0) return [230, 172, 55];
        return y < 0.79 ? [216, 221, 224] : [156, 166, 171];
      }),
    ],
    [
      referenceName,
      png(256, 256, 3, (x, y) => {
        if (Math.hypot(x - 0.5, y - 0.5) > 0.35) return [244, 242, 237];
        const light = Math.max(0, 1 - 2.2 * Math.hypot(x - 0.4, y - 0.35));
        return [Math.round(145 + 105 * light), Math.round(25 + 65 * light), 36];
      }),
    ],
  ]);
  if (polarity) {
    const editValue = polarity === 'white_edits' ? 255 : 0;
    assets.set(
      maskName,
      png(size.width, size.height, 1, (x, y) => [
        isTarget(x, y) ? editValue : 255 - editValue,
      ])
    );
  }
  return assets;
};

const createAdapter = (modelId: ModelId) => {
  const { falKey, bflApiKey, mode } = getAiProvidersConfig();
  if (mode !== 'live')
    throw new Error('Set PROVIDER_MODE=live for paid execution.');
  if (modelId === 'flux-3-image') {
    if (!bflApiKey) throw new Error('BFL_API_KEY is required.');
    return createBflFlux3Model({ apiKey: bflApiKey });
  }
  if (!falKey) throw new Error('FAL_KEY is required.');
  const builders = {
    'krea-3': kreaInput,
    'ideogram-4-5': ideogramInput,
    'gpt-image-2': gptImageInput,
  };
  return createFalImageModel({
    falKey,
    endpoint: MODEL_CATALOG[modelId].endpoint,
    buildInput: builders[modelId],
  });
};

const signedInputs = async (files: Map<string, Uint8Array>, folder: string) => {
  const storage = new BetterUploadObjectStorage();
  const urls = new Map<string, string>();
  await Promise.all(
    [...files].map(async ([name, body]) => {
      const key = toObjectKey(`smoke-model/${folder}/${name}`);
      if (key.isError()) throw key.getError();
      const stored = await storage.putObject({
        objectKey: key.get(),
        body,
        contentType: 'image/png',
      });
      if (stored.isError())
        throw new Error('Could not upload the synthetic fixture.');
      const signed = await storage.createSignedReadUrl({
        objectKey: key.get(),
        expiresInSeconds: 1800,
      });
      if (signed.isError())
        throw new Error('Could not sign the synthetic fixture.');
      const { url } = signed.get();
      if (new URL(url).protocol !== 'https:')
        throw new Error(
          'Live fixtures require an HTTPS object storage endpoint reachable by the providers.'
        );
      urls.set(name, url);
    })
  );
  return (name: string) => {
    const url = urls.get(name);
    if (!url) throw new Error('Missing signed fixture.');
    return url;
  };
};

async function main() {
  const [selected, flag, ...rest] = process.argv.slice(2);
  if (
    !selected ||
    !isModelId(selected) ||
    (flag && flag !== '--live') ||
    rest.length
  ) {
    throw new Error(`Usage: pnpm smoke:model <${modelIds.join('|')}> [--live]`);
  }
  const spec = MODEL_CATALOG[selected];
  const files = fixtureFiles(selected);
  await mkdir('test-results', { recursive: true });
  const directory = await mkdtemp(join('test-results', 'smoke-model-'));
  await Promise.all(
    [...files].map(([name, bytes]) => writeFile(join(directory, name), bytes))
  );

  const request: ModelRequest = {
    sourceImageUrl: sourceName,
    sourceSize: size,
    referenceUrls: [referenceName],
    boxes: [target],
    maskUrl: spec.maskPolarity ? maskName : null,
    prompt: buildPrompt(recipe, selected),
  };
  await writeFile(
    join(directory, 'request.json'),
    JSON.stringify(
      {
        model: selected,
        endpoint: spec.endpoint,
        maskPolarity: spec.maskPolarity,
        ...request,
      },
      null,
      2
    )
  );
  console.log(`Fixture and request: ${directory}`);
  if (flag !== '--live') return;

  const adapter = createAdapter(selected);
  const url = await signedInputs(
    files,
    directory.split('/').at(-1) ?? directory
  );
  const startedAt = Date.now();
  const submission = await adapter.submit({
    ...request,
    sourceImageUrl: url(sourceName),
    referenceUrls: [url(referenceName)],
    maskUrl: request.maskUrl ? url(maskName) : null,
  });
  if (submission.isError())
    throw new Error(
      'Provider submission failed. Check the provider dashboard before trying again.'
    );
  const submitted = submission.get();
  if (submitted.type === 'model_rejected')
    throw new Error(`Model rejected the smoke request: ${submitted.reason}`);

  const deadline = startedAt + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const polled = await adapter.poll(submitted.providerRequestId);
    if (polled.isError())
      throw new Error(
        'Provider polling failed. Check the provider dashboard before trying again.'
      );
    const result = polled.get();
    if (result.type === 'model_failed')
      throw new Error(`Model failed: ${result.reason}`);
    if (result.type === 'model_pending') {
      await delay(4000);
      continue;
    }
    let bytes = result.outputBytes?.bytes;
    if (!bytes && result.outputUrl) {
      const response = await fetch(result.outputUrl, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok)
        throw new Error(
          `Could not download the result (HTTP ${response.status}).`
        );
      bytes = new Uint8Array(await response.arrayBuffer());
    }
    if (!bytes) throw new Error('The provider returned no image.');
    const dimensions = readImageDimensions(bytes);
    if (dimensions.type !== 'dimensions')
      throw new Error('The result is not a supported image.');
    await writeFile(join(directory, `output.${dimensions.format}`), bytes);
    await writeFile(
      join(directory, 'result.json'),
      JSON.stringify(
        {
          elapsedMs: Date.now() - startedAt,
          dimensions,
          modelVersion: result.modelVersion,
          settings: submitted.settings,
          costUsdMicros: result.costUsdMicros ?? spec.estimatedCostUsdMicros,
          costSource:
            result.costUsdMicros === null ? 'price_table' : result.costSource,
        },
        null,
        2
      )
    );
    console.log(
      'Compare the output to the source. The sphere should replace the blue rectangle, with framing and the other shapes preserved.'
    );
    return;
  }
  throw new Error(
    'Timed out waiting for the model. Check the provider dashboard before trying again.'
  );
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Smoke run failed.');
  process.exitCode = 1;
}
