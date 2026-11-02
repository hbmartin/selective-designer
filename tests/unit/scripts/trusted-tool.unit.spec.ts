import { describe, expect, it } from 'vitest';

import {
  resolveTrustedProjectBin,
  resolveTrustedTool,
  TrustedToolError,
} from '../../../scripts/trusted-tool';

describe('trusted tool resolution', () => {
  it('rejects tool names with path separators', () => {
    expect(() => resolveTrustedTool('../git')).toThrow(TrustedToolError);
  });

  it('rejects dot-only tool names before path resolution', () => {
    expect(() => resolveTrustedTool('.')).toThrow(TrustedToolError);
    expect(() => resolveTrustedTool('..')).toThrow(TrustedToolError);
  });

  it('resolves git from the fixed trusted directory allowlist', () => {
    expect(resolveTrustedTool('git')).toMatch(/git(?:\.exe)?$/);
  });

  it('resolves project tools from the fixed local bin directory', () => {
    expect(resolveTrustedProjectBin('vitest')).toMatch(
      /node_modules[/\\]\.bin[/\\]vitest(?:\.(?:cmd|exe))?$/i
    );
  });
});
