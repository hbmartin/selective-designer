import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { assert, expect, it, vi } from 'vitest';

import { BridgeLink } from '../../src/platform/router/bridge-link';

type LinkProps = {
  children: string;
  disabled?: boolean;
  preload?: false | 'intent';
  to: string;
};

type ForesightRegistration = {
  callback: () => void;
  enabled: boolean;
};

const mocks = vi.hoisted(() => ({
  links: vi.fn<(props: LinkProps) => string>((props) => props.children),
  register: vi.fn<(options: ForesightRegistration) => void>(),
  preloadRoute: vi.fn(async () => []),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: mocks.links,
  useRouter: () => ({ preloadRoute: mocks.preloadRoute }),
}));

vi.mock('@foresightjs/react', () => ({
  Foresight: ({
    as: Target,
    callback,
    enabled,
    linkProps,
  }: ForesightRegistration & {
    as: ComponentType<{ linkProps: LinkProps }>;
    linkProps: LinkProps;
  }) => {
    mocks.register({ callback, enabled });
    return <Target linkProps={linkProps} />;
  },
}));

it('disables protected navigation and preloading in production', () => {
  expect(process.env.NODE_ENV).toBe('production');
  expect(import.meta.env.PROD).toBe(true);

  const markup = renderToStaticMarkup(
    <BridgeLink to="/logout" preload="intent">
      Logout
    </BridgeLink>
  );

  expect(markup).toBe('Logout');
  expect(mocks.links).toHaveBeenCalledOnce();
  expect(mocks.links.mock.calls[0]?.[0]).toMatchObject({
    to: '/logout',
    disabled: true,
    preload: false,
  });
  expect(mocks.register).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ enabled: false })
  );
  const registration = mocks.register.mock.calls[0]?.[0];
  assert(registration);
  registration.callback();
  expect(mocks.preloadRoute).not.toHaveBeenCalled();
});
