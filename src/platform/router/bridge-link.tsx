import { Foresight } from '@foresightjs/react';
import {
  type AnyRouter,
  type CreateLinkProps,
  Link,
  type LinkComponentProps,
  type LinkProps,
  type ParsedLocation,
  type RegisteredRouter,
  useRouter,
} from '@tanstack/react-router';
import { type Ref, useMemo } from 'react';
import { useMergeRefs } from 'react-merge-refs';
import { omit, pick } from 'remeda';

import { useBridgeLinkLocation } from './bridge-link-location';
import { isProtectedNavigationPath } from './navigation-safety';

type UnsupportedDestinationProps = {
  href?: never;
  unsafeRelative?: never;
};

export type BridgeLinkProps = LinkProps & UnsupportedDestinationProps;

const PREDICTED_PRELOAD_REACTIVATE_AFTER_MS = 60_000;

const protectedNavigationErrorMessage = (target: string) =>
  `BridgeLink cannot navigate declaratively to protected side-effect route "${target}". Use an explicit command flow such as ConfirmSignOut instead.`;

const isProductionBuild = () => import.meta.env?.PROD === true;

const hasUnsupportedDestination = (
  props: Pick<CreateLinkProps, 'href' | 'unsafeRelative'>
) => props.href !== undefined || props.unsafeRelative !== undefined;

function matchProtectedRoute(router: AnyRouter, pathname: string) {
  const [routes] = router.getMatchedRoutes(pathname);
  return routes.find((route) => isProtectedNavigationPath(route.fullPath))
    ?.fullPath;
}

function parseUrl(href: string, base?: string) {
  try {
    return new URL(href, base);
  } catch {
    return undefined;
  }
}

function matchProtectedPublicUrl(router: AnyRouter, url: URL | undefined) {
  if (!url || url.origin !== router.origin) return undefined;

  // Use fresh history state so a masked entry resolves as a document request.
  const location = router.parseLocation({
    href: url.pathname + url.search + url.hash,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    state: { __TSR_index: 0 },
  });
  return matchProtectedRoute(router, location.pathname);
}

const shouldUsePredictedPreload = (
  props: Pick<
    CreateLinkProps,
    'preload' | 'disabled' | 'reloadDocument' | 'target' | 'to'
  >
) =>
  props.preload === undefined &&
  props.disabled !== true &&
  props.reloadDocument !== true &&
  (props.target === undefined || props.target === '_self') &&
  typeof props.to === 'string' &&
  props.to.length > 0;

const preloadRouteOptionKeys = [
  'from',
  'hash',
  'hashScrollIntoView',
  'ignoreBlocker',
  'mask',
  'params',
  'reloadDocument',
  'replace',
  'resetScroll',
  'search',
  'state',
  'to',
  'viewTransition',
] as const;

type Destination = Pick<
  RouterLinkProps,
  'from' | 'hash' | 'mask' | 'params' | 'search' | 'state' | 'to'
>;

type RouterLinkProps = LinkComponentProps<
  'a',
  AnyRouter,
  string,
  string,
  string,
  string
>;

function resolveLink(
  router: AnyRouter,
  location: ParsedLocation,
  destination: Destination,
  historical: boolean
) {
  // A URL accepted without a base has a scheme and is handled directly by Link.
  const { to } = destination;
  const directUrl =
    typeof to === 'string' && to.includes(':') ? parseUrl(to) : undefined;
  if (directUrl) {
    return {
      target: matchProtectedPublicUrl(router, directUrl),
      options: destination,
      direct: true,
    };
  }

  const next = router.buildLocation({
    ...destination,
    _fromLocation: location,
  });
  const target =
    matchProtectedRoute(router, next.pathname) ??
    matchProtectedPublicUrl(
      router,
      parseUrl((next.maskedLocation ?? next).publicHref, router.origin)
    );

  // Use concrete destinations for both consumers. Link chooses its own
  // location during a route transition and could otherwise resolve a
  // relative path or inherited params against a different match.
  const maskOptions = destination.mask ?? next.maskedLocation;
  const { maskedLocation } = next;
  const resolvedOptions = {
    ...destination,
    to: next.pathname,
    from: undefined,
    params: undefined,
    // A freshly mounted native Link can inherit from the incoming location
    // even though BridgeLink still presents the departing route's location.
    search: historical ? next.search : destination.search,
    hash: historical ? next.hash : destination.hash,
    state: historical ? next.state : destination.state,
    mask: maskedLocation
      ? {
          to: maskedLocation.pathname,
          search: historical ? maskedLocation.search : maskOptions?.search,
          hash: historical ? maskedLocation.hash : maskOptions?.hash,
          state: historical ? maskedLocation.state : maskOptions?.state,
          unmaskOnReload: maskOptions?.unmaskOnReload,
        }
      : undefined,
  };
  return { target, options: resolvedOptions, direct: false };
}

