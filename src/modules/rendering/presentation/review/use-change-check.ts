/* oxlint-disable @tanstack/query/exhaustive-deps -- Keyed by the immutable result; signed URLs rotate per fetch and must not re-run the check. */
import { queryOptions, useQuery } from '@tanstack/react-query';

import { runChangeCheck } from './change-check';

type ChangeCheckInput = {
  resultId: string;
  sourceUrl: string | null;
  resultUrl: string | null;
  maskUrl: string | null;
  framingChanged: boolean;
};

/**
 * Keyed by result only: results and their sources are immutable, while the
 * signed URLs rotate on every refetch and would otherwise re-run the check.
 */
const changeCheckQuery = (input: ChangeCheckInput) =>
  queryOptions({
    queryKey: ['rendering', 'v1', 'change-check', input.resultId],
    queryFn: () =>
      runChangeCheck({
        sourceUrl: input.sourceUrl ?? '',
        resultUrl: input.resultUrl ?? '',
        maskUrl: input.maskUrl,
        framingChanged: input.framingChanged,
      }),
    enabled: Boolean(input.sourceUrl && input.resultUrl),
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
  });

/** The checker runs when a result is viewed, once per result per session. */
export const useChangeCheck = (input: ChangeCheckInput) =>
  useQuery(changeCheckQuery(input));
