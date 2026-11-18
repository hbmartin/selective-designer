import { ButtonLinkFixtureRouter } from '@tests/support/button-link-router';
import { PlusIcon } from 'lucide-react';
import { type ReactNode } from 'react';

import { ResponsiveIconButtonLink } from '@/platform/components/ui/responsive-icon-button-link';

function Default() {
  return (
    <ResponsiveIconButtonLink to="/" label="Add">
      <PlusIcon />
    </ResponsiveIconButtonLink>
  );
}

function Sizes() {
  return (
    <div className="flex gap-4">
      <ResponsiveIconButtonLink to="/" label="Add" size="sm">
        <PlusIcon />
      </ResponsiveIconButtonLink>
      <ResponsiveIconButtonLink to="/" label="Add" size="default">
        <PlusIcon />
      </ResponsiveIconButtonLink>
      <ResponsiveIconButtonLink to="/" label="Add" size="lg">
        <PlusIcon />
      </ResponsiveIconButtonLink>
    </div>
  );
}

function Variants() {
  return (
    <div className="flex gap-4">
      <ResponsiveIconButtonLink to="/" label="Add">
        <PlusIcon />
      </ResponsiveIconButtonLink>
      <ResponsiveIconButtonLink to="/" label="Add" variant="secondary">
        <PlusIcon />
      </ResponsiveIconButtonLink>
      <ResponsiveIconButtonLink to="/" label="Add" variant="ghost">
        <PlusIcon />
      </ResponsiveIconButtonLink>
      <ResponsiveIconButtonLink to="/" label="Add" variant="destructive">
        <PlusIcon />
      </ResponsiveIconButtonLink>
      <ResponsiveIconButtonLink
        to="/"
        label="Add"
        variant="destructive-secondary"
      >
        <PlusIcon />
      </ResponsiveIconButtonLink>
      <ResponsiveIconButtonLink to="/" label="Add" variant="link">
        <PlusIcon />
      </ResponsiveIconButtonLink>
    </div>
  );
}

const withRouter = (Fixture: () => ReactNode) =>
  function RouterFixture() {
    return (
      <ButtonLinkFixtureRouter>
        <Fixture />
      </ButtonLinkFixtureRouter>
    );
  };

export default {
  Default: withRouter(Default),
  Sizes: withRouter(Sizes),
  Variants: withRouter(Variants),
};
