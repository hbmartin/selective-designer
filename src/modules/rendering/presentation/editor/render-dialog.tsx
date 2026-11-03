import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangleIcon, CheckIcon, MinusCircleIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Button } from '@/platform/components/ui/button';
import { Checkbox } from '@/platform/components/ui/checkbox';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/platform/components/ui/dialog';
import { Spinner } from '@/platform/components/ui/spinner';

import { useCurrentScopeKey } from '@/modules/auth/client';
import type { ImageId } from '@/modules/kernel/domain/ids';

import type { EditorItem } from './editor-types';
import { renderingQueries } from '../wired-queries';
import type { EditSet } from '../../domain/edit-set';
import { MODEL_CATALOG } from '../../domain/model-catalog';
import type { RecipeProblemResponse } from '../../transport/http/rendering-handlers';

const nativeSelectClass =
  'h-9 w-full rounded-md border border-input bg-background px-2 text-sm';

export const RenderDialog = (props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  imageId: ImageId;
  editSet: EditSet;
  items: ReadonlyMap<string, EditorItem>;
  /** Saves pending draft changes and returns the stored revision. */
  flush: () => Promise<number>;
  onSubmitted: (renderIds: string[]) => void;
}) => {
  const { t } = useTranslation(['rendering']);
  const scopeKey = useCurrentScopeKey();
  const queryClient = useQueryClient();
  const plan = useQuery({
    ...renderingQueries.plan({
      scopeKey,
      imageId: props.imageId,
      editSet: props.editSet,
    }),
    enabled: props.open,
    staleTime: 0,
  });
  const submit = useMutation(renderingQueries.submit());
  const submitBatch = useMutation(renderingQueries.submitBatch());
  const placements = props.editSet.edits.filter(
    (edit) => edit.kind === 'placement'
  );
  const [batchEditId, setBatchEditId] = useState<string>('');
  const [options, setOptions] = useState<string[]>([]);
  const placeable = [...props.items.values()].filter(
    (item) => item.kind !== 'swatch' && item.ready
  );

  const describeProblem = (response: RecipeProblemResponse) => {
    const { problem } = response;
    return t(`rendering:render.problem.${problem.type}`, {
      item: problem.type === 'item_not_ready' ? problem.itemName : '',
    });
  };

  const run = async () => {
    try {
      const revision = await props.flush();
      const response =
        batchEditId && options.length >= 2
          ? await submitBatch.mutateAsync({
              imageId: props.imageId,
              revision,
              placementEditId: batchEditId,
              optionItemIds: options,
            })
          : await submit.mutateAsync({ imageId: props.imageId, revision });
      if (response.type === 'submitted') {
        await queryClient.invalidateQueries({
          queryKey: renderingQueries.all(),
        });
        toast.success(t('rendering:render.submitted'));
        props.onOpenChange(false);
        props.onSubmitted(response.renderIds);
      } else if (response.type === 'draft_out_of_date') {
        toast.error(t('rendering:render.outOfDate'));
        await plan.refetch();
      } else if (response.type === 'no_models_can_render') {
        toast.error(t('rendering:render.noModels'));
      } else {
        toast.error(describeProblem(response));
      }
    } catch {
      toast.error(t('rendering:render.failed'));
    }
  };

  const response = plan.data;
  const itemName = (editId: string) => {
    const edit = props.editSet.edits.find((e) => e.id === editId);
    return edit && 'itemId' in edit
      ? (props.items.get(edit.itemId)?.name ?? '')
      : '';
  };
  const canRender =
    response?.type === 'plan' &&
    response.plan.models.some((model) => model.decision === 'include');
  const isBatch = Boolean(batchEditId) && options.length >= 2;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="render-dialog">
        <DialogHeader>
          <DialogTitle>{t('rendering:render.title')}</DialogTitle>
          <DialogDescription className="sr-only">
            {t('rendering:render.title')}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          {!response ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> {t('rendering:render.checking')}
            </p>
          ) : response.type === 'problem' ? (
            <p className="text-sm text-negative-600">
              {describeProblem(response)}
            </p>
          ) : (
            <>
              <ul
                className="flex flex-col gap-1"
                aria-label={t('rendering:render.title')}
              >
                {response.plan.models.map((model) => (
                  <li
                    key={model.modelId}
                    className="flex items-start gap-2 text-sm"
                    data-testid="plan-model"
                    data-decision={model.decision}
                  >
                    {model.decision === 'include' ? (
                      <CheckIcon className="mt-0.5 size-4 text-positive-600" />
                    ) : (
                      <MinusCircleIcon className="mt-0.5 size-4 text-muted-foreground" />
                    )}
                    <span className="flex flex-col">
                      <span className="font-medium">
                        {t(`rendering:models.${model.modelId}`)}{' '}
                        <span className="font-normal text-muted-foreground">
                          {model.decision === 'include'
                            ? t('rendering:render.willRender')
                            : t('rendering:render.skipped')}
                        </span>
                      </span>
                      {model.decision === 'skip' && (
                        <span className="text-xs text-muted-foreground">
                          {t('rendering:render.tooManyReferences', {
                            references: model.references,
                            limit: model.limit,
                          })}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              {response.plan.warnings.length > 0 && (
                <section className="flex flex-col gap-1 rounded-md border border-warning-300 bg-warning-50 p-2 text-xs">
                  <h3 className="flex items-center gap-1 font-medium">
                    <AlertTriangleIcon className="size-3.5" />
                    {t('rendering:render.smallItems')}
                  </h3>
                  {response.plan.warnings.map((warning) => (
                    <p key={`${warning.editId}-${warning.modelId}`}>
                      {t('rendering:render.smallItem', {
                        item: itemName(warning.editId),
                        width: warning.sizePx.width,
                        height: warning.sizePx.height,
                        model: MODEL_CATALOG[warning.modelId].displayName,
                        minWidth: warning.minPx.width,
                        minHeight: warning.minPx.height,
                      })}
                    </p>
                  ))}
                </section>
              )}
              {!canRender && (
                <p className="text-sm text-negative-600">
                  {t('rendering:render.noModels')}
                </p>
              )}
              {placements.length > 0 && placeable.length >= 2 && (
                <details className="rounded-md border p-2 text-sm">
                  <summary className="cursor-pointer font-medium">
                    {t('rendering:render.batch')}
                  </summary>
                  <div className="mt-2 flex flex-col gap-2">
                    <label className="flex flex-col gap-1">
                      <span className="text-xs text-muted-foreground">
                        {t('rendering:render.batchPlacement')}
                      </span>
                      <select
                        className={nativeSelectClass}
                        value={batchEditId}
                        onChange={(event) => {
                          setBatchEditId(event.target.value);
                          const edit = placements.find(
                            (p) => p.id === event.target.value
                          );
                          setOptions(edit ? [edit.itemId] : []);
                        }}
                      >
                        <option value="">—</option>
                        {placements.map((edit) => (
                          <option key={edit.id} value={edit.id}>
                            {props.items.get(edit.itemId)?.name ?? edit.itemId}
                          </option>
                        ))}
                      </select>
                    </label>
                    {batchEditId && (
                      <fieldset className="flex flex-col gap-1">
                        <legend className="text-xs text-muted-foreground">
                          {t('rendering:render.batchOptions')}
                        </legend>
                        {placeable.map((item) => (
                          <Checkbox
                            key={item.id}
                            checked={options.includes(item.id)}
                            onCheckedChange={(checked) =>
                              setOptions((current) =>
                                checked
                                  ? [...current, item.id].slice(0, 8)
                                  : current.filter((id) => id !== item.id)
                              )
                            }
                          >
                            {item.name}
                          </Checkbox>
                        ))}
                      </fieldset>
                    )}
                  </div>
                </details>
              )}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button
            onClick={run}
            disabled={!canRender}
            loading={submit.isPending || submitBatch.isPending}
            data-testid="render-submit"
          >
            {isBatch
              ? t('rendering:render.submitBatch', { count: options.length })
              : t('rendering:render.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