const inertLinkOmissions = [
  ...preloadRouteOptionKeys,
  '_fromLocation',
  'href',
  'unsafeRelative',
  'startTransition',
  'activeProps',
  'inactiveProps',
  'activeOptions',
  'disabled',
  'preload',
  'preloadDelay',
  'preloadIntentProximity',
  'onClick',
  'onClickCapture',
  'onAuxClick',
  'onAuxClickCapture',
  'onKeyDown',
  'onKeyDownCapture',
  'onKeyUp',
  'onKeyUpCapture',
  'aria-current',
] as const;

function renderInertLink(props: RouterLinkProps) {
  return (
    <a
      {...omit(props, inertLinkOmissions)}
      role="link"
      aria-disabled="true"
      data-status={undefined}
    >
      {typeof props.children === 'function'
        ? props.children({ isActive: false })
        : props.children}
    </a>
  );
}

// Keep TanStack's render-prop children out of Foresight's state subscription.
function ForesightRouterLink({
  linkProps,
  ref,
}: {
  linkProps: RouterLinkProps;
  ref?: Ref<HTMLAnchorElement>;
}) {
  // Foresight's top-level ref merger discards callback ref cleanup functions.
  const anchorRef = useMergeRefs([ref, linkProps.ref]);
  return <Link {...linkProps} ref={anchorRef} />;
}

type SupportedLinkComponent = <
  TRouter extends AnyRouter = RegisteredRouter,
  const TFrom extends string = string,
  const TTo extends string | undefined = undefined,
  const TMaskFrom extends string = TFrom,
  const TMaskTo extends string = '',
>(
  props: LinkComponentProps<'a', TRouter, TFrom, TTo, TMaskFrom, TMaskTo> &
    UnsupportedDestinationProps
) => React.JSX.Element;

function BridgeLinkImpl<
  TRouter extends AnyRouter = RegisteredRouter,
  const TFrom extends string = string,
  const TTo extends string | undefined = undefined,
  const TMaskFrom extends string = TFrom,
  const TMaskTo extends string = '',
>(
  props: LinkComponentProps<'a', TRouter, TFrom, TTo, TMaskFrom, TMaskTo> &
    UnsupportedDestinationProps
) {
  const router = useRouter<AnyRouter>();
  const { location, historical } = useBridgeLinkLocation(router);
  // The public generic props validate route inputs. Once inside the
  // adapter, the router resolves them to concrete paths.
  const routerProps = props as RouterLinkProps;
  const { from, hash, mask, params, search, state, to } = routerProps;
  const unsupported = hasUnsupportedDestination(props);
  const resolved = useMemo(
    () =>
      unsupported
        ? undefined
        : resolveLink(
            router,
            location,
            { from, hash, mask, params, search, state, to },
            historical
          ),
    [
      from,
      hash,
      historical,
      location,
      mask,
      params,
      router,
      search,
      state,
      to,
      unsupported,
    ]
  );
  const {
    to: maskTo,
    search: maskSearch,
    hash: maskHash,
    state: maskState,
    unmaskOnReload,
  } = resolved?.options.mask ?? {};
  const resolvedMask = useMemo(
    () =>
      maskTo === undefined
        ? undefined
        : {
            to: maskTo,
            search: maskSearch,
            hash: maskHash,
            state: maskState,
            unmaskOnReload,
          },
    [maskHash, maskSearch, maskState, maskTo, unmaskOnReload]
  );
  if (!resolved) {
    if (!isProductionBuild()) {
      throw new Error(
        'BridgeLink does not support href or unsafeRelative. Use to and from to specify the destination.'
      );
    }
    return renderInertLink(routerProps);
  }

  const { target, direct } = resolved;
  if (target) {
    if (!isProductionBuild()) {
      throw new Error(protectedNavigationErrorMessage(target));
    }
    return renderInertLink(routerProps);
  }

  const usePredictedPreload = !direct && shouldUsePredictedPreload(routerProps);
  const options = {
    ...pick(routerProps, preloadRouteOptionKeys),
    ...resolved.options,
    mask: direct ? mask : resolvedMask,
  };
  const linkProps = {
    ...omit(routerProps, ['_fromLocation']),
    ...options,
    preload: usePredictedPreload ? (false as const) : props.preload,
  };
  return (
    <Foresight
      as={ForesightRouterLink}
      linkProps={linkProps}
      callback={() => {
        if (!usePredictedPreload) return;
        void router
          .preloadRoute({ ...options, _fromLocation: location })
          .catch(() => undefined);
      }}
      enabled={usePredictedPreload}
      meta={{ to: linkProps.to }}
      foresightName={
        typeof linkProps.to === 'string'
          ? `BridgeLink ${linkProps.to}`
          : 'BridgeLink'
      }
      reactivateAfter={PREDICTED_PRELOAD_REACTIVATE_AFTER_MS}
    />
  );
}

BridgeLinkImpl.displayName = 'BridgeLink';

export const BridgeLink = BridgeLinkImpl satisfies SupportedLinkComponent;
