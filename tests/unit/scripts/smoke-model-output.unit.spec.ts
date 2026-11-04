import { encode } from 'fast-png';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  downloadSmokeOutput,
  MAX_OUTPUT_BYTES,
  writeSmokeOutput,
} from '../../../scripts/smoke-model-output';

describe('smoke model artifacts', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'selective-smoke-'));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  });

  it('retains the original provider bytes for an allowed image', async () => {
    const bytes = encode({
      width: 1,
      height: 1,
      depth: 8,
      channels: 1,
      data: Uint8Array.of(42),
    });
    await expect(
      writeSmokeOutput(directory, { type: 'image', bytes }, {})
    ).resolves.toEqual({ type: 'output_saved' });
    expect(await readFile(join(directory, 'output.png'))).toEqual(
      Buffer.from(bytes)
    );
  });

  it('records a diagnostic for an unsupported image without writing its bytes', async () => {
    const gifHeader = Buffer.from('47494638396101000100', 'hex');
    await expect(
      writeSmokeOutput(
        directory,
        { type: 'image', bytes: gifHeader },
        {
          costUsdMicros: 7,
        }
      )
    ).resolves.toEqual({
      type: 'output_rejected',
      reason: 'unsupported_format',
    });
    expect(await readdir(directory)).toEqual(['result.json']);
    const manifest = JSON.parse(
      await readFile(join(directory, 'result.json'), 'utf8')
    );
    expect(manifest).toMatchObject({
      status: 'rejected',
      reason: 'unsupported_format',
      costUsdMicros: 7,
    });
  });

  it.each(['declared', 'streamed', 'empty'] as const)(
    'records the reason for a %s rejected download without saving an image',
    async (scenario) => {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (scenario === 'streamed') {
            controller.enqueue(new Uint8Array(MAX_OUTPUT_BYTES));
            controller.enqueue(Uint8Array.of(1));
          } else if (scenario === 'empty') {
            controller.close();
          }
        },
        cancel,
      });
      const headers =
        scenario === 'declared'
          ? { 'content-length': String(MAX_OUTPUT_BYTES + 1) }
          : undefined;
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response(body, { headers }))
      );
      const result = await downloadSmokeOutput(
        'https://fal.media/smoke-output',
        'krea-3'
      );
      const reason = scenario === 'empty' ? 'no_image' : 'download_limit';
      expect(await writeSmokeOutput(directory, result, {})).toEqual({
        type: 'output_rejected',
        reason,
      });
      expect(cancel).toHaveBeenCalledTimes(scenario === 'empty' ? 0 : 1);
      expect(await readdir(directory)).toEqual(['result.json']);
      expect(
        JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))
      ).toEqual({ status: 'rejected', reason });
    }
  );
});
