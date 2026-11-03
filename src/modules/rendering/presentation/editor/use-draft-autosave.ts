import { useMutation } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useStore } from 'zustand';

import type { ImageId } from '@/modules/kernel/domain/ids';

import type { DraftStore } from './draft-store';
import { renderingQueries } from '../wired-queries';

const AUTOSAVE_DELAY_MS = 800;

/**
 * Debounced autosave against the draft revision. A conflict (another tab
 * saved first) replaces the local draft with the stored one.
 */
export const useDraftAutosave = (store: DraftStore, imageId: ImageId) => {
  const { t } = useTranslation(['rendering']);
  const version = useStore(store, (state) => state.version);
  const savedVersion = useStore(store, (state) => state.savedVersion);
  const { mutateAsync: saveDraft, isPending: isSaving } = useMutation(
    renderingQueries.saveDraft()
  );
  const inFlight = useRef<Promise<number> | null>(null);

  const saveNow = useCallback(async (): Promise<number> => {
    if (inFlight.current) await inFlight.current.catch(() => undefined);
    const state = store.getState();
    if (state.version === state.savedVersion) return state.revision;
    const attempt = (async () => {
      const savingVersion = state.version;
      const response = await saveDraft({
        imageId,
        editSet: state.editSet,
        revision: state.revision,
      });
      if (response.type === 'saved') {
        store.getState().markSaved(response.draft.revision, savingVersion);
        return response.draft.revision;
      }
      store.getState().load(response.draft);
      toast.info(t('rendering:editor.draftReloaded'));
      return response.draft.revision;
    })();
    inFlight.current = attempt;
    try {
      return await attempt;
    } finally {
      if (inFlight.current === attempt) inFlight.current = null;
    }
  }, [imageId, saveDraft, store, t]);

  useEffect(() => {
    if (version === savedVersion) return;
    const timer = window.setTimeout(() => {
      saveNow().catch(() => toast.error(t('rendering:editor.saveFailed')));
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [version, savedVersion, saveNow, t]);

  return {
    /** Save pending changes now and return the stored revision. */
    flush: saveNow,
    isSaving,
    isDirty: version !== savedVersion,
  };
};
