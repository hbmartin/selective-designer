import { Foresight } from '@foresightjs/react';
import {
  type AnyRouter,
  type CreateLinkProps,
  Link,
  type LinkComponentProps,
  type LinkProps,
  type ParsedLocation,
  type RegisteredRouter,
  useLocation,
  useRouter,
} from '@tanstack/react-router';
import type { Ref } from 'react';
import { useMergeRefs } from 'react-merge-refs';
import { omit, pick } from 'remeda';

import { SIDE_EFFECT_ROUTE_PATHNAMES } from './navigation-safety';

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

const protectedRoutePaths = new Set<string>(SIDE_EFFECT_ROUTE_PATHNAMES);

function matchProtectedRoute(router: AnyRouter, pathname: string) {
  const route = router.getMatchedRoutes(pathname)[2];
  return route && protectedRoutePaths.has(route.fullPath)
    ? route.fullPath
    : undefined;
}

function matchProtectedPublicHref(router: AnyRouter, href: string) {
  let url: URL;
  try {
    url = new URL(href, router.origin);
  } catch {
    return undefined;
  }
  if (url.origin !== router.origin) return undefined;

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
  props: RouterLinkProps
) {
  // A URL accepted without a base has a scheme and is handled directly by Link.
  if (typeof props.to === 'string' && URL.canParse(props.to)) {
    return {
      target: matchProtectedPublicHref(router, props.to),
      options: pick(props, preloadRouteOptionKeys),
      direct: true,
    };
  }

  const options = pick(props, preloadRouteOptionKeys);
  const next = router.buildLocation({ ...options, _fromLocation: location });
  const target =
    matchProtectedRoute(router, next.pathname) ??
    matchProtectedPublicHref(router, (next.maskedLocation ?? next).publicHref);

  // Use concrete destinations for both consumers. Link chooses its own
  // location during a route transition and could otherwise resolve a
  // relative path or inherited params against a different match.
  const resolvedOptions = {
    ...options,
    to: next.pathname,
    from: undefined,
    params: undefined,
    mask: next.maskedLocation
      ? {
          ...(options.mask ?? {
            search: next.maskedLocation.search,
            hash: next.maskedLocation.hash,
            state: next.maskedLocation.state,
            unmaskOnReload: next.maskedLocation.unmaskOnReload,
          }),
          to: next.maskedLocation.pathname,
          from: undefined,
          href: undefined,
          unsafeRelative: undefined,
          params: undefined,
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
  const location = useLocation();
  // The public generic props validate route inputs. Once inside the
  // adapter, the router resolves them to concrete paths.
  const routerProps = props as RouterLinkProps;
  if (hasUnsupportedDestination(props)) {
    if (!isProductionBuild()) {
      throw new Error(
        'BridgeLink does not support href or unsafeRelative. Use to and from to specify the destination.'
      );
    }
    return renderInertLink(routerProps);
  }

  const { target, options, direct } = resolveLink(
    router,
    location,
    routerProps
  );
  if (target) {
    if (!isProductionBuild()) {
      throw new Error(protectedNavigationErrorMessage(target));
    }
    return renderInertLink(routerProps);
  }

  const usePredictedPreload = !direct && shouldUsePredictedPreload(routerProps);
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
