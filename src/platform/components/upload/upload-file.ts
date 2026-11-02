import { uploadFile } from '@better-upload/client';

/**
 * Upload one file through the app's presigned-upload endpoint and return the
 * server-decided object key. Throws when the upload is rejected or fails.
 */
export async function uploadFileToRoute(input: {
  file: File;
  route: string;
  signal?: AbortSignal;
}): Promise<string> {
  const { file } = await uploadFile({
    file: input.file,
    route: input.route,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return file.objectInfo.key;
}
