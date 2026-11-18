import { useEffect, useRef, useState } from 'react';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Eye, GripVertical, Layers, MoreHorizontal, RefreshCw, Replace, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Tooltip } from '@/components/ui/primitives';
import { ConfirmDialog, EmptyState, JobInline } from '@/components/common/states';
import { api } from '@/lib/api';
import { useAction } from '@/lib/queries';
import { useUploads } from '@/stores/uploads';
import { formatBytes } from '@/lib/utils';
import type { Chapter } from '@/lib/types';

const STATUS_TONE = { uploaded: 'neutral', extracting: 'accent', ready: 'ok', failed: 'danger' } as const;

const InlineEdit = ({ value, onSave, type = 'text', className }: { value: string | number; onSave: (v: string) => void; type?: string; className?: string }) => {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(String(value));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => setV(String(value)), [value]);
  useEffect(() => {
    if (editing) ref.current?.select();
  }, [editing]);
  if (!editing)
    return (
      <button className={`rounded px-1 text-left hover:bg-panel-3 ${className}`} onClick={() => setEditing(true)} title="Click to edit">
        {value}
      </button>
    );
  const commit = () => {
    setEditing(false);
    if (v.trim() && v !== String(value)) onSave(v.trim());
    else setV(String(value));
  };
  return (
    <Input
      ref={ref}
      type={type}
      step="any"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          setV(String(value));
          setEditing(false);
        }
      }}
      className={`h-6 ${className}`}
    />
  );
};

const Row = ({ c, onView, onDelete }: { c: Chapter; onView: (c: Chapter) => void; onDelete: (c: Chapter) => void }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: c.id });
  const qc = useQueryClient();
  const replaceInput = useRef<HTMLInputElement>(null);
  const addUploads = useUploads((s) => s.add);
  const update = useAction((body: Partial<Chapter>) => api.put(`/api/manga/chapters/${c.id}`, body), {
    invalidate: [['chapters', c.project]],
  });
  const reextract = useAction(() => api.post(`/api/manga/chapters/${c.id}/extract`), {
    success: 'Re-extraction queued',
    onSuccess: () => qc.invalidateQueries({ queryKey: ['chapters', c.project] }),
  });
  const runningJob = c.job && ['queued', 'active', 'retrying'].includes(c.job.status) ? c.job : undefined;

  return (
    <tr
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`border-b border-line text-xs ${isDragging ? 'relative z-10 bg-panel-3 shadow-lg' : 'hover:bg-panel-2'}`}
    >
      <td className="w-6 pl-2">
        <button {...attributes} {...listeners} className="cursor-grab p-1 text-dim hover:text-fg active:cursor-grabbing" aria-label="Drag to reorder">
          <GripVertical className="size-3.5" />
        </button>
      </td>
      <td className="w-20 py-2">
        <InlineEdit value={c.number} type="number" className="w-16 font-mono" onSave={(v) => update.mutate({ number: Number(v) })} />
      </td>
      <td className="py-2">
        <InlineEdit value={c.title} className="w-full max-w-72" onSave={(v) => update.mutate({ title: v })} />
      </td>
      <td className="max-w-48 truncate py-2 text-muted" title={c.archive?.fileName}>
        {c.archive?.fileName || '—'}
      </td>
      <td className="py-2 text-right font-mono text-muted">{formatBytes(c.archive?.size)}</td>
      <td className="py-2 text-right font-mono">{c.imageCount}</td>
      <td className="w-56 px-3 py-2">
        {runningJob ? (
          <JobInline job={runningJob} />
        ) : (
          <div className="flex items-center gap-1.5">
            <Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge>
            {c.kind === 'merged' && <Badge tone="accent">PDF unit</Badge>}
            {c.brokenImageCount > 0 && (
              <Tooltip content={`${c.brokenImageCount} broken page(s) — open pages to fix`}>
                <span>
                  <Badge tone="warn">
                    <AlertTriangle /> {c.brokenImageCount}
                  </Badge>
                </span>
              </Tooltip>
            )}
            {c.status === 'failed' && c.error && (
              <Tooltip content={c.error}>
                <span className="truncate text-[10px] text-danger">{c.error}</span>
              </Tooltip>
            )}
          </div>
        )}
      </td>
      <td className="w-20 pr-2 text-right">
        <div className="flex justify-end gap-0.5">
          <Tooltip content="View pages">
            <Button size="icon-sm" variant="ghost" onClick={() => onView(c)} disabled={c.status !== 'ready'}>
              <Eye />
            </Button>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="Chapter actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => reextract.mutate()} disabled={!!runningJob}>
                <RefreshCw /> Re-extract from CBZ
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => replaceInput.current?.click()} disabled={!!runningJob}>
                <Replace /> Replace CBZ…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem danger onSelect={() => onDelete(c)} disabled={!!runningJob}>
                <Trash2 /> Delete chapter
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <input
            ref={replaceInput}
            type="file"
            accept=".cbz,.zip"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                addUploads(c.project, [f], { replaceChapterId: c.id });
                useUploads.getState().startAll(c.project);
              }
              e.target.value = '';
            }}
          />
        </div>
      </td>
    </tr>
  );
};

