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

import { BackButton } from '@/platform/components/back-button';
import { ButtonLink } from '@/platform/components/ui/button-link';
import { ResponsiveIconButtonLink } from '@/platform/components/ui/responsive-icon-button-link';

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
  // @ts-expect-error The destination is not in the registered route tree.
  void (<ButtonLink to="/no-such-route" />);
  // @ts-expect-error The selected route requires an id.
  void (<ButtonLink to="/manager/users/$id" />);
  // @ts-expect-error href cannot replace the checked destination.
  void (<ButtonLink to="/app" href="/logout" />);
  // @ts-expect-error Unsafe relative resolution is outside this API.
  void (<ButtonLink to="/app" unsafeRelative="path" />);
  void (
    <ButtonLink
      to="/manager/users/$id"
      params={{ id: 'sample' }}
      mask={{ to: '/manager' }}
      ref={createRef<HTMLAnchorElement>()}
    >
      {({ isActive }) => String(isActive)}
    </ButtonLink>
  );
  // @ts-expect-error Mask destinations must also be registered routes.
  void (<ButtonLink to="/manager" mask={{ to: '/no-such-route' }} />);
});

it('preserves route inference through the responsive wrapper', () => {
  void (
    <ResponsiveIconButtonLink
      label="User"
      to="/manager/users/$id"
      params={{ id: 'sample' }}
      ref={createRef<HTMLAnchorElement>()}
    />
  );
  void (
    <ResponsiveIconButtonLink
      label="Edit"
      from="/manager/users/$id/"
      to="./update"
      params={{ id: 'sample' }}
      mask={{ to: '/manager' }}
    >
      {({ isActive }) => String(isActive)}
    </ResponsiveIconButtonLink>
  );
  // @ts-expect-error The destination is not a registered route.
  void (<ResponsiveIconButtonLink label="Bad" to="/no-such-route" />);
  // @ts-expect-error This route requires an id.
  void (<ResponsiveIconButtonLink label="Bad" to="/manager/users/$id" />);
  void (
    <ResponsiveIconButtonLink
      label="Bad"
      to="/manager/users/$id"
      // @ts-expect-error The id parameter cannot be replaced with userId.
      params={{ userId: 'sample' }}
    />
  );
  void (
    <ResponsiveIconButtonLink
      label="Bad"
      from="/manager/users/$id/"
      // @ts-expect-error The relative route does not exist.
      to="./no-such-route"
    />
  );
  void (
    <ResponsiveIconButtonLink
      label="Bad"
      to="/manager"
      // @ts-expect-error A responsive link exposes an anchor ref.
      ref={createRef<HTMLButtonElement>()}
    />
  );
  // @ts-expect-error href must not override the typed destination.
  void (<ResponsiveIconButtonLink label="Bad" to="/app" href="/logout" />);
  void (
    <ResponsiveIconButtonLink
      label="Bad"
      to="/app"
      // @ts-expect-error Unsafe relative destinations are excluded.
      unsafeRelative="path"
    />
  );
  void (
    <ResponsiveIconButtonLink
      label="Bad"
      to="/manager"
      // @ts-expect-error The mask route does not exist.
      mask={{ to: '/no-such-route' }}
    />
  );
});

it('preserves route inference and the optional fallback through BackButton', () => {
  void (<BackButton />);
  void (
    <BackButton
      to="/manager/users/$id"
      params={{ id: 'sample' }}
      ref={createRef<HTMLAnchorElement>()}
    >
      {({ isActive }) => String(isActive)}
    </BackButton>
  );
  void (
    <BackButton
      from="/manager/users/$id/"
      to="./update"
      params={{ id: 'sample' }}
      mask={{ to: '/manager' }}
    />
  );
  // @ts-expect-error The fallback must be a registered destination.
  void (<BackButton to="/no-such-route" />);
  // @ts-expect-error The selected fallback requires an id.
  void (<BackButton to="/manager/users/$id" />);
  // @ts-expect-error The selected fallback requires id, not userId.
  void (<BackButton to="/manager/users/$id" params={{ userId: 'sample' }} />);
  // @ts-expect-error The relative fallback does not exist.
  void (<BackButton from="/manager/users/$id/" to="./no-such-route" />);
  // @ts-expect-error The ref points to an anchor.
  void (<BackButton to="/manager" ref={createRef<HTMLButtonElement>()} />);
  // @ts-expect-error href must not replace the fallback destination.
  void (<BackButton to="/app" href="/logout" />);
  // @ts-expect-error Unsafe relative destinations are excluded.
  void (<BackButton to="/app" unsafeRelative="path" />);
  // @ts-expect-error The mask must be a registered route.
  void (<BackButton to="/manager" mask={{ to: '/no-such-route' }} />);
});
