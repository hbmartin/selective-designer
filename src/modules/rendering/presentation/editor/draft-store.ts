import { createStore } from 'zustand/vanilla';

import type { Edit, EditSet } from '../../domain/edit-set';

const HISTORY_LIMIT = 100;

export type DraftStoreState = {
  editSet: EditSet;
  /** Server revision the local edit set is based on. */
  revision: number;
  past: EditSet[];
  future: EditSet[];
  /** Increments on every local change; autosave compares it with `savedVersion`. */
  version: number;
  savedVersion: number;
  selectedEditId: string | null;
  load: (draft: { editSet: EditSet; revision: number }) => void;
  apply: (update: (editSet: EditSet) => EditSet) => void;
  undo: () => void;
  redo: () => void;
  markSaved: (revision: number, version: number) => void;
  select: (editId: string | null) => void;
};

export type DraftStore = ReturnType<typeof createDraftStore>;

/** Local draft with undo/redo; one store per editor instance. */
export const createDraftStore = (initial: {
  editSet: EditSet;
  revision: number;
}) =>
  createStore<DraftStoreState>()((set, get) => ({
    editSet: initial.editSet,
    revision: initial.revision,
    past: [],
    future: [],
    version: 0,
    savedVersion: 0,
    selectedEditId: null,
    load: (draft) =>
      set((state) => ({
        editSet: draft.editSet,
        revision: draft.revision,
        past: [],
        future: [],
        version: state.version + 1,
        savedVersion: state.version + 1,
        selectedEditId: draft.editSet.edits.some(
          (e) => e.id === state.selectedEditId
        )
          ? state.selectedEditId
          : null,
      })),
    apply: (update) => {
      const current = get().editSet;
      const next = update(current);
      if (next === current) return;
      set((state) => ({
        editSet: next,
        past: [...state.past, current].slice(-HISTORY_LIMIT),
        future: [],
        version: state.version + 1,
      }));
    },
    undo: () => {
      const { past, editSet } = get();
      const previous = past.at(-1);
      if (!previous) return;
      set((state) => ({
        editSet: previous,
        past: past.slice(0, -1),
        future: [editSet, ...state.future],
        version: state.version + 1,
      }));
    },
    redo: () => {
      const { future, editSet } = get();
      const [next, ...rest] = future;
      if (!next) return;
      set((state) => ({
        editSet: next,
        past: [...state.past, editSet],
        future: rest,
        version: state.version + 1,
      }));
    },
    markSaved: (revision, version) =>
      set((state) => ({
        revision,
        savedVersion: Math.max(state.savedVersion, version),
      })),
    select: (editId) => set({ selectedEditId: editId }),
  }));

// ---- Pure edit-set helpers ---------------------------------------------

export const newEditId = () => `e_${crypto.randomUUID().slice(0, 8)}`;

export const addEdit =
  (edit: Edit) =>
  (editSet: EditSet): EditSet => ({
    ...editSet,
    edits: [...editSet.edits, edit],
  });

export const updateEdit =
  (editId: string, update: (edit: Edit) => Edit) =>
  (editSet: EditSet): EditSet => ({
    ...editSet,
    edits: editSet.edits.map((edit) =>
      edit.id === editId ? update(edit) : edit
    ),
  });

export const removeEdit =
  (editId: string) =>
  (editSet: EditSet): EditSet => ({
    ...editSet,
    edits: editSet.edits.filter((edit) => edit.id !== editId),
  });

export const setPrompt =
  (prompt: string) =>
  (editSet: EditSet): EditSet =>
    editSet.prompt === prompt ? editSet : { ...editSet, prompt };
