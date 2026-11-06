import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCwIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Button } from '@/platform/components/ui/button';

import { renderingQueries } from './wired-queries';
import type { RenderResultView } from '../application/use-cases/renders';

export const RenderRetry = ({ result }: { result: RenderResultView }) => {
  const { t } = useTranslation(['rendering']);
  const queryClient = useQueryClient();
  const retry = useMutation({
    ...renderingQueries.retry(),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: renderingQueries.all() }),
    onError: () => toast.error(t('rendering:errors.retryFailed')),
  });
  if (!result.retryable) return null;
  const message =
    result.status === 'failed'
      ? (result.errorMessage ?? '')
      : t('rendering:history.delayed');
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-muted-foreground">
        {t('rendering:history.retryHint')}
      </p>
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-xs text-muted-foreground" title={message}>
          {message}
        </p>
        <Button
          size="xs"
          variant="ghost"
          loading={retry.isPending}
          onClick={() => retry.mutate({ resultId: result.id })}
        >
          <RotateCwIcon />
          {t('rendering:history.retry')}
        </Button>
      </div>
    </div>
  );
};
