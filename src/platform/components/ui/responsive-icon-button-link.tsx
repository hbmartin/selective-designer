import type { AnyRouter, RegisteredRouter } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { match } from 'ts-pattern';

import { cn } from '@/platform/lib/tailwind/utils';
import { useIsMobile } from '@/platform/hooks/use-mobile';

import {
  ButtonLink,
  type ButtonLinkHostProps,
  type ButtonLinkOptions,
  type ButtonLinkProps,
} from '@/platform/components/ui/button-link';

export type ResponsiveIconButtonLinkProps<
  TRouter extends AnyRouter = RegisteredRouter,
  TFrom extends string = string,
  TTo extends string | undefined = undefined,
  TMaskFrom extends string = TFrom,
  TMaskTo extends string = '',
> = Omit<ButtonLinkHostProps, 'size'> &
  ButtonLinkOptions<TRouter, TFrom, TTo, TMaskFrom, TMaskTo> & {
    label: ReactNode;
    size?: 'xs' | 'sm' | 'default' | 'lg';
    breakpoint?: number;
  };

export const ResponsiveIconButtonLink = <
  TRouter extends AnyRouter = RegisteredRouter,
  const TFrom extends string = string,
  const TTo extends string | undefined = undefined,
  const TMaskFrom extends string = TFrom,
  const TMaskTo extends string = '',
>({
  label,
  size,
  breakpoint,
  children,
  ...props
}: ResponsiveIconButtonLinkProps<TRouter, TFrom, TTo, TMaskFrom, TMaskTo>) => {
  const isMobile = useIsMobile(breakpoint);
  const buttonIconSize = match(size)
    .with('default', undefined, () => 'icon' as const)
    .with('xs', () => 'icon-xs' as const)
    .with('sm', () => 'icon-sm' as const)
    .with('lg', () => 'icon-lg' as const)
    .exhaustive();
  const buttonSize = isMobile ? buttonIconSize : size;
  // Rest destructuring cannot preserve TanStack's conditional destination types.
  const linkProps = { ...props, size: buttonSize } as ButtonLinkProps<
    TRouter,
    TFrom,
    TTo,
    TMaskFrom,
    TMaskTo
  >;

  return (
    <ButtonLink<TRouter, TFrom, TTo, TMaskFrom, TMaskTo> {...linkProps}>
      {(state) => (
        <>
          {typeof children === 'function' ? children(state) : children}
          <span className={cn(isMobile && 'sr-only')}>{label}</span>
        </>
      )}
    </ButtonLink>
  );
};
