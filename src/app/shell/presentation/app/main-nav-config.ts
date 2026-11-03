import { linkOptions } from '@tanstack/react-router';
import { ImagesIcon, TrophyIcon } from 'lucide-react';

import {
  IconUserCircleDuotone,
  IconUserCircleFill,
} from '@/platform/components/icons/generated';

export const MAIN_NAV_LINKS = linkOptions([
  {
    labelTranslationKey: 'layout:nav.designs',
    icon: ImagesIcon,
    iconActive: ImagesIcon,
    to: '/app/designs',
  },
  {
    labelTranslationKey: 'layout:nav.scorecard',
    icon: TrophyIcon,
    iconActive: TrophyIcon,
    to: '/app/scorecard',
  },
  {
    labelTranslationKey: 'layout:nav.account',
    icon: IconUserCircleDuotone,
    iconActive: IconUserCircleFill,
    to: '/app/account',
  },
]);

export type NavLinkItem = Omit<
  (typeof MAIN_NAV_LINKS)[number],
  'labelTranslationKey'
> & { children?: React.ReactNode };
