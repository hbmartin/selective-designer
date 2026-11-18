import { createLink } from '@tanstack/react-router';
import type { VariantProps } from 'class-variance-authority';
import type { ComponentPropsWithRef } from 'react';

import { cn } from '@/platform/lib/tailwind/utils';

import { buttonVariants } from '@/platform/components/ui/button-variants';

function ButtonAnchor({
  className,
  children,
  variant,
  size,
  disabled,
  ...props
}: VariantProps<typeof buttonVariants> &
  ComponentPropsWithRef<'a'> & { disabled?: boolean }) {
  return (
    <a
      {...props}
      data-disabled={disabled ? '' : undefined}
      className={cn(buttonVariants({ variant, size, className }))}
    >
      <span className={'flex min-w-0 flex-1 items-center justify-center'}>
        {children}
      </span>
    </a>
  );
}

export const ButtonLink = createLink(ButtonAnchor);
