import { z } from 'zod';

/** Fractions of the image (0–1). */
export const zFractionalBox = () =>
  z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().min(0).max(1),
    height: z.number().min(0).max(1),
  });

export type FractionalBox = z.infer<ReturnType<typeof zFractionalBox>>;

const zId = () => z.string().trim().min(1).max(64);
const zNote = () => z.string().trim().max(500).prefault('');

/**
 * One requested change. Placements position an item; replacements assign an
 * item to a region; removals delete what a region shows; material changes
 * re-surface a region with a swatch or a written material.
 */
export const zEdit = () =>
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('placement'),
      id: zId(),
      itemId: zId(),
      /** Axis-aligned box of the placed item, before rotation. */
      box: zFractionalBox(),
      rotationDeg: z.number().min(-360).max(360).prefault(0),
      note: zNote(),
    }),
    z.object({
      kind: z.literal('replacement'),
      id: zId(),
      regionId: zId(),
      itemId: zId(),
      note: zNote(),
    }),
    z.object({
      kind: z.literal('removal'),
      id: zId(),
      regionId: zId(),
      note: zNote(),
    }),
    z.object({
      kind: z.literal('material'),
      id: zId(),
      regionId: zId(),
      swatchItemId: zId().nullish(),
      text: z.string().trim().max(200).prefault(''),
    }),
  ]);

export type Edit = z.infer<ReturnType<typeof zEdit>>;
export type EditKind = Edit['kind'];

export const MAX_EDITS = 20;
export const PROMPT_MAX_LENGTH = 2000;

export const zEditSet = () =>
  z.object({
    edits: z.array(zEdit()).max(MAX_EDITS),
    /** General instructions, e.g. lighting ("evening, sconces on"). */
    prompt: z.string().trim().max(PROMPT_MAX_LENGTH).prefault(''),
  });

export type EditSet = z.infer<ReturnType<typeof zEditSet>>;

export const isEmptyEditSet = (editSet: EditSet) =>
  editSet.edits.length === 0 && editSet.prompt.trim().length === 0;
