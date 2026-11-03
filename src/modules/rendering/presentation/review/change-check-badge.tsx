import { AlertTriangleIcon, CheckCircle2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/platform/components/ui/badge';
import { Spinner } from '@/platform/components/ui/spinner';

import type { ChangeCheck } from './change-check';

export const ChangeCheckBadge = (props: { check: ChangeCheck | undefined }) => {
  const { t } = useTranslation(['rendering']);
  const { check } = props;
  if (!check) {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Spinner className="size-3" /> {t('rendering:check.checking')}
      </span>
    );
  }
  if (check.status === 'unavailable') {
    return (
      <span
        className="text-xs text-muted-foreground"
        data-testid="change-check"
        data-status="unavailable"
      >
        {t(`rendering:check.unavailable.${check.reason}`)}
      </span>
    );
  }
  return (
    <span
      className="flex flex-wrap items-center gap-1 text-xs"
      data-testid="change-check"
      data-status={check.warning ? 'warning' : 'ok'}
      title={t('rendering:check.advisory')}
    >
      {check.warning ? (
        <Badge variant="warning" className="text-[10px]">
          <AlertTriangleIcon className="size-3" />
          {t('rendering:check.warning')}
        </Badge>
      ) : (
        <CheckCircle2Icon className="size-3.5 text-positive-600" aria-hidden />
      )}
      {t('rendering:check.result', { percent: check.percent.toFixed(1) })}
    </span>
  );
};
