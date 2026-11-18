import type { AnyRouter, ParsedLocation } from '@tanstack/react-router';
import { assert, expect, it, vi } from 'vitest';

import { createBridgeLinkLocationTracking } from '@/platform/router/bridge-link-location';

function createAtom<Value>(initial: Value) {
  let current = initial;
  const listeners = new Set<(value: Value) => void>();
  return {
    get: () => current,
    publish(value: Value) {
      current = value;
      listeners.forEach((listener) => listener(value));
    },
    subscribe(listener: (value: Value) => void) {
      listeners.add(listener);
      return { unsubscribe: () => listeners.delete(listener) };
    },
    listenerCount: () => listeners.size,
  };
}

function makeLocation(pathname: string): ParsedLocation {
  return {
    href: pathname,
    publicHref: pathname,
    pathname,
    search: {},
    searchStr: '',
    hash: '',
    state: { __TSR_index: 0 },
    external: false,
  };
}

function createRouterStores() {
  const initial = makeLocation('/initial');
  const location = createAtom(initial);
  const ids = createAtom<string[]>([]);
  const router = { stores: { location, ids } } as unknown as AnyRouter;
  return {
    router,
    initial,
    location,
    ids,
    navigate(next: ParsedLocation, routeId: string) {
      const departure = [undefined, undefined, next, [{ routeId }]];
      Object.assign(router, { _tx: departure });
      location.publish(next);
    },
  };
}

it('attaches a waiting subscriber to its route and retains the departure snapshot', () => {
  const { router, initial, ids, navigate } = createRouterStores();
  const tracking = createBridgeLinkLocationTracking();
  tracking.attach(router);
  const store = tracking.get(router);
  assert(store);

  const notify = vi.fn();
  const unsubscribe = store.subscribe('/route', notify);
  expect(store.getSnapshot('/route')).toBe(store.getSnapshot(undefined));
  const presented = makeLocation('/presented');
  navigate(presented, '/route');
  expect(notify).toHaveBeenCalledTimes(1);
  ids.publish(['/route']);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(store.getSnapshot('/route')).toEqual({
    location: presented,
    historical: false,
  });

  const incoming = makeLocation('/incoming');
  navigate(incoming, '/other');
  const retained = store.getSnapshot('/route');
  expect(retained).toEqual({ location: presented, historical: true });
  expect(notify).toHaveBeenCalledTimes(2);
  ids.publish(['/other']);
  navigate(initial, '/initial');
  expect(store.getSnapshot('/route')).toBe(retained);
  expect(notify).toHaveBeenCalledTimes(2);
  unsubscribe();
  expect(store.getSnapshot('/route')).toBe(store.getSnapshot(undefined));
});

it('reattaches surviving routers once on hot replacement with their presented snapshots', () => {
  const { router, initial, location, ids, navigate } = createRouterStores();
  const data = {};
  const dispose = vi.fn<(callback: (data: object) => void) => void>();
  const before = createBridgeLinkLocationTracking({ data, dispose });
  ids.publish(['/initial']);
  before.attach(router);
  before.attach(router);
  const previous = before.get(router);
  assert(previous);
  const notify = vi.fn();
  previous.subscribe('/initial', notify);

  navigate(makeLocation('/incoming'), '/other');
  expect(previous.getSnapshot('/initial')).toEqual({
    location: initial,
    historical: true,
  });
  const replacement = dispose.mock.calls[0]?.[0];
  assert(replacement);
  replacement(data);
  expect(location.listenerCount()).toBe(0);
  expect(ids.listenerCount()).toBe(0);

  const after = createBridgeLinkLocationTracking({ data, dispose });
  after.attach(router);
  expect(location.listenerCount()).toBe(1);
  expect(ids.listenerCount()).toBe(1);
  const restored = after.get(router);
  assert(restored);
  expect(restored.getSnapshot('/initial')).toEqual({
    location: initial,
    historical: true,
  });
  navigate(makeLocation('/later'), '/initial');
  expect(notify).toHaveBeenCalledTimes(1);
});
