export const compareModes = ['side', 'swipe', 'onion'] as const;
export type CompareMode = (typeof compareModes)[number];
