import { useState } from 'react';

/** Eager detection may still add regions for a while after an image arrives. */
const DETECTION_WINDOW_MS = 2 * 60 * 1000;
/** Keep polling until the region count has been stable this long. */
const SETTLE_MS = 15 * 1000;
const POLL_MS = 3000;

type RegionsQuery = { state: { data?: readonly unknown[] | undefined } };

/**
 * `refetchInterval` for region lists: detection saves concepts one by one,
 * so poll until the list stops growing (or the window ends).
 */
export const createRegionsPolling = (now: () => number) => {
  const startedAt = now();
  let last = { count: -1, changedAt: startedAt };
  return (query: RegionsQuery): number | false => {
    const time = now();
    const count = query.state.data?.length ?? -1;
    if (count !== last.count) last = { count, changedAt: time };
    if (time - startedAt > DETECTION_WINDOW_MS) return false;
    return count <= 0 || time - last.changedAt < SETTLE_MS ? POLL_MS : false;
  };
};

/** One polling policy per mounted list (independent of server clocks). */
export const useRegionsPolling = () => {
  const [polling] = useState(() => createRegionsPolling(Date.now));
  return polling;
};
