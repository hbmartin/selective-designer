import { cn } from '@/platform/lib/tailwind/utils';

import type { RegionView } from '../application/use-cases/regions';

/**
 * Tints a region using its mask PNG as a CSS luminance mask, so the overlay
 * follows the mask pixels rather than the bounding box.
 */
export const RegionOverlay = (props: {
  region: Pick<RegionView, 'maskUrl' | 'isSuggestion'>;
  active?: boolean;
}) => (
  <div
    aria-hidden
    className={cn(
      'pointer-events-none absolute inset-0 transition-opacity',
      props.region.isSuggestion ? 'bg-status-warning' : 'bg-primary',
      props.active ? 'opacity-60' : 'opacity-25'
    )}
    style={{
      maskImage: `url(${props.region.maskUrl})`,
      maskMode: 'luminance',
      maskSize: '100% 100%',
      WebkitMaskImage: `url(${props.region.maskUrl})`,
      WebkitMaskSize: '100% 100%',
    }}
  />
);
