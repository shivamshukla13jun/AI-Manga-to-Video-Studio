import { useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, FileArchive, ListOrdered, Pause, Play, RotateCw, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge, Progress, Tooltip } from '@/components/ui/primitives';
import { useUploads, type UploadItem } from '@/stores/uploads';
import { cn, formatBytes } from '@/lib/utils';
import { mergeCbzFiles } from '@/lib/cbz-merge';
import type { Chapter } from '@/lib/types';

const STATUS_TONE: Record<UploadItem['status'], 'neutral' | 'accent' | 'ok' | 'danger' | 'warn'> = {
  pending: 'neutral',
  uploading: 'accent',
  paused: 'warn',
  finalizing: 'accent',
  done: 'ok',
  error: 'danger',
  duplicate: 'warn',
};

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export const UploadWorkspace = ({ projectId, chapters }: { projectId: string; chapters: Chapter[] }) => {
  const qc = useQueryClient();
  const all = useUploads((s) => s.items);
  const items = useMemo(() => all.filter((i) => i.projectId === projectId), [all, projectId]);
  const { add, update, remove, start, startAll, pause, clearFinished } = useUploads();
  const [dragging, setDragging] = useState(false);
  const [startNumber, setStartNumber] = useState('1');
  const [skipFirstPage, setSkipFirstPage] = useState(false);
  const [mergeUnits, setMergeUnits] = useState(true);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const existingNumbers = new Set(chapters.map((c) => c.number));
  const queuedNumbers = items.filter((i) => i.status !== 'done' && !i.replaceChapterId).map((i) => i.chapterNumber);
  const dupInQueue = (n?: number) => n !== undefined && queuedNumbers.filter((x) => x === n).length > 1;

  const onFiles = async (files: FileList | File[]) => {
    const list = Array.from(files).sort((a, b) => collator.compare(a.name, b.name));
    setMergeError(null);
    if (!mergeUnits) {
      add(projectId, list, { skipPages: skipFirstPage ? 1 : undefined });
      return;
    }
    // Merge on the client: pages from all CBZs are repacked into ≤48MB units —
    // only the merged units ever reach the server.
    setMerging(true);
    try {
      const merged = await mergeCbzFiles(list, { skipFirstPage });
      add(projectId, merged, { autoMerge: true });
    } catch (error: any) {
      setMergeError(error?.message || 'Could not merge the selected archives');
    } finally {
      setMerging(false);
    }
  };

  const toggleSkipFirst = (on: boolean) => {
    setSkipFirstPage(on);
    // Merged units already dropped their first pages in the browser.
    items.filter((i) => ['pending', 'paused', 'error'].includes(i.status) && !i.autoMerge).forEach((i) => update(i.id, { skipPages: on ? 1 : undefined }));
  };

  const pending = items.filter((i) => ['pending', 'paused', 'error'].includes(i.status));
  const totalBytes = items.reduce((n, i) => n + i.file.size, 0);
  const doneBytes = items.reduce((n, i) => n + i.uploadedBytes, 0);
  const hasDone = items.some((i) => i.status === 'done');

  const assignSequential = () => {
    let n = Number(startNumber) || 1;
    items
      .filter((i) => i.status === 'pending' && !i.replaceChapterId)
      .forEach((i) => {
        update(i.id, { chapterNumber: n, chapterTitle: i.chapterTitle.match(/^Chapter [\d.]+$/) ? `Chapter ${n}` : i.chapterTitle });
        n += 1;
      });
  };

  return (
    <div className="flex flex-col gap-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          onFiles(e.dataTransfer.files);
        }}
        onClick={() => input.current?.click()}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors',
          dragging ? 'border-accent bg-accent/10' : 'border-line-strong hover:border-accent/60 hover:bg-panel-2'
        )}
      >
        <Upload className="size-6 text-accent-2" />
        <p className="text-sm font-medium">Drop CBZ chapters here or click to browse</p>
        <p className="text-xs text-muted">Multiple files · resumable chunked upload · large archives are streamed, never loaded into memory</p>
        <input ref={input} type="file" accept=".cbz,.zip" multiple hidden onChange={(e) => e.target.files && (onFiles(e.target.files), (e.target.value = ''))} />
      </div>

      <div className="flex flex-col gap-2">
        <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-muted select-none">
          <input
            type="checkbox"
            checked={mergeUnits}
            onChange={(e) => setMergeUnits(e.target.checked)}
            className="size-3.5 accent-accent"
          />
          Merge into ≤50MB PDF units <span className="text-dim">(merges in your browser — only merged units are uploaded &amp; stored)</span>
        </label>
        <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-muted select-none">
          <input
            type="checkbox"
            checked={skipFirstPage}
            onChange={(e) => toggleSkipFirst(e.target.checked)}
            className="size-3.5 accent-accent"
          />
          Skip first page of every chapter <span className="text-dim">(drops cover/credit pages during extraction)</span>
        </label>
        {merging && <span className="text-[11px] text-accent-2">Merging archives in the browser…</span>}
        {mergeError && <span className="text-[11px] text-danger">{mergeError}</span>}
      </div>

      {items.length > 0 && (
        <div className="panel overflow-hidden">
          <div className="panel-header">
            <span>
              {items.length} file(s) · {formatBytes(doneBytes)} / {formatBytes(totalBytes)}
            </span>
            <div className="flex items-center gap-1.5 normal-case tracking-normal">
              <Tooltip content="Assign consecutive chapter numbers to pending files in the order shown">
                <div className="flex items-center gap-1">
                  <span className="text-[11px] font-normal text-muted">Number from</span>
                  <Input value={startNumber} onChange={(e) => setStartNumber(e.target.value)} className="h-6 w-14 text-xs" type="number" />
                  <Button size="xs" variant="ghost" onClick={assignSequential}>
                    <ListOrdered /> Assign
                  </Button>
                </div>
              </Tooltip>
              {hasDone && (
                <Button size="xs" variant="ghost" onClick={() => clearFinished(projectId)}>
                  Clear finished
                </Button>
              )}
              <Button size="xs" variant="primary" disabled={!pending.length} onClick={() => startAll(projectId)}>
                <Play /> Upload {pending.length || ''}
              </Button>
            </div>
          </div>
          <div className="divide-y divide-line">
            {items.map((i) => {
              const pct = i.file.size ? (i.uploadedBytes / i.file.size) * 100 : 0;
              const editable = i.status === 'pending' || i.status === 'paused' || i.status === 'error';
              const numberClash = !i.replaceChapterId && i.chapterNumber !== undefined && (existingNumbers.has(i.chapterNumber) || dupInQueue(i.chapterNumber));
              return (
                <div key={i.id} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-3 py-2.5">
                  <FileArchive className="size-4 text-muted" />
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-xs font-medium" title={i.file.name}>
                        {i.file.name}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-dim">{formatBytes(i.file.size)}</span>
                      <Badge tone={STATUS_TONE[i.status]}>{i.status}</Badge>
                      {i.replaceChapterId && <Badge tone="info">replaces chapter</Badge>}
                      {i.autoMerge && <Badge tone="info">merged unit</Badge>}
                      {!!i.skipPages && <Badge tone="neutral">skip first {i.skipPages}p</Badge>}
                    </div>
                    {!i.replaceChapterId && (
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] uppercase text-dim">Ch.</span>
                        <Input
                          type="number"
                          step="any"
                          value={i.chapterNumber ?? ''}
                          disabled={!editable}
                          onChange={(e) => update(i.id, { chapterNumber: e.target.value === '' ? undefined : Number(e.target.value) })}
                          className={cn('h-6 w-20 text-xs', numberClash && 'border-warn')}
                          placeholder="auto"
                        />
                        <Input
                          value={i.chapterTitle}
                          disabled={!editable}
                          onChange={(e) => update(i.id, { chapterTitle: e.target.value })}
                          className="h-6 max-w-80 text-xs"
                          placeholder="Chapter title"
                        />
                        {numberClash && (
                          <span className="flex items-center gap-1 text-[10px] text-warn">
                            <AlertTriangle className="size-3" /> number already used
                          </span>
                        )}
                      </div>
                    )}
                    {['uploading', 'finalizing', 'paused'].includes(i.status) && <Progress value={pct} tone={i.status === 'paused' ? 'warn' : 'accent'} />}
                    {i.status === 'finalizing' && <span className="text-[10px] text-muted">Verifying archive and checking for duplicates…</span>}
                    {i.warnings.map((w) => (
                      <span key={w} className="text-[10px] text-warn">
                        {w}
                      </span>
                    ))}
                    {i.error && <span className={cn('text-[10px]', i.status === 'duplicate' ? 'text-warn' : 'text-danger')}>{i.error}</span>}
                    {i.status === 'done' && (
                      <span className="flex items-center gap-1 text-[10px] text-ok">
                        <CheckCircle2 className="size-3" /> Uploaded — extraction queued
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-0.5">
                    {i.status === 'uploading' && (
                      <Tooltip content="Pause">
                        <Button size="icon-sm" variant="ghost" onClick={() => pause(i.id)}>
                          <Pause />
                        </Button>
                      </Tooltip>
                    )}
                    {(i.status === 'paused' || i.status === 'pending') && (
                      <Tooltip content={i.status === 'paused' ? 'Resume' : 'Start'}>
                        <Button size="icon-sm" variant="ghost" onClick={() => start(i.id)}>
                          <Play />
                        </Button>
                      </Tooltip>
                    )}
                    {i.status === 'error' && (
                      <Tooltip content="Retry (already-received chunks are skipped)">
                        <Button size="icon-sm" variant="ghost" onClick={() => start(i.id)}>
                          <RotateCw />
                        </Button>
                      </Tooltip>
                    )}
                    {i.status === 'duplicate' && (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => {
                          start(i.id, { allowDuplicate: true });
                          qc.invalidateQueries({ queryKey: ['chapters', projectId] });
                        }}
                      >
                        Upload anyway
                      </Button>
                    )}
                    {i.status !== 'finalizing' && (
                      <Tooltip content={i.status === 'done' ? 'Dismiss' : 'Remove'}>
                        <Button size="icon-sm" variant="ghost" onClick={() => remove(i.id)}>
                          <X />
                        </Button>
                      </Tooltip>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