export const ChapterManager = ({ projectId, chapters, onView }: { projectId: string; chapters: Chapter[]; onView: (c: Chapter) => void }) => {
  const qc = useQueryClient();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const [toDelete, setToDelete] = useState<Chapter | null>(null);
  const reorder = useAction((ids: string[]) => api.put(`/api/manga/projects/${projectId}/chapters/reorder`, { chapterIds: ids }), {
    invalidate: [['chapters', projectId]],
  });
  const remove = useAction((id: string) => api.del(`/api/manga/chapters/${id}`), {
    success: 'Chapter deleted',
    invalidate: [['chapters', projectId], ['project', projectId]],
    onSuccess: () => setToDelete(null),
  });
  const sortByNumber = () => reorder.mutate([...chapters].sort((a, b) => a.number - b.number).map((c) => c.id));

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = chapters.findIndex((c) => c.id === e.active.id);
    const to = chapters.findIndex((c) => c.id === e.over!.id);
    const next = arrayMove(chapters, from, to);
    qc.setQueryData(['chapters', projectId], next);
    reorder.mutate(next.map((c) => c.id));
  };

  if (!chapters.length) {
    return <EmptyState icon={Layers} title="No chapters yet" description="Upload CBZ files in the Upload tab — each archive becomes a chapter." />;
  }

  return (
    <div className="panel overflow-hidden">
      <div className="panel-header">
        <span>{chapters.length} chapters · drag to reorder · click number or title to edit</span>
        <Button size="xs" variant="ghost" onClick={sortByNumber} loading={reorder.isPending}>
          Sort by chapter number
        </Button>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <table className="w-full">
          <thead>
            <tr className="border-b border-line text-left text-[10px] uppercase tracking-wider text-dim">
              <th />
              <th className="py-2 font-medium">Chapter</th>
              <th className="py-2 font-medium">Title</th>
              <th className="py-2 font-medium">CBZ file</th>
              <th className="py-2 text-right font-medium">Size</th>
              <th className="py-2 text-right font-medium">Images</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th />
            </tr>
          </thead>
          <SortableContext items={chapters.map((c) => c.id)} strategy={verticalListSortingStrategy}>
            <tbody>
              {chapters.map((c) => (
                <Row key={c.id} c={c} onView={onView} onDelete={setToDelete} />
              ))}
            </tbody>
          </SortableContext>
        </table>
      </DndContext>
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={`Delete Chapter ${toDelete?.number}?`}
        description="The original CBZ, extracted pages and derived data for this chapter will be permanently removed."
        confirmLabel="Delete chapter"
        danger
        loading={remove.isPending}
        onConfirm={() => toDelete && remove.mutate(toDelete.id)}
      />
    </div>
  );
};
