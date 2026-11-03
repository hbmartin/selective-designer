import { notFound } from '@tanstack/react-router';

import {
  toDesignId,
  toImageId,
  toRenderId,
  toScopeKey,
  toUserId,
} from '@/modules/kernel';

export const parseRouteDesignId = (value: string) => {
  const parsed = toDesignId(value);
  if (parsed.isError()) throw notFound();
  return parsed.get();
};

export const parseRouteImageId = (value: string) => {
  const parsed = toImageId(value);
  if (parsed.isError()) throw notFound();
  return parsed.get();
};

export const parseRouteRenderId = (value: string) => {
  const parsed = toRenderId(value);
  if (parsed.isError()) throw notFound();
  return parsed.get();
};

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
