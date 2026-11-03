import type { SVGProps } from 'react';

import { cn } from '@/platform/lib/tailwind/utils';

/** Selective Designer wordmark: a framed image with a placed item, plus name. */
export const Logo = (props: SVGProps<SVGSVGElement>) => (
  <svg
    viewBox="0 0 640 116"
    fill="none"
    {...props}
    className={cn('text-primary', props.className)}
  >
    <title>Selective Designer</title>
    <rect
      x="6"
      y="10"
      width="96"
      height="96"
      rx="18"
      stroke="currentColor"
      strokeWidth="12"
    />
    <path fill="currentColor" d="M24 88 50 56l16 18 10-12 14 26z" />
    <rect x="62" y="26" width="24" height="24" rx="6" fill="currentColor" />
    <text
      x="128"
      y="80"
      fill="currentColor"
      fontFamily="inherit"
      fontSize="58"
      fontWeight="700"
      letterSpacing="-1"
    >
      Selective Designer
    </text>
  </svg>
);
