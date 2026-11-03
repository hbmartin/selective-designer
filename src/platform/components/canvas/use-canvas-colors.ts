import { useState } from 'react';

export type CanvasColors = {
  /** Selection and active outlines. */
  accent: string;
  /** Region highlights. */
  highlight: string;
  /** Removal and destructive marks. */
  danger: string;
  /** Text on top of the image. */
  label: string;
};

const FALLBACK: CanvasColors = {
  accent: 'dodgerblue',
  highlight: 'orange',
  danger: 'crimson',
  label: 'white',
};

const read = (style: CSSStyleDeclaration, name: string, fallback: string) =>
  style.getPropertyValue(name).trim() || fallback;

/**
 * Canvas drawing needs concrete color strings; read them from the design
 * tokens (custom properties resolve to concrete values when computed).
 */
export const useCanvasColors = (): CanvasColors => {
  const [colors] = useState(() => {
    if (typeof window === 'undefined') return FALLBACK;
    const style = window.getComputedStyle(document.documentElement);
    return {
      accent: read(style, '--chart-2', FALLBACK.accent),
      highlight: read(style, '--chart-1', FALLBACK.highlight),
      danger: read(style, '--destructive', FALLBACK.danger),
      label: read(style, '--background', FALLBACK.label),
    };
  });
  return colors;
};
