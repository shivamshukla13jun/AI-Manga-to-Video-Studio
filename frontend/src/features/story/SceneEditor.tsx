import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, History, Merge, MousePointerSquareDashed, Pencil, RefreshCw, Scissors, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge, Checkbox, Dialog, DialogContent, DialogFooter } from '@/components/ui/primitives';
import { Field, Input, Textarea } from '@/components/ui/input';
import { ConfirmDialog, EmptyState, LoadingState } from '@/components/common/states';
import { storyApi, useAction, useChapterImages, useChapterScenes } from '@/lib/queries';
import { ApiError } from '@/lib/api';
import type { BBox, Chapter, DetectedScene } from '@/lib/types';
import { SceneCanvas } from './SceneCanvas';

const SCENE_COLORS = ['#4f8ff7', '#f7954f', '#4fc46e', '#c05df2', '#f2c14e', '#e5534b', '#3bc2b9', '#9d7bff'];

/** Edit-lock helper: 409 -> ask for confirmation, resend with force. */
const withEditLock = async (fn: (force: boolean) => Promise<unknown>, what: string) => {
  try {
    return await fn(false);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      if (!window.confirm(`${what} — overwrite your manual edits?`)) return null;
      return await fn(true);
    }
    throw e;
  }
};

export const SceneEditor = ({ chapter, onChanged }: { chapter: Chapter; onChanged: () => void }) => {
  const scenes = useChapterScenes(chapter.id);
  const images = useChapterImages(chapter.id);
  const [selectedId, setSelectedId] = useState<string>();
  const [mergeSel, setMergeSel] = useState<Set<string>>(new Set());
  const [mergeMode, setMergeMode] = useState(false);
  const [drawMode, setDrawMode] = useState(false);
  const [editFields, setEditFields] = useState(false);
  const [deleting, setDeleting] = useState<DetectedScene | null>(null);
  const [pendingDraw, setPendingDraw] = useState<{ imageId: string; bbox: BBox } | null>(null);
  const [historyFor, setHistoryFor] = useState<DetectedScene | null>(null);

  const list = useMemo(() => scenes.data || [], [scenes.data]);
  useEffect(() => {
    if (list.length && !list.some((s) => s.id === selectedId)) setSelectedId(list[0].id);
  }, [list, selectedId]);

  const invalidate = () => {
    scenes.refetch();
    onChanged();
  };

  const update = useAction((v: { id: string; body: any }) => storyApi.updateScene(v.id, v.body), { onSuccess: invalidate });
  const create = useAction((v: any) => storyApi.createScene(chapter.id, v), { success: 'Scene created', onSuccess: invalidate });
  const split = useAction((v: { id: string; body: any }) => storyApi.splitScene(v.id, v.body), { success: 'Scene split', onSuccess: invalidate });
  const merge = useAction((ids: string[]) => storyApi.mergeScenes(ids), { success: 'Scenes merged', onSuccess: () => { setMergeSel(new Set()); setMergeMode(false); invalidate(); } });
  const del = useAction((id: string) => storyApi.deleteScene(id), { success: 'Scene deleted', onSuccess: invalidate });
  const reorder = useAction((ids: string[]) => storyApi.reorderScenes(chapter.id, ids), { onSuccess: invalidate });
  const regen = useAction((v: { id: string; force: boolean }) => storyApi.regenerateScene(v.id, v.force), { success: 'Regeneration queued' });
  const restore = useAction((v: { id: string; historyIndex: number }) => storyApi.restoreScene(v.id, v.historyIndex), { success: 'Version restored', onSuccess: invalidate });

  const move = (scene: DetectedScene, dir: -1 | 1) => {
    const i = list.findIndex((s) => s.id === scene.id);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const ids = list.map((s) => s.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorder.mutate(ids);
  };

  const changeRegion = (sceneId: string, regionIndex: number, bbox: BBox) => {
    const s = list.find((x) => x.id === sceneId);
    if (!s) return;
    const regions = s.regions.map((r, i) => (i === regionIndex ? { image: r.image, bbox, order: r.order } : { image: r.image, bbox: r.bbox, order: r.order }));
    update.mutate({ id: sceneId, body: { regions } });
  };

  const doSplit = (scene: DetectedScene) => {
    if (scene.regions.length > 1) {
      const at = Number(window.prompt(`Split between region 1..${scene.regions.length - 1}:`, '1'));
      if (!at || at < 1 || at >= scene.regions.length) return;
      split.mutate({ id: scene.id, body: { regionIndex: at } });
    } else {
      const atY = Number(window.prompt('Cut position inside the region (0-1):', '0.5'));
      if (!atY || atY <= 0 || atY >= 1) return;
      split.mutate({ id: scene.id, body: { atY } });
    }
  };

  if (scenes.isLoading || images.isLoading) return <LoadingState label="Loading scenes…" />;
  if (scenes.isError) return <EmptyState icon={X} title="Could not load scenes" description={(scenes.error as Error).message} />;

  return (
    <div className="flex gap-3">
      {/* page canvas */}
      <div className="min-w-0 flex-1 space-y-3">
        <div className="flex items-center gap-2 rounded-md border border-line bg-panel px-3 py-1.5 text-xs text-muted">
          <span>{list.length} scene{list.length === 1 ? '' : 's'} · {(images.data || []).length} pages</span>
          <span className="flex-1" />
          {drawMode && <span className="text-accent">Drag on a page to draw a new scene region</span>}
          <Button size="xs" variant={drawMode ? 'primary' : 'ghost'} onClick={() => setDrawMode((v) => !v)}>
            <MousePointerSquareDashed /> Add scene
          </Button>
          <Button size="xs" variant={mergeMode ? 'primary' : 'ghost'} onClick={() => { setMergeMode((v) => !v); setMergeSel(new Set()); }}>
            <Merge /> Merge
          </Button>
          {mergeMode && mergeSel.size >= 2 && (
            <Button size="xs" variant="primary" onClick={() => merge.mutate(list.filter((s) => mergeSel.has(s.id)).map((s) => s.id))} loading={merge.isPending}>
              Merge {mergeSel.size} scenes
            </Button>
          )}
        </div>

        {list.length === 0 && !drawMode ? (
          <EmptyState icon={Scissors} title="No scenes detected" description="Run scene detection, or draw a region on a page to create one manually." action={<Button size="sm" variant="primary" onClick={() => setDrawMode(true)}><MousePointerSquareDashed /> Draw a scene</Button>} />
        ) : (
          (images.data || []).map((img) => (
            <SceneCanvas
              key={img.id}
              image={img}
              scenes={list}
              selectedId={selectedId}
              editing={!mergeMode}
              drawMode={drawMode}
              onSelect={(id) => {
                if (mergeMode) {
                  setMergeSel((prev) => {
                    const next = new Set(prev);
                    next.has(id) ? next.delete(id) : next.add(id);
                    return next;
                  });
                } else setSelectedId(id);
              }}
              onChangeRegion={changeRegion}
              onDraw={(imageId, bbox) => setPendingDraw({ imageId, bbox })}
            />
          ))
        )}
      </div>

      {/* scene rail */}
      <div className="w-80 shrink-0 space-y-2">
        {mergeMode && <p className="rounded border border-line bg-panel-2 p-2 text-[11px] text-muted">Select scenes to merge. Only adjacent scenes can be merged.</p>}
        {list.map((s, i) => {
          const color = SCENE_COLORS[i % SCENE_COLORS.length];
          const sel = s.id === selectedId;
          return (
            <div
              key={s.id}
              className={`cursor-pointer rounded-md border p-2 ${sel ? 'border-accent bg-panel-3' : 'border-line bg-panel hover:bg-panel-2'}`}
              onClick={() => (mergeMode ? setMergeSel((prev) => { const n = new Set(prev); n.has(s.id) ? n.delete(s.id) : n.add(s.id); return n; }) : setSelectedId(s.id))}
            >
              <div className="flex items-center gap-2">
                {mergeMode && <Checkbox checked={mergeSel.has(s.id)} onCheckedChange={() => {}} />}
                <span className="flex size-5 items-center justify-center rounded text-[10px] font-bold text-black" style={{ background: color }}>
                  {s.order}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs font-medium">{s.title || `Scene ${s.order}`}</span>
                {s.userEdited && <Badge tone="accent">edited</Badge>}
                {s.confidence != null && s.confidence < 0.6 && <Badge tone="warn">low conf.</Badge>}
              </div>
              {s.description && <p className="mt-1 line-clamp-2 text-[11px] text-muted">{s.description}</p>}

              {sel && !mergeMode && (
                <div className="mt-2 space-y-2 border-t border-line pt-2" onClick={(e) => e.stopPropagation()}>
                  <div className="flex flex-wrap gap-1">
                    <Button size="xs" variant="ghost" onClick={() => move(s, -1)} disabled={i === 0}><ArrowUp /></Button>
                    <Button size="xs" variant="ghost" onClick={() => move(s, 1)} disabled={i === list.length - 1}><ArrowDown /></Button>
                    <Button size="xs" variant="ghost" onClick={() => doSplit(s)}><Scissors /> Split</Button>
                    <Button size="xs" variant="ghost" onClick={() => setEditFields((v) => !v)}><Pencil /> Fields</Button>
                    <Button size="xs" variant="ghost" onClick={() => setHistoryFor(s)}><History /></Button>
                    <Button size="xs" variant="ghost" onClick={() => withEditLock((f) => regen.mutateAsync({ id: s.id, force: f }).catch((e) => toast.error(e.message)), 'Regenerating will replace this scene').then(() => onChanged())}>
                      <RefreshCw /> Regen
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => setDeleting(s)}><Trash2 className="text-danger" /></Button>
                  </div>
                  <div className="text-[10px] text-muted">
                    {s.regions.length} region{s.regions.length === 1 ? '' : 's'} · {s.characters.join(', ') || 'no characters'} {s.emotion ? `· ${s.emotion}` : ''}
                  </div>

                  {editFields && (
                    <SceneFields scene={s} onSave={(body) => update.mutate({ id: s.id, body }, { onSuccess: () => setEditFields(false) })} saving={update.isPending} />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* confirm draw -> create */}
      <Dialog open={!!pendingDraw} onOpenChange={() => setPendingDraw(null)}>
        <DialogContent title="Create scene" description="Create a scene from the region you drew.">
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingDraw(null)}>Cancel</Button>
            <Button
              variant="primary"
              loading={create.isPending}
              onClick={() =>
                create.mutate(
                  { regions: [{ image: pendingDraw!.imageId, bbox: pendingDraw!.bbox }], title: `Scene ${list.length + 1}` },
                  { onSuccess: () => { setPendingDraw(null); setDrawMode(false); } }
                )
              }
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={() => setDeleting(null)}
        title={`Delete scene ${deleting?.order}?`}
        description="Narration segments pointing at this scene will drop the reference. Other scenes keep their order."
        confirmLabel="Delete"
        danger
        loading={del.isPending}
        onConfirm={() => del.mutate(deleting!.id, { onSuccess: () => setDeleting(null) })}
      />

      {/* version history */}
      <Dialog open={!!historyFor} onOpenChange={() => setHistoryFor(null)}>
        <DialogContent title={`Scene ${historyFor?.order} history`} description="Restore a previous version. AI regeneration never overwrites your edits without confirmation.">
          <div className="max-h-64 space-y-1 overflow-y-auto text-xs">
            {(historyFor?.history || []).map((h) => (
              <div key={h.index} className="flex items-center justify-between rounded border border-line bg-panel-2 px-2 py-1.5">
                <span className="text-muted">{new Date(h.at).toLocaleString()} · {h.source}{h.note ? ` — ${h.note}` : ''}</span>
                {h.hasData && (
                  <Button size="xs" variant="ghost" onClick={() => restore.mutate({ id: historyFor!.id, historyIndex: h.index }, { onSuccess: () => setHistoryFor(null) })}>
                    Restore
                  </Button>
                )}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

const SceneFields = ({ scene, onSave, saving }: { scene: DetectedScene; onSave: (body: any) => void; saving: boolean }) => {
  const [f, setF] = useState({
    title: scene.title || '',
    location: scene.location || '',
    action: scene.action || '',
    emotion: scene.emotion || '',
    description: scene.description || '',
    characters: scene.characters.join(', '),
  });
  return (
    <div className="space-y-1.5">
      <Field label="Title"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      <Field label="Location"><Input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></Field>
      <Field label="Characters (comma separated)"><Input value={f.characters} onChange={(e) => setF({ ...f, characters: e.target.value })} /></Field>
      <Field label="Action"><Input value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} /></Field>
      <Field label="Emotion"><Input value={f.emotion} onChange={(e) => setF({ ...f, emotion: e.target.value })} /></Field>
      <Field label="Description"><Textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <Button size="xs" variant="primary" loading={saving} onClick={() => onSave({ ...f, characters: f.characters.split(',').map((c) => c.trim()).filter(Boolean) })}>
        Save fields
      </Button>
    </div>
  );
};
