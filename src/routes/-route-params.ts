import { notFound } from '@tanstack/react-router';

import { toScopeKey, toUserId } from '@/modules/kernel';

export const parseRouteUserId = (value: string) => {
  const parsed = toUserId(value);
  if (parsed.isError()) throw notFound();
  return parsed.get();
};

export const parseRouteScopeKey = (value: string) => {
  const parsed = toScopeKey(value);
  if (parsed.isError()) throw parsed.getError();
  return parsed.get();
};
