import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from '@tanstack/react-router';
import { createRef, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import { ButtonLink } from '@/platform/components/ui/button-link';

async function renderLink(children: ReactNode) {
  const root = createRootRoute();
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/manager/users/sample'] }),
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: '/manager' }),
      createRoute({ getParentRoute: () => root, path: '/manager/users/$id' }),
      createRoute({
        getParentRoute: () => root,
        path: '/manager/users/$id/update',
      }),
    ]),
  });
  await router.load();
  return renderToStaticMarkup(
    <RouterContextProvider router={router}>{children}</RouterContextProvider>
  );
}

it('preserves button styling and child layout without leaking host options', async () => {
  const markup = await renderLink(
    <ButtonLink
      to="/manager"
      variant="secondary"
      size="lg"
      className="custom-link"
    >
      Manager
    </ButtonLink>
  );
  expect(markup).toContain('href="/manager"');
  expect(markup).toContain('bg-background');
  expect(markup).toContain('h-10');
  expect(markup).toContain('custom-link');
  expect(markup).toContain(
    '<span class="flex min-w-0 flex-1 items-center justify-center">Manager</span>'
  );
  expect(markup).not.toMatch(/ (?:variant|size|to|disabled)=/);
});

it('resolves parameters and relative destinations with native Link', async () => {
  const markup = await renderLink(
    <>
      <ButtonLink to="/manager/users/$id" params={{ id: 'sample' }}>
        User
      </ButtonLink>
      <ButtonLink
        from="/manager/users/$id/"
        to="./update"
        params={{ id: 'sample' }}
      >
        Edit
      </ButtonLink>
    </>
  );
  expect(markup).toContain('href="/manager/users/sample"');
  expect(markup).toContain('href="/manager/users/sample/update"');
});

it('resolves render-prop children before placing them in the styled span', async () => {
  const markup = await renderLink(
    <ButtonLink to="/manager/users/$id" params={{ id: 'sample' }}>
      {({ isActive }) => (isActive ? 'Current user' : 'Other user')}
    </ButtonLink>
  );
  expect(markup).toContain('aria-current="page"');
  expect(markup).toContain('>Current user</span>');
});

it('keeps disabled navigation inert without a disabled anchor attribute', async () => {
  const markup = await renderLink(
    <ButtonLink to="/manager" disabled>
      Manager
    </ButtonLink>
  );
  expect(markup).toContain('aria-disabled="true"');
  expect(markup).not.toContain('href=');
  expect(markup).not.toMatch(/ disabled=/);
});

it('infers route parameters, relative destinations, and anchor refs', () => {
  void (<ButtonLink to="/manager/users/$id" params={{ id: 'sample' }} />);
  void (
    <ButtonLink
      from="/manager/users/$id/"
      to="./update"
      params={{ id: 'sample' }}
    />
  );
  void (
    <ButtonLink
      to="/manager"
      ref={(anchor) => {
        anchor?.focus();
        return () => {};
      }}
    />
  );
  // @ts-expect-error The route requires id, not userId.
  void (<ButtonLink to="/manager/users/$id" params={{ userId: 'sample' }} />);
  // @ts-expect-error The relative destination must belong to this route.
  void (<ButtonLink from="/manager/users/$id/" to="./no-such-route" />);
  // @ts-expect-error The host ref points to an anchor, not a button.
  void (<ButtonLink to="/manager" ref={createRef<HTMLButtonElement>()} />);
});
