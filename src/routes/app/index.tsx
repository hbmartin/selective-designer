import { createFileRoute, redirect } from '@tanstack/react-router';

/** The app opens on the designs list. */
export const Route = createFileRoute('/app/')({
  beforeLoad: () => {
    throw redirect({ to: '/app/designs', replace: true });
  },
});
