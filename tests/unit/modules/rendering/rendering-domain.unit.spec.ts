import { describe, expect, it } from 'vitest';

import {
  buildPrompt,
  enabledModels,
  fluxElementRows,
  MODEL_CATALOG,
  modelIds,
  parseSkipReason,
  planRender,
  type RenderRecipe,
  toFluxBox,
  zEditSet,
} from '@/modules/rendering';

const item = (
  n: number,
  kind: 'product' | 'extract' | 'swatch' = 'product'
) => ({
  itemId: `item-${n}`,
  itemVersionId: `version-${n}`,
  name: `Item ${n}`,
  kind,
  referenceKey: `item-cutouts/${n}.png`,
});

const region = {
  regionId: 'region-1',
  label: 'front door',
  maskKey: 'region-masks/1.png',
  box: { x: 0.4, y: 0.5, width: 0.1, height: 0.3 },
};

const recipe = (edits: RenderRecipe['edits'], prompt = ''): RenderRecipe => ({
  renderSourceImageId: 'base-1',
  source: { workingKey: 'working-images/b.png', width: 2000, height: 1000 },
  edits,
  prompt,
  editMaskKey: edits.length > 0 ? 'edit-masks/m.png' : null,
});

const placement = (
  n: number,
  box = { x: 0.1, y: 0.2, width: 0.2, height: 0.3 }
) => ({
  kind: 'placement' as const,
  id: `edit-${n}`,
  item: item(n),
  box,
  rotationDeg: 0,
  note: '',
});

describe('model catalog', () => {
  it('keeps configured order and drops unknown ids', () => {
    expect(
      enabledModels(['gpt-image-2', 'nope', 'krea-3']).map((m) => m.id)
    ).toEqual(['gpt-image-2', 'krea-3']);
  });

  it('describes every model', () => {
    for (const id of modelIds) expect(MODEL_CATALOG[id].id).toBe(id);
  });
});

describe('planRender', () => {
  const all = enabledModels(modelIds);

  it('includes every model for a small edit set', () => {
    const plan = planRender(recipe([placement(1)]), all);
    expect(plan.models.every((m) => m.decision === 'include')).toBe(true);
    expect(plan.warnings).toEqual([]);
  });

  it('skips Ideogram above three references with a mask, with the counts', () => {
    const plan = planRender(recipe([1, 2, 3, 4].map((n) => placement(n))), all);
    expect(plan.models.find((m) => m.modelId === 'ideogram-4-5')).toEqual({
      modelId: 'ideogram-4-5',
      decision: 'skip',
      reason: 'too_many_references',
      limit: 3,
      references: 4,
    });
    expect(plan.models.filter((m) => m.decision === 'include')).toHaveLength(3);
  });

  it('reserves one Krea input slot for the render source', () => {
    const krea = enabledModels(['krea-3']);
    expect(
      planRender(
        recipe(Array.from({ length: 7 }, (_, n) => placement(n))),
        krea
      ).models
    ).toEqual([{ modelId: 'krea-3', decision: 'include' }]);
    expect(
      planRender(
        recipe(Array.from({ length: 8 }, (_, n) => placement(n))),
        krea
      ).models
    ).toEqual([
      {
        modelId: 'krea-3',
        decision: 'skip',
        reason: 'too_many_references',
        limit: 7,
        references: 8,
      },
    ]);
  });

  it('skips models that cannot take ten references', () => {
    const plan = planRender(
      recipe([...Array(10).keys()].map((n) => placement(n))),
      all
    );
    expect(plan.models.map((m) => [m.modelId, m.decision])).toEqual([
      ['krea-3', 'skip'],
      ['flux-3-image', 'skip'],
      ['ideogram-4-5', 'skip'],
      ['gpt-image-2', 'include'],
    ]);
  });

  it('counts a reused item version once', () => {
    const plan = planRender(
      recipe([
        placement(1),
        { ...placement(1), id: 'edit-2' },
        placement(2),
        placement(3),
      ]),
      all
    );
    expect(plan.models.every((m) => m.decision === 'include')).toBe(true);
  });

  it('warns about placements smaller than a model can render reliably', () => {
    // 0.01 × 2000 = 20 px wide: below every model's minimum.
    const plan = planRender(
      recipe([placement(1, { x: 0.5, y: 0.5, width: 0.01, height: 0.1 })]),
      all
    );
    expect(plan.warnings.map((w) => w.modelId)).toEqual(modelIds);
    expect(plan.warnings[0]?.sizePx).toEqual({ width: 20, height: 100 });
  });
});

