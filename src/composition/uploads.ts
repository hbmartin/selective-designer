import { Result } from '@bloodyowl/boxed';
import { match, P } from 'ts-pattern';

import { getAuthUseCases } from '@/composition/auth';
import type { AuthSession } from '@/modules/auth';
import {
  designUploadRouteDefinitions,
  handleImageDownload,
} from '@/modules/design/backend';
import { uploadPurposes } from '@/modules/kernel';
import { getTelemetry } from '@/platform/telemetry';

import { getDesignUseCases } from './design';
import { getKernel } from './kernel';
import { createCachedFactory } from './shared/singleton';

const getCurrentSession = async (
  headers: Headers
): Promise<AuthSession | null> => {
  const result = await getAuthUseCases().getCurrentSession({ headers });
  return match(result)
    .with(Result.P.Error(P.select()), (error) => {
      throw error;
    })
    .with(
      Result.P.Ok({ type: 'auth_session_found', session: P.select() }),
      (session) => session
    )
    .with(Result.P.Ok({ type: 'auth_session_missing' }), () => null)
    .exhaustive();
};

const uploadRoutes = () => {
  const kernel = getKernel();
  return designUploadRouteDefinitions(
    {
      getCurrentSession,
      getUseCases: getDesignUseCases,
      telemetry: kernel.telemetry,
      logger: kernel.logger,
    },
    uploadPurposes
  );
};

/** Upload route names accepted by `/api/upload` (one per upload purpose). */
export type UploadRoutes = (typeof uploadPurposes)[number];

const uploadHandlerFactory = createCachedFactory(() =>
  getKernel().objectStorage.createUploadRequestHandler(uploadRoutes())
);

export const handleUploadRequest = (request: Request) =>
  getTelemetry().startSpan(
    {
      attributes: {
        'http.request.method': request.method,
        'operation.name': 'design.uploadRequest',
        'operation.type': 'http_handler',
        'upload.provider': 'better-upload',
      },
      name: 'design.uploadRequest',
      op: 'upload.http',
    },
    () => uploadHandlerFactory.get()(request)
  );

export const handleImageDownloadRequest = (request: Request, imageId: string) =>
  handleImageDownload(
    { getCurrentSession, getUseCases: getDesignUseCases },
    { request, imageId }
  );
