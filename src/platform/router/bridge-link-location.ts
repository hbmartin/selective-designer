import {
  type AnyRouter,
  type ParsedLocation,
  useMatch,
} from '@tanstack/react-router';
import { _isRouteDeparting } from '@tanstack/router-core';
import { useCallback, useState, useSyncExternalStore } from 'react';

type RouteId = string | undefined;
type Listener = () => void;
type RouteScope = {
  location: ParsedLocation;
  listeners: Set<Listener>;
  presented: boolean;
};
type ReadableStore<Value> = {
  get: () => Value;
  subscribe?: (listener: (value: Value) => void) => unknown;
};

function createLocationStore(router: AnyRouter) {
  const location: ReadableStore<ParsedLocation> = router.stores.location;
  const ids: ReadableStore<string[]> = router.stores.ids;
  const scopes = new Map<string, RouteScope>();
  const outsideListeners = new Set<Listener>();
  let started = false;

  const publish = (next: ParsedLocation) => {
    for (const [routeId, scope] of scopes) {
      if (
        scope.presented &&
        scope.location !== next &&
        // TanStack's transaction matches are valid during this publication.
        !_isRouteDeparting(router, routeId, next)
      )
        updateScope(scope, next);
    }
    outsideListeners.forEach((listener) => listener());
  };

  const updateScope = (scope: RouteScope, next: ParsedLocation) => {
    if (scope.location === next) return;
    scope.location = next;
    scope.listeners.forEach((listener) => listener());
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
      const scope = scopes.get(routeId);
      if (!scope) {
        scopes.set(routeId, {
          location: location.get(),
          listeners: new Set(),
          presented: true,
        });
      } else if (!scope.presented) {
        scope.presented = true;
        updateScope(scope, location.get());
      }
    }
  };

  const start = () => {
    if (started || !location.subscribe || !ids.subscribe) return;
    started = true;
    updatePresentation(ids.get());
    // These subscriptions live on this router's atoms. Keep tracking between
    // link mounts so remounts can read every accepted location publication.
    location.subscribe(publish);
    ids.subscribe(updatePresentation);
  };

  return {
    start,
    getSnapshot: (routeId: RouteId) =>
      (routeId === undefined ? undefined : scopes.get(routeId)?.location) ??
      location.get(),
    getServerSnapshot: () => location.get(),
    subscribe(routeId: RouteId, listener: Listener) {
      start();
      if (routeId !== undefined) {
        const scope = scopes.get(routeId);
        if (scope) {
          scope.listeners.add(listener);
          return () => {
            scope.listeners.delete(listener);
            removeDepartedScope(routeId, scope);
          };
        }
      }
      outsideListeners.add(listener);
      return () => {
        outsideListeners.delete(listener);
      };
    },
  };
}

const locationStores = new WeakMap<
  AnyRouter,
  ReturnType<typeof createLocationStore>
>();

function getLocationStore(router: AnyRouter) {
  let store = locationStores.get(router);
  if (!store) {
    store = createLocationStore(router);
    locationStores.set(router, store);
  }
  return store;
}

export function attachBridgeLinkLocationTracking(router: AnyRouter) {
  getLocationStore(router).start();
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

  const { subscribe, getSnapshot, getServerSnapshot } =
    getLocationStore(router);
  return useSyncExternalStore(
    useCallback(
      (listener) => subscribe(scopeId, listener),
      [scopeId, subscribe]
    ),
    useCallback(() => getSnapshot(scopeId), [getSnapshot, scopeId]),
    getServerSnapshot
  );
}
