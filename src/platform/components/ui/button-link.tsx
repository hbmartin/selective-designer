import type { VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/platform/lib/tailwind/utils';

import { buttonVariants } from '@/platform/components/ui/button-variants';

import { BridgeLink, type BridgeLinkProps } from '@/platform/router';

function ButtonLink({
  className,
  children,
  variant,
  size,
  ...props
}: VariantProps<typeof buttonVariants> &
  ComponentProps<'a'> &
  BridgeLinkProps & { className?: string }) {
  return (
    <BridgeLink
      {...props}
      className={cn(buttonVariants({ variant, size, className }))}
    >
      <span className={'flex min-w-0 flex-1 items-center justify-center'}>
        {children}
      </span>
    </BridgeLink>
  );
}

export { ButtonLink };
