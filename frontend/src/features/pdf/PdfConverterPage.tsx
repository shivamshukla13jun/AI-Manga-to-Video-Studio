import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Ban, Download, Eye, FileText, GripVertical, Plus, RotateCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { Badge, Checkbox, Dialog, DialogContent, Switch, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/primitives';
import { EmptyState, JobInline, LoadingState, PageHeader } from '@/components/common/states';
import { jobActions, useAction, useChapters, useJobs, usePdfExports, useProjects } from '@/lib/queries';
import { useProjectRoom } from '@/lib/socket';
import { api } from '@/lib/api';
import { formatBytes, relativeTime } from '@/lib/utils';
import type { Chapter, Job, PdfExport } from '@/lib/types';
import { UploadWorkspace } from '@/features/library/UploadWorkspace';
import { CreateProjectDialog } from '@/features/library/LibraryPage';

const SortableChapter = ({ c, onRemove }: { c: Chapter; onRemove: () => void }) => {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: c.id });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className="flex items-center gap-2 rounded-md border border-line bg-panel-2 px-2 py-1.5 text-xs">
      <button {...attributes} {...listeners} className="cursor-grab text-dim hover:text-fg" aria-label="Drag">
        <GripVertical className="size-3.5" />
      </button>
      <span className="w-14 font-mono text-muted">Ch. {c.number}</span>
      <span className="flex-1 truncate">{c.title}</span>
      <span className="text-dim">{c.imageCount} pages</span>
      <button onClick={onRemove} className="text-dim hover:text-danger" aria-label="Remove">
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
};

