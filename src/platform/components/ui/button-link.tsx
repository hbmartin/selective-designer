import {
  type AnyRouter,
  createLink,
  type CreateLinkProps,
  type LinkProps,
  type RegisteredRouter,
} from '@tanstack/react-router';
import type { VariantProps } from 'class-variance-authority';
import type { ComponentPropsWithRef, MouseEvent, ReactElement } from 'react';

import { cn } from '@/platform/lib/tailwind/utils';

import { buttonVariants } from '@/platform/components/ui/button-variants';

function ButtonAnchor({
  className,
  children,
  variant,
  size,
  disabled,
  href,
  tabIndex,
  onClick,
  onAuxClick,
  ...props
}: VariantProps<typeof buttonVariants> &
  ComponentPropsWithRef<'a'> & { disabled?: boolean }) {
  return (
    <a
      {...props}
      href={disabled ? undefined : href}
      role={disabled ? 'link' : props.role}
      aria-disabled={disabled ? true : props['aria-disabled']}
      tabIndex={disabled ? -1 : tabIndex}
      onClick={disabled ? preventActivation : onClick}
      onAuxClick={disabled ? preventActivation : onAuxClick}
      data-disabled={disabled ? '' : undefined}
      className={cn(buttonVariants({ variant, size, className }))}
    >
      <span className={'flex min-w-0 flex-1 items-center justify-center'}>
        {children}
      </span>
    </a>
  );
}

function preventActivation(event: MouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
  event.stopPropagation();
}

export type ButtonLinkHostProps = Omit<
  ComponentPropsWithRef<typeof ButtonAnchor>,
  keyof CreateLinkProps
>;

export type ButtonLinkOptions<
  TRouter extends AnyRouter = RegisteredRouter,
  TFrom extends string = string,
  TTo extends string | undefined = undefined,
  TMaskFrom extends string = TFrom,
  TMaskTo extends string = '',
> = LinkProps<typeof ButtonAnchor, TRouter, TFrom, TTo, TMaskFrom, TMaskTo> & {
  href?: never;
  unsafeRelative?: never;
};

export type ButtonLinkProps<
  TRouter extends AnyRouter = RegisteredRouter,
  TFrom extends string = string,
  TTo extends string | undefined = undefined,
  TMaskFrom extends string = TFrom,
  TMaskTo extends string = '',
> = ButtonLinkHostProps &
  ButtonLinkOptions<TRouter, TFrom, TTo, TMaskFrom, TMaskTo>;

type ButtonLinkComponent = <
  TRouter extends AnyRouter = RegisteredRouter,
  const TFrom extends string = string,
  const TTo extends string | undefined = undefined,
  const TMaskFrom extends string = TFrom,
  const TMaskTo extends string = '',
>(
  props: ButtonLinkProps<TRouter, TFrom, TTo, TMaskFrom, TMaskTo>
) => ReactElement;

export const ButtonLink: ButtonLinkComponent = createLink(ButtonAnchor);
