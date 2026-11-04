import { encode } from 'fast-png';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeSmokeOutput } from '../../../scripts/smoke-model-output';

describe('smoke model artifacts', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'selective-smoke-'));
  });
  afterEach(async () => {
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
    await expect(writeSmokeOutput(directory, bytes, {})).resolves.toEqual({
      type: 'output_saved',
    });
    expect(await readFile(join(directory, 'output.png'))).toEqual(
      Buffer.from(bytes)
    );
  });

  it('records a diagnostic for an unsupported image without writing its bytes', async () => {
    const gifHeader = Buffer.from('47494638396101000100', 'hex');
    await expect(
      writeSmokeOutput(directory, gifHeader, { costUsdMicros: 7 })
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
});
