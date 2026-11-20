import type { ReactNode } from 'react';

import { cn } from '@/platform/lib/tailwind/utils';

export const EmptyState = (props: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  size?: 'default' | 'sm';
  className?: string;
}) => {
  const isSmall = props.size === 'sm';
  return (
    <div
      data-slot="empty-state"
      className={cn(
        'flex flex-col items-center justify-center rounded-xl border border-dashed text-center',
        isSmall ? 'gap-2 px-4 py-6' : 'gap-3 px-6 py-14',
        props.className
      )}
    >
      {!!props.icon && (
        <div
          aria-hidden
          className={cn(
            'flex items-center justify-center rounded-full bg-brand-subtle text-brand-subtle-foreground',
            isSmall ? 'size-9 [&_svg]:size-4' : 'size-12 [&_svg]:size-5'
          )}
        >
          {props.icon}
        </div>
      )}
      <div className="flex max-w-sm flex-col gap-1">
        <p
          className={cn(
            'font-display font-medium tracking-tight',
            isSmall ? 'text-base' : 'text-xl'
          )}
        >
          {props.title}
        </p>
        {!!props.description && (
          <p
            className={cn(
              'text-muted-foreground',
              isSmall ? 'text-xs' : 'text-sm'
            )}
          >
            {props.description}
          </p>
        )}
      </div>
      {!!props.action && <div className="mt-2">{props.action}</div>}
    </div>
  );
};
