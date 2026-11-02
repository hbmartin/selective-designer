import { cn } from '@/platform/lib/tailwind/utils';

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <span
      data-slot="skeleton"
      className={cn(
        'block max-w-full animate-pulse rounded-xs bg-skeleton',
        className
      )}
      {...props}
    />
  );
}

export { Skeleton };
