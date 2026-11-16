import { Foresight } from '@foresightjs/react';
import {
  type AnyRouter,
  type CreateLinkProps,
  Link,
  type LinkComponent,
  type LinkComponentProps,
  type LinkProps,
  type RegisteredRouter,
  useRouter,
} from '@tanstack/react-router';
import type { Ref } from 'react';
import { useMergeRefs } from 'react-merge-refs';

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
  props: Pick<CreateLinkProps, 'from' | 'to'>
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
  props: Pick<CreateLinkProps, 'from' | 'to'>
) => {
  const pathname = resolveNavigationPathname(props);
  return pathname && isProtectedNavigationPath(pathname) ? pathname : undefined;
};

const shouldUsePredictedPreload = (
  props: Pick<
    CreateLinkProps,
    'preload' | 'disabled' | 'reloadDocument' | 'target' | 'to'
  >,
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
}: Partial<Record<keyof CreateLinkProps, unknown>>) => ({
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

// Keep TanStack's render-prop children out of Foresight's state subscription.
function ForesightRouterLink<
  TRouter extends AnyRouter,
  TFrom extends string,
  TTo extends string | undefined,
  TMaskFrom extends string,
  TMaskTo extends string,
>({
  linkProps,
  ref,
}: {
  linkProps: LinkComponentProps<'a', TRouter, TFrom, TTo, TMaskFrom, TMaskTo>;
  ref?: Ref<HTMLAnchorElement>;
}) {
  // Foresight's top-level ref merger discards callback ref cleanup functions.
  const anchorRef = useMergeRefs([ref, linkProps.ref]);
  return (
    <Link<TRouter, TFrom, TTo, TMaskFrom, TMaskTo>
      {...Object.assign({}, linkProps, { ref: anchorRef })}
    />
  );
}

export const BridgeLink: LinkComponent<'a'> = function BridgeLink<
  TRouter extends AnyRouter = RegisteredRouter,
  const TFrom extends string = string,
  const TTo extends string | undefined = undefined,
  const TMaskFrom extends string = TFrom,
  const TMaskTo extends string = '',
>(props: LinkComponentProps<'a', TRouter, TFrom, TTo, TMaskFrom, TMaskTo>) {
  const router = useRouter();
  const protectedTarget = protectedNavigationTarget(props);
  const usePredictedPreload = shouldUsePredictedPreload(props, protectedTarget);
  if (protectedTarget && !isProductionBuild()) {
    throw new Error(protectedNavigationErrorMessage(protectedTarget));
  }

  const linkProps = Object.assign({}, props, {
    disabled: protectedTarget ? true : props.disabled,
    preload:
      usePredictedPreload || protectedTarget ? (false as const) : props.preload,
  });
  return (
    <Foresight
      as={ForesightRouterLink<TRouter, TFrom, TTo, TMaskFrom, TMaskTo>}
      linkProps={linkProps}
      callback={() => {
        void router
          .preloadRoute(
            toRouterPreloadOptions(props) as Parameters<
              typeof router.preloadRoute
            >[0]
          )
          .catch(() => undefined);
      }}
      enabled={usePredictedPreload}
      meta={{ to: props.to }}
      foresightName={
        typeof props.to === 'string' ? `BridgeLink ${props.to}` : 'BridgeLink'
      }
      reactivateAfter={PREDICTED_PRELOAD_REACTIVATE_AFTER_MS}
    />
  );
};
