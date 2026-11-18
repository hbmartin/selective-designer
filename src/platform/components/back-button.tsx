import type { AnyRouter, RegisteredRouter } from '@tanstack/react-router';
import { ArrowLeftIcon } from 'lucide-react';
import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useNavigateBack } from '@/platform/hooks/use-navigate-back';

import {
  ButtonLink,
  type ButtonLinkProps,
} from '@/platform/components/ui/button-link';

export const BackButton = <
  TRouter extends AnyRouter = RegisteredRouter,
  const TFrom extends string = string,
  const TTo extends string | undefined = '..',
  const TMaskFrom extends string = TFrom,
  const TMaskTo extends string = '',
>({
  children,
  onClick,
  ...props
}: ButtonLinkProps<TRouter, TFrom, TTo, TMaskFrom, TMaskTo>) => {
  const { t } = useTranslation(['components']);
  const { canGoBack, navigateBack } = useNavigateBack();
  // Preserve the inferred destination contract when supplying the default.
  const linkProps = {
    variant: 'ghost',
    size: 'icon-sm',
    ...props,
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      const target = props.target ?? event.currentTarget.getAttribute('target');
      if (
        canGoBack &&
        !props.reloadDocument &&
        !event.defaultPrevented &&
        event.button === 0 &&
        !(event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) &&
        (!target || target === '_self')
      ) {
        event.preventDefault();
        navigateBack({ ignoreBlocker: props.ignoreBlocker });
      }
    },
    to: props.to ?? '..',
  } as ButtonLinkProps<TRouter, TFrom, TTo, TMaskFrom, TMaskTo>;

  return (
    <ButtonLink<TRouter, TFrom, TTo, TMaskFrom, TMaskTo> {...linkProps}>
      {children ?? (
        <>
          <ArrowLeftIcon className="rtl:rotate-180" />
          <span className="sr-only">{t('components:backButton.label')}</span>
        </>
      )}
    </ButtonLink>
  );
};
