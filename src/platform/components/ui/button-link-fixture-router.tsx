import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
  RouterProvider,
} from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';

export function ButtonLinkFixtureRouter({ children }: { children: ReactNode }) {
  const [router] = useState(() =>
    createRouter({
      routeTree: createRootRoute({ component: () => null }).addChildren([]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
  );

  return (
    <RouterContextProvider router={router}>
      <RouterProvider router={router} />
      {children}
    </RouterContextProvider>
  );
}
