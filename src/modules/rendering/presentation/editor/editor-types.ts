import type { FractionalBox } from '../../domain/edit-set';

/** A mood-board item as the editor needs it (supplied by the composer). */
export type EditorItem = {
  id: string;
  name: string;
  kind: 'product' | 'extract' | 'swatch';
  category: string;
  /** Cut-out for products/extracts, photo for swatches. */
  imageUrl: string;
  imageSize: { width: number; height: number } | null;
  ready: boolean;
};

/** A region on the render source (supplied by the composer). */
export type EditorRegion = {
  id: string;
  label: string;
  box: FractionalBox;
  isSuggestion: boolean;
};

export type EditorTool = 'select' | 'click' | 'lasso' | 'brush';

export type FractionalPoint = { x: number; y: number };

export const ITEM_DRAG_TYPE = 'application/x-selective-designer-item';
