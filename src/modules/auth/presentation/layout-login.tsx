import { Link } from '@tanstack/react-router';
import { ReactNode } from 'react';

import { Logo } from '@/platform/components/brand/logo';
import { LocalSwitcher } from '@/platform/components/ui/local-switcher';
import { ThemeSwitcher } from '@/platform/components/ui/theme-switcher';

import { LoginBrandPanel } from './login-brand-panel';

export const LayoutLogin = (props: {
  children?: ReactNode;
  footer?: ReactNode;
}) => {
  return (
    <div
      className="flex flex-1 bg-background pt-safe-top pb-safe-bottom"
      data-testid="layout-login"
    >
      <div className="flex w-full flex-1 flex-col gap-4 p-6 max-md:overflow-hidden md:p-10">
        <div className="flex items-center justify-between gap-4">
          <Link to="/" className="flex items-center gap-2 font-medium">
            <Logo className="w-36" />
          </Link>
          <div className="flex flex-wrap justify-end gap-x-4">
            <ThemeSwitcher iconOnly />
            <LocalSwitcher />
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-sm">{props.children}</div>
        </div>
        {props.footer}
      </div>
      <LoginBrandPanel />
    </div>
  );
};
