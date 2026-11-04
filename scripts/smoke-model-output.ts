import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  discardResponseBody,
  hasOversizedResponseBody,
  readLimitedBody,
} from '@/modules/kernel/backend';
import type { ModelId } from '@/modules/rendering';
import {
  contentTypeForFormat,
  readImageDimensions,
} from '@/modules/rendering/backend';

export const MAX_OUTPUT_BYTES = 40 * 1024 * 1024;

type SmokeImage =
  | { type: 'image'; bytes: Uint8Array }
  | { type: 'download_http_error'; status: number }
  | {
      type:
        | 'download_limit'
        | 'download_url_rejected'
        | 'download_timeout'
        | 'download_failed'
        | 'no_image';
    };

type RejectionReason =
  | Exclude<SmokeImage['type'], 'image'>
  | 'inline_output_limit'
  | 'unsupported_format';

export async function downloadSmokeOutput(
  value: string,
  modelId: ModelId
): Promise<SmokeImage> {
  const url = URL.parse(value);
  const domain = modelId === 'flux-3-image' ? 'bfl.ai' : 'fal.media';
  if (
    !url ||
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    (url.hostname !== domain && !url.hostname.endsWith(`.${domain}`))
  )
    return { type: 'download_url_rejected' };

  const signal = AbortSignal.timeout(30_000);
  try {
    const response = await fetch(url, { redirect: 'error', signal });
    if (!response.ok) {
      await discardResponseBody(response);
      return { type: 'download_http_error', status: response.status };
    }
    if (hasOversizedResponseBody(response, MAX_OUTPUT_BYTES)) {
      await discardResponseBody(response);
      return { type: 'download_limit' };
    }
    const bytes = await readLimitedBody(response, MAX_OUTPUT_BYTES);
    return bytes === undefined
      ? { type: 'download_limit' }
      : { type: 'image', bytes };
  } catch (error) {
    return {
      type:
        signal.aborted ||
        (error instanceof Error && error.name === 'TimeoutError')
          ? 'download_timeout'
          : 'download_failed',
    };
  }
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
  const reject = async (
    reason: RejectionReason,
    details?: Record<string, unknown>
  ) => {
    await writeManifest({ status: 'rejected', reason, ...details });
    return { type: 'output_rejected', reason } as const;
  };
  if (image.type === 'download_http_error')
    return reject(image.type, { httpStatus: image.status });
  if (image.type !== 'image') return reject(image.type);
  const { bytes } = image;
  if (!bytes.length) return reject('no_image');
  if (bytes.byteLength > MAX_OUTPUT_BYTES) return reject('inline_output_limit');

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
