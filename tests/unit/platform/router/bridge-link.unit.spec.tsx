import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type LinkMockProps = Record<string, unknown> & {
  children?:
    | ReactNode
    | ((state: { isActive: boolean; isTransitioning: boolean }) => ReactNode);
};
type ForesightMockOptions = {
  callback: () => Promise<void> | void;
  enabled?: boolean;
  meta?: Record<string, unknown>;
  name?: string;
  reactivateAfter?: number;
};

const linkMocks = vi.hoisted(() => ({
  props: [] as LinkMockProps[],
}));
const foresightMocks = vi.hoisted(() => ({
  elementRef: vi.fn(),
  options: [] as ForesightMockOptions[],
}));
const routerMocks = vi.hoisted(() => ({
  preloadRoute: vi.fn(async () => []),
}));

vi.mock('@foresightjs/react', () => ({
  useForesight: (options: ForesightMockOptions) => {
    foresightMocks.options.push(options);
    return { elementRef: foresightMocks.elementRef };
  },
}));

vi.mock('@tanstack/react-router', () => ({
  Link: (props: LinkMockProps) => {
    linkMocks.props.push(props);
    return typeof props.children === 'function'
      ? props.children({ isActive: true, isTransitioning: false })
      : (props.children ?? null);
  },
  useRouter: () => routerMocks,
}));

import { BridgeLink } from '@/platform/router';

describe('BridgeLink', () => {
  beforeEach(() => {
    foresightMocks.elementRef.mockClear();
    foresightMocks.options = [];
    linkMocks.props = [];
    routerMocks.preloadRoute.mockClear();
  });

  it('uses Foresight to preload ordinary routes by default', async () => {
    const markup = renderToStaticMarkup(
      <BridgeLink to="/manager">Manager</BridgeLink>
    );

    expect(markup).toBe('Manager');
    expect(linkMocks.props).toHaveLength(1);
    expect(linkMocks.props[0]).toMatchObject({
      preload: false,
      to: '/manager',
    });
    expect(foresightMocks.options).toHaveLength(1);
    const foresightOptions = foresightMocks.options[0] as ForesightMockOptions;
    expect(foresightOptions).toMatchObject({
      enabled: true,
      meta: { to: '/manager' },
      name: 'BridgeLink /manager',
      reactivateAfter: 60_000,
    });

    await foresightOptions.callback();

    expect(routerMocks.preloadRoute).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/manager' })
    );
  });

  it('respects explicit TanStack preload props', () => {
    const markup = renderToStaticMarkup(
      <BridgeLink to="/login" preload="intent" data-testid="login-link">
        Login
      </BridgeLink>
    );

    expect(markup).toBe('Login');
    expect(linkMocks.props).toHaveLength(1);
    expect(linkMocks.props[0]).toMatchObject({
      'data-testid': 'login-link',
      preload: 'intent',
      to: '/login',
    });
    expect(foresightMocks.options).toHaveLength(1);
    expect(foresightMocks.options[0]).toMatchObject({ enabled: false });
  });

  it('supports TanStack Link render-prop children', () => {
    const markup = renderToStaticMarkup(
      <BridgeLink to="/manager">
        {({ isActive }) => createElement('span', null, isActive.toString())}
      </BridgeLink>
    );

    expect(markup).toBe('<span>true</span>');
  });

  it('throws for protected side-effect routes in test mode', () => {
    expect(() =>
      renderToStaticMarkup(<BridgeLink to="/logout">Logout</BridgeLink>)
    ).toThrow(
      'BridgeLink cannot navigate declaratively to protected side-effect route "/logout". Use an explicit command flow such as ConfirmSignOut instead.'
    );
    expect(foresightMocks.options).toHaveLength(1);
    expect(foresightMocks.options[0]).toMatchObject({ enabled: false });
    expect(linkMocks.props).toEqual([]);
  });

  it('throws for protected routes after resolving dot segments and relatives', () => {
    for (const props of [
      { to: '/app/../logout' },
      { from: '/app', to: '../logout' },
    ]) {
      expect(() =>
        renderToStaticMarkup(<BridgeLink {...props}>Logout</BridgeLink>)
      ).toThrow(/protected side-effect route "\/logout"/);
    }

    expect(linkMocks.props).toEqual([]);
  });

  it('does not resolve relative links against root when from is omitted', () => {
    expect(() =>
      renderToStaticMarkup(
        <BridgeLink to={'../logout' as never}>Relative logout</BridgeLink>
      )
    ).not.toThrow();

    expect(linkMocks.props).toHaveLength(1);
    expect(linkMocks.props[0]).toMatchObject({
      to: '../logout',
    });
  });

  it('does not allow explicit preloading to bypass a protected route block', () => {
    expect(() =>
      renderToStaticMarkup(
        <BridgeLink to="/logout" preload="intent">
          Logout
        </BridgeLink>
      )
    ).toThrow(/ConfirmSignOut/);
    expect(linkMocks.props).toEqual([]);
  });
});
