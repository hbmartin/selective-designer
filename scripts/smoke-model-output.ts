import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readImageDimensions } from '@/modules/rendering/backend';

export const MAX_OUTPUT_BYTES = 40 * 1024 * 1024;

function resultFilename(format: string) {
  switch (format) {
    case 'png':
      return 'output.png';
    case 'jpg':
      return 'output.jpg';
    case 'webp':
      return 'output.webp';
    default:
      return undefined;
  }
}

export async function writeSmokeOutput(
  directory: string,
  bytes: Uint8Array | undefined,
  diagnostics: Record<string, unknown>
) {
  const writeManifest = (output: Record<string, unknown>) =>
    writeFile(
      join(directory, 'result.json'),
      JSON.stringify({ ...diagnostics, ...output }, null, 2),
      { flag: 'wx' }
    );
  if (!bytes?.length || bytes.byteLength > MAX_OUTPUT_BYTES) {
    const reason = bytes?.length ? 'download_limit' : 'no_image';
    await writeManifest({ status: 'rejected', reason });
    return { type: 'output_rejected', reason } as const;
  }

  const dimensions = readImageDimensions(bytes);
  const filename =
    dimensions.type === 'dimensions'
      ? resultFilename(dimensions.format)
      : undefined;
  if (!filename) {
    const reason = 'unsupported_format';
    await writeManifest({ status: 'rejected', reason, dimensions });
    return { type: 'output_rejected', reason } as const;
  }

  await writeFile(join(directory, filename), bytes, { flag: 'wx' });
  await writeManifest({ status: 'saved', dimensions });
  return { type: 'output_saved' } as const;
}
