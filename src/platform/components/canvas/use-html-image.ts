import { useEffect, useState } from 'react';

export type HtmlImageState =
  | { status: 'loading'; image: null }
  | { status: 'loaded'; image: HTMLImageElement }
  | { status: 'failed'; image: null };

/**
 * Load an image for canvas use. `crossOrigin="anonymous"` keeps canvases
 * exportable (the bucket must send CORS headers for the app origin).
 */
export const useHtmlImage = (url: string | null): HtmlImageState => {
  const [state, setState] = useState<{
    url: string | null;
    result: HtmlImageState;
  }>({
    url: null,
    result: { status: 'loading', image: null },
  });
  useEffect(() => {
    if (!url) return;
    let active = true;
    const image = new window.Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      if (active) setState({ url, result: { status: 'loaded', image } });
    };
    image.onerror = () => {
      if (active) setState({ url, result: { status: 'failed', image: null } });
    };
    image.src = url;
    return () => {
      active = false;
    };
  }, [url]);
  return state.url === url ? state.result : { status: 'loading', image: null };
};