export const PdfConverterPage = () => {
  const [params, setParams] = useSearchParams();
  const projects = useProjects();
  const projectId = params.get('project') || projects.data?.[0]?.id || '';
  useProjectRoom(projectId);
  const chapters = useChapters(projectId || undefined);
  const exports = usePdfExports(projectId || undefined);
  const jobs = useJobs({ project: projectId, type: 'pdf-conversion' });
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const [creating, setCreating] = useState(false);
  const [mode, setMode] = useState<'range' | 'select'>('range');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [fileName, setFileName] = useState('');
  const [pageNumbers, setPageNumbers] = useState(false);
  const [bookmarks, setBookmarks] = useState(true);
  const [compression, setCompression] = useState<'none' | 'balanced' | 'small'>('none');
  const [preview, setPreview] = useState<PdfExport | null>(null);

  const all = useMemo(() => [...(chapters.data || [])].sort((a, b) => a.number - b.number), [chapters.data]);
  useEffect(() => {
    if (all.length && start === '' && end === '') {
      setStart(String(all[0].number));
      setEnd(String(all[Math.min(4, all.length - 1)].number));
    }
  }, [all, start, end]);
  useEffect(() => {
    setStart('');
    setEnd('');
    setSelected([]);
  }, [projectId]);

  const byId = new Map(all.map((c) => [c.id, c]));
  const rangeChapters = all.filter((c) => c.number >= Number(start) && c.number <= Number(end));
  const selection = mode === 'range' ? rangeChapters : (selected.map((id) => byId.get(id)).filter(Boolean) as Chapter[]);
  const pages = selection.reduce((n, c) => n + c.imageCount, 0);
  const notReady = selection.filter((c) => !c.archive);
  const jobById = new Map((jobs.data || []).map((j) => [j.id, j]));

  const convert = useAction(
    () =>
      api.post<PdfExport>('/api/pdf/exports', {
        projectId,
        ...(mode === 'range' ? { startNumber: Number(start), endNumber: Number(end) } : { chapterIds: selected }),
        fileName: fileName.trim() || undefined,
        pageNumbers,
        bookmarks,
        compression,
      }),
    { success: (e) => `Converting ${e.fileName}`, invalidate: [['pdf-exports', projectId], ['jobs']] }
  );
  const remove = useAction((id: string) => api.del(`/api/pdf/exports/${id}`), { invalidate: [['pdf-exports', projectId]] });
  const cancel = useAction((id: string) => jobActions.cancel(id), { success: 'Cancelling…', invalidate: [['pdf-exports', projectId]] });
  const retry = useAction((id: string) => jobActions.retry(id), { success: 'Retry queued', invalidate: [['pdf-exports', projectId]] });

  return (
    <div>
      <PageHeader
        icon={FileText}
        title="CBZ to PDF Converter"
        subtitle="Merge a chapter range into a single PDF — independent of AI, no API calls"
        actions={
          <>
            <NativeSelect value={projectId} onChange={(e) => setParams({ project: e.target.value })} className="w-64">
              {(projects.data || []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </NativeSelect>
            <Button onClick={() => setCreating(true)}>
              <Plus /> New project
            </Button>
          </>
        }
      />
      {projects.isLoading ? (
        <LoadingState />
      ) : !projectId ? (
        <div className="p-6">
          <EmptyState icon={FileText} title="Create a project first" description="Chapters are uploaded into a project, then any range can be merged." action={<Button variant="primary" onClick={() => setCreating(true)}><Plus /> New project</Button>} />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 p-6 xl:grid-cols-[1fr_420px]">
          <div className="flex flex-col gap-4">
            <div className="panel">
              <div className="panel-header">1 · Upload CBZ chapters</div>
              <div className="p-3">
                <UploadWorkspace projectId={projectId} chapters={all} />
              </div>
            </div>
            <div className="panel">
              <div className="panel-header">2 · Select chapters</div>
              <div className="p-3">
                {!all.length ? (
                  <p className="text-xs text-muted">Upload chapters above to select them.</p>
                ) : (
                  <Tabs value={mode} onValueChange={(v) => setMode(v as any)}>
                    <TabsList>
                      <TabsTrigger value="range">Chapter range</TabsTrigger>
                      <TabsTrigger value="select">Pick & order chapters</TabsTrigger>
                    </TabsList>
                    <TabsContent value="range" className="pt-3">
                      <div className="flex items-end gap-3">
                        <Field label="Start chapter">
                          <NativeSelect value={start} onChange={(e) => setStart(e.target.value)} className="w-40">
                            {all.map((c) => (
                              <option key={c.id} value={c.number}>
                                Chapter {c.number}
                              </option>
                            ))}
                          </NativeSelect>
                        </Field>
                        <Field label="End chapter">
                          <NativeSelect value={end} onChange={(e) => setEnd(e.target.value)} className="w-40">
                            {all.map((c) => (
                              <option key={c.id} value={c.number}>
                                Chapter {c.number}
                              </option>
                            ))}
                          </NativeSelect>
                        </Field>
                      </div>
                      {Number(end) < Number(start) && <p className="mt-2 text-xs text-danger">End chapter must be ≥ start chapter</p>}
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {rangeChapters.map((c) => (
                          <Badge key={c.id} tone="info">
                            Ch. {c.number} · {c.imageCount}p
                          </Badge>
                        ))}
                      </div>
                    </TabsContent>
                    <TabsContent value="select" className="grid grid-cols-2 gap-3 pt-3">
                      <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
                        {all.map((c) => (
                          <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-panel-2">
                            <Checkbox
                              checked={selected.includes(c.id)}
                              onCheckedChange={(v) => setSelected((s) => (v ? [...s, c.id] : s.filter((x) => x !== c.id)))}
                            />
                            <span className="w-14 font-mono text-muted">Ch. {c.number}</span>
                            <span className="truncate">{c.title}</span>
                          </label>
                        ))}
                      </div>
                      <div className="flex flex-col gap-1">
                        <div className="text-[10px] uppercase tracking-wider text-dim">Merge order (drag)</div>
                        <DndContext
                          sensors={sensors}
                          collisionDetection={closestCenter}
                          onDragEnd={(e) => {
                            if (!e.over || e.active.id === e.over.id) return;
                            setSelected((s) => arrayMove(s, s.indexOf(String(e.active.id)), s.indexOf(String(e.over!.id))));
                          }}
                        >
                          <SortableContext items={selected} strategy={verticalListSortingStrategy}>
                            {selection.map((c) => (
                              <SortableChapter key={c.id} c={c} onRemove={() => setSelected((s) => s.filter((x) => x !== c.id))} />
                            ))}
                          </SortableContext>
                        </DndContext>
                        {!selected.length && <p className="text-xs text-muted">Tick chapters on the left.</p>}
                      </div>
                    </TabsContent>
                  </Tabs>
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <div className="panel">
              <div className="panel-header">3 · Output</div>
              <div className="flex flex-col gap-3 p-3">
                <Field label="File name" hint="Default: <Manga> - Chapters <start>-<end>.pdf">
                  <Input value={fileName} onChange={(e) => setFileName(e.target.value)} placeholder="auto" />
                </Field>
                <Field label="Image quality">
                  <NativeSelect value={compression} onChange={(e) => setCompression(e.target.value as any)}>
                    <option value="none">Original — no recompression (largest)</option>
                    <option value="balanced">Balanced — JPEG 86, max 2000px wide</option>
                    <option value="small">Small — JPEG 70, max 1200px wide</option>
                  </NativeSelect>
                </Field>
                <label className="flex items-center justify-between text-xs">
                  Chapter bookmarks <Switch checked={bookmarks} onCheckedChange={setBookmarks} />
                </label>
                <label className="flex items-center justify-between text-xs">
                  Page numbers <Switch checked={pageNumbers} onCheckedChange={setPageNumbers} />
                </label>
                <div className="rounded-md border border-line bg-panel-2 p-2 text-xs text-muted">
                  {selection.length} chapter(s) · {pages} pages · aspect ratios and reading order preserved
                  {notReady.length > 0 && <div className="mt-1 text-danger">Missing CBZ for chapter(s) {notReady.map((c) => c.number).join(', ')}</div>}
                </div>
                <Button
                  variant="primary"
                  disabled={!selection.length || notReady.length > 0 || (mode === 'range' && Number(end) < Number(start))}
                  loading={convert.isPending}
                  onClick={() => convert.mutate()}
                >
                  <FileText /> Convert to PDF
                </Button>
              </div>
            </div>

            <div className="panel">
              <div className="panel-header">Exports</div>
              <div className="divide-y divide-line">
                {!exports.data?.length ? (
                  <p className="p-3 text-xs text-muted">No PDFs yet.</p>
                ) : (
                  exports.data.map((e) => {
                    const job = typeof e.job === 'object' ? (jobById.get(e.job.id) || e.job) as Job : undefined;
                    const running = job && ['queued', 'active', 'retrying'].includes(job.status);
                    return (
                      <div key={e.id} className="flex flex-col gap-1.5 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-xs font-medium" title={e.fileName}>
                            {e.fileName}
                          </span>
                          <Badge tone={e.status === 'completed' ? 'ok' : e.status === 'failed' ? 'danger' : e.status === 'cancelled' ? 'neutral' : 'accent'}>{running ? job!.status : e.status}</Badge>
                        </div>
                        {running ? (
                          <div className="flex items-center gap-2">
                            <JobInline job={job!} className="flex-1" />
                            <Button size="icon-sm" variant="ghost" onClick={() => cancel.mutate(job!.id)} aria-label="Cancel">
                              <Ban />
                            </Button>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between gap-2 text-[10px] text-dim">
                            <span>
                              {e.pageCount ? `${e.pageCount} pages · ${formatBytes(e.size)} · ` : ''}
                              {relativeTime(e.createdAt)}
                            </span>
                            <div className="flex gap-0.5">
                              {e.status === 'completed' && (
                                <>
                                  <Button size="icon-sm" variant="ghost" onClick={() => setPreview(e)} aria-label="Preview">
                                    <Eye />
                                  </Button>
                                  <Button size="icon-sm" variant="ghost" asChild>
                                    <a href={e.downloadUrl || '#'} aria-label="Download">
                                      <Download />
                                    </a>
                                  </Button>
                                </>
                              )}
                              {job && ['failed', 'cancelled'].includes(job.status) && (
                                <Button size="icon-sm" variant="ghost" onClick={() => retry.mutate(job.id)} aria-label="Retry">
                                  <RotateCw />
                                </Button>
                              )}
                              <Button size="icon-sm" variant="ghost" onClick={() => remove.mutate(e.id)} aria-label="Delete">
                                <Trash2 />
                              </Button>
                            </div>
                          </div>
                        )}
                        {e.error && e.status !== 'completed' && <span className="text-[10px] text-danger">{e.error}</span>}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      <CreateProjectDialog open={creating} onOpenChange={setCreating} />
      {preview && (
        <Dialog open onOpenChange={(o) => !o && setPreview(null)}>
          <DialogContent wide title={preview.fileName} description={`${preview.pageCount} pages · ${formatBytes(preview.size)}`} className="max-w-6xl">
            <iframe src={preview.previewUrl || ''} title="PDF preview" className="h-[70vh] w-full rounded border border-line bg-white" />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
};
