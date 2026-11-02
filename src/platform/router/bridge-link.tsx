import { useForesight } from '@foresightjs/react';
import { Link, type LinkProps, useRouter } from '@tanstack/react-router';
import * as React from 'react';

import {
  isProtectedNavigationPath,
  localNavigationUrlBase,
  normalizeNavigationPathname,
} from './navigation-safety';

export type BridgeLinkProps = LinkProps;

const PREDICTED_PRELOAD_REACTIVATE_AFTER_MS = 60_000;

const protectedNavigationErrorMessage = (target: string) =>
  `BridgeLink cannot navigate declaratively to protected side-effect route "${target}". Use an explicit command flow such as ConfirmSignOut instead.`;

const isProductionBuild = () =>
  Boolean((import.meta as ImportMeta & { env?: { PROD?: boolean } }).env?.PROD);

const SCHEME_PATTERN = /^[A-Za-z][A-Za-z\d+.-]*:/;

const hasScheme = (value: string) => SCHEME_PATTERN.test(value);

const toDirectoryPath = (pathname: string) =>
  pathname.endsWith('/') ? pathname : `${pathname}/`;

const resolveNavigationPathname = (
  props: Pick<BridgeLinkProps, 'from' | 'to'>
) => {
  if (typeof props.to !== 'string') return undefined;
  if (props.to.startsWith('//') || hasScheme(props.to)) return undefined;

  try {
    if (!props.to.startsWith('/') && typeof props.from !== 'string') {
      return undefined;
    }

    const basePathname =
      typeof props.from === 'string'
        ? (normalizeNavigationPathname(props.from) ?? '/')
        : '/';
    return new URL(
      props.to,
      `${localNavigationUrlBase}${toDirectoryPath(basePathname)}`
    ).pathname;
  } catch {
    return undefined;
  }
};

const protectedNavigationTarget = (
  props: Pick<BridgeLinkProps, 'from' | 'to'>
) => {
  const pathname = resolveNavigationPathname(props);
  return pathname && isProtectedNavigationPath(pathname) ? pathname : undefined;
};

const shouldUsePredictedPreload = (
  props: BridgeLinkProps,
  protectedTarget: string | undefined
) =>
  protectedTarget === undefined &&
  props.preload === undefined &&
  props.disabled !== true &&
  props.reloadDocument !== true &&
  (props.target === undefined || props.target === '_self') &&
  typeof props.to === 'string' &&
  props.to.length > 0;

const toRouterPreloadOptions = ({
  _fromLocation,
  from,
  hash,
  hashScrollIntoView,
  ignoreBlocker,
  mask,
  params,
  reloadDocument,
  replace,
  resetScroll,
  search,
  state,
  to,
  viewTransition,
}: BridgeLinkProps) => ({
  _fromLocation,
  from,
  hash,
  hashScrollIntoView,
  ignoreBlocker,
  mask,
  params,
  reloadDocument,
  replace,
  resetScroll,
  search,
  state,
  to,
  viewTransition,
});

const assignForwardedRef = (
  forwardedRef: React.ForwardedRef<HTMLAnchorElement>,
  node: HTMLAnchorElement | null
) => {
  if (typeof forwardedRef === 'function') {
    forwardedRef(node);
    return;
  }

  if (forwardedRef) {
    forwardedRef.current = node;
  }
};

const BridgeLinkComponent = React.forwardRef<
  HTMLAnchorElement,
  BridgeLinkProps
>((props, forwardedRef) => {
  const router = useRouter();
  const protectedTarget = protectedNavigationTarget(props);
  const usePredictedPreload = shouldUsePredictedPreload(props, protectedTarget);
  const routePreloadOptions = toRouterPreloadOptions(props);
  const { elementRef } = useForesight<HTMLAnchorElement>({
    callback: () => {
      void router
        .preloadRoute(
          routePreloadOptions as Parameters<typeof router.preloadRoute>[0]
        )
        .catch(() => undefined);
    },
    enabled: usePredictedPreload,
    meta: { to: props.to },
    name:
      typeof props.to === 'string' ? `BridgeLink ${props.to}` : 'BridgeLink',
    reactivateAfter: PREDICTED_PRELOAD_REACTIVATE_AFTER_MS,
  });
  const linkRef = React.useCallback(
    (node: HTMLAnchorElement | null) => {
      elementRef(node);
      assignForwardedRef(forwardedRef, node);
    },
    [elementRef, forwardedRef]
  );

  if (!protectedTarget) {
    const linkProps = usePredictedPreload
      ? { ...props, preload: false as const }
      : props;

    return <Link {...linkProps} ref={linkRef} />;
  }

  const guardedProps = {
    ...props,
    disabled: true,
    preload: false as const,
  };

  if (!isProductionBuild()) {
    throw new Error(protectedNavigationErrorMessage(protectedTarget));
  }

  return <Link {...guardedProps} ref={linkRef} />;
});

BridgeLinkComponent.displayName = 'BridgeLink';

export const BridgeLink = BridgeLinkComponent as typeof Link;
