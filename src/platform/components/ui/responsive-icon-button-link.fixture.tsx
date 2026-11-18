import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { PlusIcon } from 'lucide-react';
import { ReactNode, useMemo } from 'react';

import { ResponsiveIconButtonLink } from '@/platform/components/ui/responsive-icon-button-link';

import { attachBridgeLinkLocationTracking } from '@/platform/router/bridge-link-location';

const RouterWrapper = ({ children }: { children: ReactNode }) => {
  const router = useMemo(() => {
    const rootRoute = createRootRoute({
      component: () => <>{children}</>,
    });
    const routeTree = rootRoute.addChildren([]);
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    attachBridgeLinkLocationTracking(router);
    return router;
  }, [children]);

  return <RouterProvider router={router} />;
};
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
      <RouterWrapper>
        <Fixture />
      </RouterWrapper>
    );
  };

export default {
  Default: withRouter(Default),
  Sizes: withRouter(Sizes),
  Variants: withRouter(Variants),
};
