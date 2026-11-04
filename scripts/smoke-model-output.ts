import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readLimitedBody } from '@/modules/kernel/backend';
import type { ModelId } from '@/modules/rendering';
import {
  contentTypeForFormat,
  readImageDimensions,
} from '@/modules/rendering/backend';

export const MAX_OUTPUT_BYTES = 40 * 1024 * 1024;

type SmokeImage =
  | { type: 'image'; bytes: Uint8Array }
  | { type: 'download_limit' }
  | { type: 'no_image' };

export async function downloadSmokeOutput(
  value: string,
  modelId: ModelId
): Promise<SmokeImage> {
  const url = new URL(value);
  const domain = modelId === 'flux-3-image' ? 'bfl.ai' : 'fal.media';
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    (url.hostname !== domain && !url.hostname.endsWith(`.${domain}`))
  )
    throw new Error('The provider returned an unexpected download URL.');
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`Could not download the result (HTTP ${response.status}).`);
  if (Number(response.headers.get('content-length')) > MAX_OUTPUT_BYTES) {
    await response.body?.cancel();
    return { type: 'download_limit' };
  }
  const bytes = await readLimitedBody(response, MAX_OUTPUT_BYTES);
  return bytes === undefined
    ? { type: 'download_limit' }
    : { type: 'image', bytes };
}

export async function writeSmokeOutput(
  directory: string,
  image: SmokeImage,
  diagnostics: Record<string, unknown>
) {
  const writeManifest = (output: Record<string, unknown>) =>
    writeFile(
      join(directory, 'result.json'),
      JSON.stringify({ ...diagnostics, ...output }, null, 2),
      { flag: 'wx' }
    );
  const reject = async (reason: string, details?: Record<string, unknown>) => {
    await writeManifest({ status: 'rejected', reason, ...details });
    return { type: 'output_rejected', reason } as const;
  };
  if (image.type !== 'image') return reject(image.type);
  const { bytes } = image;
  if (!bytes.length) return reject('no_image');
  if (bytes.byteLength > MAX_OUTPUT_BYTES) return reject('download_limit');

  const dimensions = readImageDimensions(bytes);
  const filename =
    dimensions.type === 'dimensions' && contentTypeForFormat(dimensions.format)
      ? `output.${dimensions.format}`
      : undefined;
  if (!filename) return reject('unsupported_format', { dimensions });

  await writeFile(join(directory, filename), bytes, { flag: 'wx' });
  await writeManifest({ status: 'saved', dimensions });
  return { type: 'output_saved' } as const;
}
