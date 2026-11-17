import {
  type AnyRouter,
  type ParsedLocation,
  useMatch,
} from '@tanstack/react-router';
import { useCallback, useState, useSyncExternalStore } from 'react';

type RouteId = string | undefined;
type Listener = () => void;
type RouteScope = { location: ParsedLocation; listeners: Set<Listener> };
type LocationStore = AnyRouter['stores']['location'] & {
  subscribe?: (listener: (location: ParsedLocation) => void) => {
    unsubscribe: Listener;
  };
};

function createLocationStore(router: AnyRouter) {
  // The React router supplies a subscribable atom on the client. The core
  // store type also covers SSR, where the location is a plain snapshot.
  const location: LocationStore = router.stores.location;
  const { status } = router.stores;
  const scopes = new Map<RouteId, RouteScope>();
  let unsubscribe: (() => void) | undefined;

  // TanStack publishes the incoming location before replacing the rendered
  // route. Observe each publication even if React batches the rerenders.
  const publish = (next: ParsedLocation) => {
    const retainedRoutes =
      status.get() === 'pending'
        ? new Set(
            router.getMatchedRoutes(next.pathname)[0].map((route) => route.id)
          )
        : undefined;
    for (const [routeId, scope] of scopes) {
      if (
        routeId !== undefined &&
        retainedRoutes &&
        !retainedRoutes.has(routeId)
      )
        continue;
      if (scope.location === next) continue;
      scope.location = next;
      scope.listeners.forEach((listener) => listener());
    }
  };

  return {
    getSnapshot: (routeId: RouteId) =>
      scopes.get(routeId)?.location ?? location.get(),
    getServerSnapshot: () => location.get(),
    subscribe(routeId: RouteId, listener: Listener) {
      let scope = scopes.get(routeId);
      if (!scope) {
        scope = { location: location.get(), listeners: new Set() };
        scopes.set(routeId, scope);
      }
      const { listeners } = scope;
      listeners.add(listener);
      unsubscribe ??= location.subscribe?.(publish).unsubscribe;

      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) scopes.delete(routeId);
        if (scopes.size === 0) {
          unsubscribe?.();
          unsubscribe = undefined;
        }
      };
    },
  };
}

const locationStores = new WeakMap<
  AnyRouter,
  ReturnType<typeof createLocationStore>
>();

export function useBridgeLinkLocation(router: AnyRouter) {
  const routeId = useMatch({
    strict: false,
    shouldThrow: false,
    select: (match) => match.routeId,
  });
  const [previousMatch, setPreviousMatch] = useState({ router, routeId });
  if (
    previousMatch.router !== router ||
    (routeId !== undefined && routeId !== previousMatch.routeId)
  ) {
    setPreviousMatch({ router, routeId });
  }
  // The presented match store clears before a departing link unmounts.
  const scopeId =
    routeId ??
    (previousMatch.router === router ? previousMatch.routeId : undefined);

  let store = locationStores.get(router);
  if (!store) {
    store = createLocationStore(router);
    locationStores.set(router, store);
  }
  const { subscribe, getSnapshot, getServerSnapshot } = store;
  return useSyncExternalStore(
    useCallback(
      (listener) => subscribe(scopeId, listener),
      [scopeId, subscribe]
    ),
    useCallback(() => getSnapshot(scopeId), [getSnapshot, scopeId]),
    getServerSnapshot
  );
}
