import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, History, Merge, Scissors, Sparkles, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge, Dialog, DialogContent, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/primitives';
import { Field, Input, Textarea } from '@/components/ui/input';
import { ConfirmDialog, EmptyState, LoadingState } from '@/components/common/states';
import { storyApi, useAction, useSegments } from '@/lib/queries';
import { ApiError } from '@/lib/api';
import { formatDuration } from '@/lib/utils';
import type { StorySegment } from '@/lib/types';

const REWRITE_ACTIONS = [
  { action: 'regenerate', label: 'Regenerate' },
  { action: 'shorten', label: 'Shorten' },
  { action: 'expand', label: 'Expand' },
  { action: 'tone', label: 'Change tone…' },
  { action: 'translate', label: 'Translate…' },
];

const rewrite = async (seg: StorySegment, body: { action: string; tone?: string; language?: string }, mutate: (v: any) => Promise<unknown>) => {
  try {
    await mutate({ id: seg.id, body });
    toast.success(`${body.action} queued`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      if (window.confirm('This narration was edited by you — overwrite it?')) {
        await mutate({ id: seg.id, body: { ...body, force: true } });
        toast.success(`${body.action} queued`);
      }
    } else toast.error((e as Error).message);
  }
};

export const NarrationEditor = ({ projectId, language, mode, chapterId }: { projectId: string; language: string; mode: string; chapterId?: string }) => {
  const segments = useSegments(projectId, language, mode, chapterId);
  const [deleting, setDeleting] = useState<StorySegment | null>(null);
  const [historyFor, setHistoryFor] = useState<StorySegment | null>(null);

  const invalidate = () => segments.refetch();
  const update = useAction((v: { id: string; body: any }) => storyApi.updateSegment(v.id, v.body), { success: 'Narration saved', onSuccess: invalidate });
  const del = useAction((id: string) => storyApi.deleteSegment(id), { success: 'Segment deleted', onSuccess: invalidate });
  const merge = useAction((ids: string[]) => storyApi.mergeSegments(ids), { success: 'Segments merged', onSuccess: invalidate });
  const reorder = useAction((ids: string[]) => storyApi.reorderSegments(ids), { onSuccess: invalidate });
  const rewriteMut = useAction((v: { id: string; body: any }) => storyApi.rewriteSegment(v.id, v.body));
  const restore = useAction((v: { id: string; historyIndex: number }) => storyApi.restoreSegment(v.id, v.historyIndex), { success: 'Version restored', onSuccess: invalidate });

  const list = segments.data || [];
  const move = (seg: StorySegment, dir: -1 | 1) => {
    const i = list.findIndex((s) => s.id === seg.id);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const ids = list.map((s) => s.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorder.mutate(ids);
  };

  if (segments.isLoading) return <LoadingState label="Loading narration…" />;
  if (!list.length) return <EmptyState icon={Sparkles} title="No narration yet" description="Generate the story for this chapter, or select a chapter with narration." />;

  const totalDuration = list.reduce((n, s) => n + s.estimatedDuration, 0);

  return (
    <div className="space-y-2">
      <div className="rounded-md border border-line bg-panel px-3 py-1.5 text-xs text-muted">
        {list.length} segments · {list.reduce((n, s) => n + s.wordCount, 0)} words · ≈ {formatDuration(totalDuration)} narration
      </div>

      {list.map((s, i) => (
        <SegmentCard
          key={s.id}
          seg={s}
          first={i === 0}
          last={i === list.length - 1}
          onMove={(d) => move(s, d)}
          onSave={(body) => update.mutate({ id: s.id, body })}
          onDelete={() => setDeleting(s)}
          onMergeNext={i < list.length - 1 ? () => merge.mutate([s.id, list[i + 1].id]) : undefined}
          onRewrite={(body) => rewrite(s, body, (v) => rewriteMut.mutateAsync(v))}
          onHistory={() => setHistoryFor(s)}
          saving={update.isPending}
        />
      ))}

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={() => setDeleting(null)}
        title="Delete narration segment?"
        description="The scenes stay; only this narration is removed."
        confirmLabel="Delete"
        danger
        loading={del.isPending}
        onConfirm={() => del.mutate(deleting!.id, { onSuccess: () => setDeleting(null) })}
      />

      <Dialog open={!!historyFor} onOpenChange={() => setHistoryFor(null)}>
        <DialogContent title="Narration history" description="Restore a previous version of this segment.">
          <div className="max-h-96 space-y-2 overflow-y-auto">
            {(historyFor?.history || []).map((h) => (
              <div key={h.index} className="rounded border border-line bg-panel-2 p-2 text-xs">
                <div className="mb-1 flex items-center justify-between text-muted">
                  <span>{new Date(h.at).toLocaleString()} · {h.source}{h.note ? ` — ${h.note}` : ''}</span>
                  <Button size="xs" variant="ghost" onClick={() => restore.mutate({ id: historyFor!.id, historyIndex: h.index }, { onSuccess: () => setHistoryFor(null) })}>
                    Restore
                  </Button>
                </div>
                <p className="line-clamp-3 whitespace-pre-wrap text-fg/80">{h.narration}</p>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

const SegmentCard = ({
  seg,
  first,
  last,
  onMove,
  onSave,
  onDelete,
  onMergeNext,
  onRewrite,
  onHistory,
  saving,
}: {
  seg: StorySegment;
  first: boolean;
  last: boolean;
  onMove: (d: -1 | 1) => void;
  onSave: (body: { narration?: string; title?: string }) => void;
  onDelete: () => void;
  onMergeNext?: () => void;
  onRewrite: (body: { action: string; tone?: string; language?: string }) => void;
  onHistory: () => void;
  saving: boolean;
}) => {
  const [narration, setNarration] = useState(seg.narration);
  const [dirty, setDirty] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const [tone, setTone] = useState('');
  const [translateTo, setTranslateTo] = useState('');

  const splitAtCursor = () => {
    const at = area.current?.selectionStart ?? 0;
    if (!at || at >= narration.trim().length) {
      toast.error('Place the cursor where the narration should split');
      return;
    }
    storyApi
      .splitSegment(seg.id, { at })
      .then(() => toast.success('Segment split'))
      .catch((e) => toast.error(e.message));
  };

  return (
    <div className="rounded-md border border-line bg-panel p-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="flex size-5 items-center justify-center rounded bg-panel-3 text-[10px] font-bold text-muted">{seg.order}</span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{seg.title || `Segment ${seg.order}`}</span>
        <span className="text-[10px] text-muted">sc {seg.scenes.length} · {seg.wordCount}w · {formatDuration(seg.estimatedDuration)}</span>
        {seg.userEdited && <Badge tone="accent">edited</Badge>}
        {seg.uncertainties.length > 0 && <Badge tone="warn">uncertain</Badge>}
      </div>
      <Textarea
        ref={area}
        rows={Math.min(10, Math.max(3, Math.ceil(seg.narration.length / 90)))}
        value={narration}
        onChange={(e) => {
          setNarration(e.target.value);
          setDirty(true);
        }}
        className="text-xs leading-relaxed"
      />
      {seg.uncertainties.length > 0 && (
        <p className="mt-1 text-[10px] text-warn">⚠ {seg.uncertainties.join('; ')}</p>
      )}
      <div className="mt-1.5 flex items-center gap-1">
        <Button size="xs" variant="ghost" onClick={() => onMove(-1)} disabled={first}><ArrowUp /></Button>
        <Button size="xs" variant="ghost" onClick={() => onMove(1)} disabled={last}><ArrowDown /></Button>
        <Button size="xs" variant="ghost" onClick={splitAtCursor}><Scissors /> Split at cursor</Button>
        {onMergeNext && <Button size="xs" variant="ghost" onClick={onMergeNext}><Merge /> Merge next</Button>}
        <Button size="xs" variant="ghost" onClick={onHistory}><History /></Button>
        <Button size="xs" variant="ghost" onClick={onDelete}><Trash2 className="text-danger" /></Button>
        <span className="flex-1" />
        {dirty && (
          <Button size="xs" variant="primary" loading={saving} onClick={() => { onSave({ narration }); setDirty(false); }}>
            Save
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="xs" variant="outline"><Sparkles /> Rewrite <ChevronDown /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {REWRITE_ACTIONS.slice(0, 3).map((a) => (
              <DropdownMenuItem key={a.action} onClick={() => onRewrite({ action: a.action })}>{a.label}</DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <div className="px-2 py-1">
              <Field label="Tone">
                <div className="flex gap-1">
                  <Input value={tone} onChange={(e) => setTone(e.target.value)} placeholder="dramatic" className="h-6 w-24 text-[11px]" />
                  <Button size="xs" variant="ghost" disabled={!tone.trim()} onClick={() => onRewrite({ action: 'tone', tone })}>Apply</Button>
                </div>
              </Field>
              <Field label="Translate to">
                <div className="flex gap-1">
                  <Input value={translateTo} onChange={(e) => setTranslateTo(e.target.value)} placeholder="en / hi" className="h-6 w-24 text-[11px]" />
                  <Button size="xs" variant="ghost" disabled={!translateTo.trim()} onClick={() => onRewrite({ action: 'translate', language: translateTo })}>Apply</Button>
                </div>
              </Field>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
};
