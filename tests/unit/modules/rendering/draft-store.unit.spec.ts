import { describe, expect, it } from 'vitest';

import type { Edit } from '@/modules/rendering';
import {
  addEdit,
  createDraftStore,
  removeEdit,
  setPrompt,
  updateEdit,
} from '@/modules/rendering/testing';

const removal = (id: string): Edit => ({
  kind: 'removal',
  id,
  regionId: 'r1',
  note: '',
});

describe('draft store', () => {
  const fresh = () =>
    createDraftStore({ editSet: { edits: [], prompt: '' }, revision: 3 });

  it('applies changes, counting versions for autosave', () => {
    const store = fresh();
    store.getState().apply(addEdit(removal('a')));
    store.getState().apply(setPrompt('Dusk'));
    const state = store.getState();
    expect(state.editSet).toEqual({ edits: [removal('a')], prompt: 'Dusk' });
    expect(state.version).toBe(2);
    expect(state.savedVersion).toBe(0);
  });

  it('ignores no-op updates', () => {
    const store = fresh();
    store.getState().apply(setPrompt(''));
    expect(store.getState().version).toBe(0);
    expect(store.getState().past).toHaveLength(0);
  });

  it('undoes and redoes, and a new change clears redo', () => {
    const store = fresh();
    store.getState().apply(addEdit(removal('a')));
    store.getState().apply(addEdit(removal('b')));
    store.getState().undo();
    expect(store.getState().editSet.edits.map((e) => e.id)).toEqual(['a']);
    store.getState().redo();
    expect(store.getState().editSet.edits.map((e) => e.id)).toEqual(['a', 'b']);
    store.getState().undo();
    store.getState().apply(removeEdit('a'));
    expect(store.getState().future).toHaveLength(0);
    expect(store.getState().editSet.edits).toEqual([]);
  });

  it('records saves without losing newer local changes', () => {
    const store = fresh();
    store.getState().apply(addEdit(removal('a')));
    const savingVersion = store.getState().version;
    store.getState().apply(addEdit(removal('b')));
    store.getState().markSaved(4, savingVersion);
    expect(store.getState().revision).toBe(4);
    expect(store.getState().savedVersion).toBeLessThan(
      store.getState().version
    );
  });

  it('loads a stored draft (conflict) as saved, clearing history', () => {
    const store = fresh();
    store.getState().apply(addEdit(removal('a')));
    store.getState().select('a');
    store
      .getState()
      .load({ editSet: { edits: [removal('z')], prompt: 'x' }, revision: 9 });
    const state = store.getState();
    expect(state.revision).toBe(9);
    expect(state.past).toEqual([]);
    expect(state.version).toBe(state.savedVersion);
    expect(state.selectedEditId).toBeNull();
  });

  it('updates one edit in place', () => {
    const store = fresh();
    store.getState().apply(addEdit(removal('a')));
    store
      .getState()
      .apply(updateEdit('a', (edit) => ({ ...edit, note: 'carefully' })));
    expect(store.getState().editSet.edits[0]).toMatchObject({
      note: 'carefully',
    });
  });
});
