export const hasOversizedResponseBody = (
  response: Response,
  maxBytes: number
) => {
  const size = Number(response.headers.get('content-length'));
  return Number.isFinite(size) && size > maxBytes;
};

/** Release an unused response body without masking its HTTP outcome. */
export async function discardResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

export const readLimitedBody = async (
  response: Response,
  maxBytes: number
): Promise<Uint8Array | undefined> => {
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength <= maxBytes ? bytes : undefined;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};
