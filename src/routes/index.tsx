import { createFileRoute, redirect } from '@tanstack/react-router';

import { observedBeforeLoad } from '@/platform/router/route-observability';

export const Route = createFileRoute('/')({
  component: RouteComponent,
  beforeLoad: observedBeforeLoad('/', () => {
    throw redirect({ to: '/app/designs', replace: true });
  }),
});

function RouteComponent() {
  return null;
}