describe('FLUX 3 targeting', () => {
  it('maps fractional boxes to [top, left, bottom, right] on a 0–1000 grid', () => {
    expect(toFluxBox({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 })).toEqual([
      200, 100, 600, 400,
    ]);
    expect(toFluxBox({ x: 0.9, y: 0.9, width: 0.5, height: 0.5 })).toEqual([
      900, 900, 1000, 1000,
    ]);
  });

  it('marks removals as source boxes and additions as target boxes', () => {
    expect(
      fluxElementRows(
        recipe([
          placement(1),
          { kind: 'removal', id: 'edit-2', region, note: '' },
        ])
      )
    ).toEqual([
      {
        id: 'edit_1',
        from: null,
        src_bbox: null,
        tgt_bbox: [200, 100, 500, 300],
        desc: 'Item 1',
      },
      {
        id: 'edit_2',
        from: 'ref_image_0',
        src_bbox: [500, 400, 800, 500],
        tgt_bbox: null,
        desc: 'front door to remove',
      },
    ]);
  });

  it('builds the golden FLUX prompt', () => {
    expect(
      buildPrompt(recipe([placement(1)], 'Warm evening light.'), 'flux-3-image')
    ).toBe(
      [
        'Edit <ref_image_0>.',
        'Place "Item 1" (<ref_image_1>) in <edit_1>, sized to fill it.',
        'Warm evening light.',
        'Keep everything outside the target areas unchanged: the same camera, framing, geometry, lighting and materials.',
        'Reproduce each referenced product faithfully: silhouette, proportions, distinctive details and finish. Perspective, scene lighting, shadows and reflections may adapt to the scene.',
      ].join('\n') +
        ' [{"id":"edit_1","from":null,"src_bbox":null,"tgt_bbox":[200,100,500,300],"desc":"Item 1"}]'
    );
  });
});

describe('prompts for other models', () => {
  const edits = recipe([
    { ...placement(1), rotationDeg: 30, note: 'Facing the camera.' },
    { kind: 'replacement', id: 'edit-2', item: item(2), region, note: '' },
    {
      kind: 'material',
      id: 'edit-3',
      region,
      swatch: item(3, 'swatch'),
      text: '',
    },
  ]);

  it('names Krea references after the source image and areas as @editN', () => {
    const prompt = buildPrompt(edits, 'krea-3');
    expect(prompt).toContain(
      'Place "Item 1" (<image-2>) in @edit1, rotated 30°, sized to fill it. Facing the camera.'
    );
    expect(prompt).toContain(
      'Replace the front door in @edit2 with "Item 2" (<image-3>).'
    );
    expect(prompt).toContain('to the material in <image-4> ("Item 3")');
  });

  it('refers to the masked area for mask models', () => {
    const prompt = buildPrompt(edits, 'gpt-image-2');
    expect(prompt).toContain('in the masked area');
    expect(prompt).toContain('(reference image 1)');
    expect(prompt).not.toContain('<edit_');
  });

  it('omits fidelity text when only swatches are referenced', () => {
    const prompt = buildPrompt(
      recipe([
        {
          kind: 'material',
          id: 'e',
          region,
          swatch: item(3, 'swatch'),
          text: '',
        },
      ]),
      'gpt-image-2'
    );
    expect(prompt).not.toContain('Reproduce each referenced product');
  });

  it('describes written materials without a swatch', () => {
    const prompt = buildPrompt(
      recipe([
        { kind: 'material', id: 'e', region, swatch: null, text: 'white oak' },
      ]),
      'ideogram-4-5'
    );
    expect(prompt).toContain(
      'Change the surface of the front door in the masked area to white oak'
    );
  });
});

describe('edit sets', () => {
  it('accepts the four edit kinds and defaults rotation', () => {
    const parsed = zEditSet().parse({
      prompt: '',
      edits: [
        {
          kind: 'placement',
          id: 'a',
          itemId: 'i',
          box: { x: 0, y: 0, width: 0.5, height: 0.5 },
        },
        { kind: 'replacement', id: 'b', regionId: 'r', itemId: 'i' },
        { kind: 'removal', id: 'c', regionId: 'r' },
        { kind: 'material', id: 'd', regionId: 'r', text: 'brick' },
      ],
    });
    expect(parsed.edits[0]).toMatchObject({ rotationDeg: 0 });
  });

  it('rejects box values outside 0–1', () => {
    expect(
      zEditSet().safeParse({
        prompt: '',
        edits: [
          {
            kind: 'placement',
            id: 'a',
            itemId: 'i',
            box: { x: -0.1, y: 0, width: 1.5, height: 0.5 },
          },
        ],
      }).success
    ).toBe(false);
  });
});

describe('skip reasons', () => {
  it('parses stored reasons', () => {
    expect(parseSkipReason('too_many_references:4/3')).toEqual({
      reason: 'too_many_references',
      references: 4,
      limit: 3,
    });
    expect(parseSkipReason('other')).toEqual({
      reason: 'other',
      references: null,
      limit: null,
    });
  });
});
