import {
  type AnyRouter,
  type ParsedLocation,
  useMatch,
} from '@tanstack/react-router';
import { _isRouteDeparting } from '@tanstack/router-core';
import { useCallback, useState, useSyncExternalStore } from 'react';

type RouteId = string | undefined;
type Listener = () => void;
type LocationSnapshot = Readonly<{
  location: ParsedLocation;
  historical: boolean;
}>;
type RouteScope = {
  snapshot?: LocationSnapshot;
  listeners: Set<Listener>;
  presented: boolean;
};
type ReadableStore<Value> = {
  get: () => Value;
  subscribe?: (listener: (value: Value) => void) => { unsubscribe: Listener };
};

const liveSnapshots = new WeakMap<ParsedLocation, LocationSnapshot>();

function getLiveSnapshot(location: ParsedLocation): LocationSnapshot {
  const cached = liveSnapshots.get(location);
  if (cached) return cached;
  const snapshot = { location, historical: false };
  liveSnapshots.set(location, snapshot);
  return snapshot;
}

function createLocationStore(
  router: AnyRouter,
  retainedLocations?: ReadonlyMap<string, ParsedLocation>
) {
  const location: ReadableStore<ParsedLocation> = router.stores.location;
  const ids: ReadableStore<string[]> = router.stores.ids;
  const scopes = new Map<string, RouteScope>();
  const outsideListeners = new Set<Listener>();
  let live = getLiveSnapshot(location.get());

  if (!location.subscribe || !ids.subscribe) {
    throw new Error('BridgeLink requires subscribable client router stores.');
  }

  const getScope = (routeId: string) => {
    let scope = scopes.get(routeId);
    if (!scope) {
      scope = { listeners: new Set(), presented: false };
      scopes.set(routeId, scope);
    }
    return scope;
  };

  const updateScope = (
    scope: RouteScope,
    retained: ParsedLocation | undefined,
    previousLive = live
  ) => {
    const previous = scope.snapshot ?? previousLive;
    scope.snapshot =
      retained === undefined
        ? undefined
        : retained === live.location
          ? live
          : previous.location === retained && previous.historical
            ? previous
            : { location: retained, historical: true };
    if ((scope.snapshot ?? live) !== previous) {
      scope.listeners.forEach((listener) => listener());
    }
  };

  const removeDepartedScope = (routeId: string, scope: RouteScope) => {
    if (!scope.presented && scope.listeners.size === 0) scopes.delete(routeId);
  };

  const updatePresentation = (routeIds: string[]) => {
    const presented = new Set(routeIds);
    for (const [routeId, scope] of scopes) {
      if (presented.has(routeId)) continue;
      scope.presented = false;
      removeDepartedScope(routeId, scope);
    }
    for (const routeId of presented) {
      const scope = getScope(routeId);
      if (scope.presented) continue;
      scope.presented = true;
      updateScope(scope, live.location);
    }
  };

  for (const routeId of ids.get()) {
    const scope = getScope(routeId);
    scope.presented = true;
    updateScope(scope, retainedLocations?.get(routeId) ?? live.location);
  }

  const locationSubscription = location.subscribe((next) => {
    const previousLive = live;
    live = getLiveSnapshot(next);
    if (live === previousLive) return;
    for (const [routeId, scope] of scopes) {
      // TanStack's transaction matches are valid during this publication.
      const accepted =
        scope.presented && !_isRouteDeparting(router, routeId, next);
      updateScope(
        scope,
        accepted ? next : scope.snapshot?.location,
        previousLive
      );
    }
    outsideListeners.forEach((listener) => listener());
  });
  const presentationSubscription = ids.subscribe(updatePresentation);

  return {
    getSnapshot: (routeId: RouteId) =>
      (routeId === undefined ? undefined : scopes.get(routeId)?.snapshot) ??
      live,
    subscribe(routeId: RouteId, listener: Listener) {
      if (routeId === undefined) {
        outsideListeners.add(listener);
        return () => outsideListeners.delete(listener);
      }
      const scope = getScope(routeId);
      scope.listeners.add(listener);
      return () => {
        scope.listeners.delete(listener);
        removeDepartedScope(routeId, scope);
      };
    },
    dispose() {
      locationSubscription.unsubscribe();
      presentationSubscription.unsubscribe();
      const retained = new Map<string, ParsedLocation>();
      for (const [routeId, scope] of scopes) {
        if (scope.presented && scope.snapshot) {
          retained.set(routeId, scope.snapshot.location);
        }
        scope.listeners.clear();
      }
      scopes.clear();
      outsideListeners.clear();
      return retained;
    },
  };
}

type HotRouters = {
  router: WeakRef<AnyRouter>;
  locations: ReadonlyMap<string, ParsedLocation>;
}[];

// Keep one tracker per client router. Vite transfers only locations and weak
// references on replacement, so the new module installs fresh subscriptions.
export function createBridgeLinkLocationTracking(
  hot?: Pick<NonNullable<ImportMeta['hot']>, 'data' | 'dispose'>
) {
  const stores = new WeakMap<
    AnyRouter,
    ReturnType<typeof createLocationStore>
  >();
  const hotRouters = new Set<WeakRef<AnyRouter>>();

  function attach(
    router: AnyRouter,
    retainedLocations?: ReadonlyMap<string, ParsedLocation>
  ) {
    if (router.isServer || stores.has(router)) return;
    stores.set(router, createLocationStore(router, retainedLocations));
    if (hot) {
      for (const ref of hotRouters) {
        if (!ref.deref()) hotRouters.delete(ref);
      }
      hotRouters.add(new WeakRef(router));
    }
  }

  if (hot) {
    const restored = hot.data.bridgeLinkRouters as HotRouters | undefined;
    delete hot.data.bridgeLinkRouters;
    for (const { router, locations } of restored ?? []) {
      const survivingRouter = router.deref();
      if (survivingRouter) attach(survivingRouter, locations);
    }
    hot.dispose((data) => {
      const retained: HotRouters = [];
      for (const ref of hotRouters) {
        const router = ref.deref();
        const locations = router && stores.get(router)?.dispose();
        if (locations) retained.push({ router: ref, locations });
      }
      hotRouters.clear();
      data.bridgeLinkRouters = retained;
    });
  }

  return { attach, get: (router: AnyRouter) => stores.get(router) };
}

const tracking = createBridgeLinkLocationTracking(import.meta.hot);

export function attachBridgeLinkLocationTracking(router: AnyRouter) {
  tracking.attach(router);
}

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

  const store = tracking.get(router);
  if (!store && !router.isServer) {
    throw new Error(
      'Call attachBridgeLinkLocationTracking before using BridgeLink with a client router.'
    );
  }
  const getServerSnapshot = useCallback(
    () => getLiveSnapshot(router.stores.location.get()),
    [router]
  );

  return useSyncExternalStore(
    useCallback(
      (listener) => store?.subscribe(scopeId, listener) ?? (() => {}),
      [scopeId, store]
    ),
    useCallback(
      () => store?.getSnapshot(scopeId) ?? getServerSnapshot(),
      [getServerSnapshot, scopeId, store]
    ),
    getServerSnapshot
  );
}
