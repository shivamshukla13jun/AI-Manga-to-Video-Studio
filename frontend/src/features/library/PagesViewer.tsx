import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, ImageOff, RefreshCw, Replace, Trash2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/input';
import { Badge, Dialog, DialogContent } from '@/components/ui/primitives';
import { ConfirmDialog, EmptyState, ErrorState, LoadingState } from '@/components/common/states';
import { useAction, useChapterImages } from '@/lib/queries';
import { api } from '@/lib/api';
import { formatBytes } from '@/lib/utils';
import type { Chapter, ComicImage } from '@/lib/types';

export const PageThumb = ({ img, onClick, selected }: { img: ComicImage; onClick?: () => void; selected?: boolean }) => (
  <button
    onClick={onClick}
    className={`group relative flex flex-col overflow-hidden rounded-md border bg-panel-2 text-left transition-colors ${
      selected ? 'border-accent' : img.status === 'broken' ? 'border-danger/60' : 'border-line hover:border-accent/50'
    }`}
  >
    <div className="checkerboard flex h-44 items-start justify-center overflow-hidden">
      {img.thumbnailUrl ? (
        <img src={img.thumbnailUrl} alt={`Page ${img.index + 1}`} className="w-full object-cover object-top" loading="lazy" />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-1 text-danger">
          <ImageOff className="size-5" />
          <span className="text-[10px]">broken</span>
        </div>
      )}
    </div>
    <div className="flex items-center justify-between gap-1 px-2 py-1 text-[10px]">
      <span className="font-mono text-muted">#{img.index + 1}</span>
      <span className="truncate text-dim">
        {img.width}×{img.height}
      </span>
      {img.status !== 'ok' && <Badge tone={img.status === 'broken' ? 'danger' : 'info'}>{img.status}</Badge>}
    </div>
  </button>
);

export const PagesViewer = ({ chapters, chapterId, onChapterChange }: { chapters: Chapter[]; chapterId?: string; onChapterChange: (id: string) => void }) => {
  const ready = chapters.filter((c) => c.status === 'ready');
  const current = chapterId || ready[0]?.id;
  const { data: images, isLoading, error, refetch } = useChapterImages(current);
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const broken = images?.filter((i) => i.status === 'broken').length || 0;

  useEffect(() => {
    if (!chapterId && ready[0]) onChapterChange(ready[0].id);
  }, [chapterId, ready, onChapterChange]);

  if (!ready.length) return <EmptyState icon={ImageOff} title="No extracted chapters yet" description="Pages appear here once CBZ extraction completes." />;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <NativeSelect value={current} onChange={(e) => onChapterChange(e.target.value)} className="w-72">
          {ready.map((c) => (
            <option key={c.id} value={c.id}>
              Chapter {c.number} — {c.title} ({c.imageCount} pages)
            </option>
          ))}
        </NativeSelect>
        {broken > 0 && (
          <Badge tone="danger">
            <AlertTriangle /> {broken} broken page(s) — click to recover
          </Badge>
        )}
      </div>
      {isLoading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2">
          {images?.map((img, i) => (
            <PageThumb key={img.id} img={img} onClick={() => setOpenIdx(i)} />
          ))}
        </div>
      )}
      {images && openIdx !== null && images[openIdx] && (
        <PageDialog images={images} index={openIdx} onIndex={setOpenIdx} onClose={() => setOpenIdx(null)} />
      )}
    </div>
  );
};

const PageDialog = ({ images, index, onIndex, onClose }: { images: ComicImage[]; index: number; onIndex: (i: number) => void; onClose: () => void }) => {
  const img = images[index];
  const fileInput = useRef<HTMLInputElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const reextract = useAction(() => api.post(`/api/manga/images/${img.id}/reextract`), { success: 'Re-extraction queued' });
  const restore = useAction(() => api.post(`/api/manga/images/${img.id}/restore`), { success: 'Restoring original page' });
  const remove = useAction(() => api.del(`/api/manga/images/${img.id}`), {
    success: 'Page deleted',
    invalidate: [['chapter-images', img.chapter], ['chapters']],
    onSuccess: () => (images.length > 1 ? onIndex(Math.min(index, images.length - 2)) : onClose()),
  });
  const replace = useAction(
    (file: File) => {
      const fd = new FormData();
      fd.append('image', file);
      return api.post(`/api/manga/images/${img.id}/replace`, fd);
    },
    { success: 'Page replaced — original kept', invalidate: [['chapter-images', img.chapter]] }
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' && index < images.length - 1) onIndex(index + 1);
      if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, images.length, onIndex]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent wide title={`Page ${img.index + 1} of ${images.length}`} description={`${img.entryName} · ${img.width}×${img.height} · ${formatBytes(img.size)}`}>
        <div className="flex gap-4">
          <div className="checkerboard flex max-h-[62vh] min-h-64 flex-1 justify-center overflow-y-auto rounded-md border border-line">
            {img.status === 'broken' ? (
              <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-danger">
                <ImageOff className="size-8" />
                <p className="text-xs">This page could not be decoded.</p>
                <p className="max-w-xs text-[11px] text-muted">{img.error}</p>
              </div>
            ) : (
              <img src={img.url || ''} alt="" className="h-auto max-w-full self-start" />
            )}
          </div>
          <div className="flex w-52 shrink-0 flex-col gap-2">
            <div className="flex gap-1">
              <Button size="sm" disabled={index === 0} onClick={() => onIndex(index - 1)} className="flex-1">
                <ChevronLeft /> Prev
              </Button>
              <Button size="sm" disabled={index === images.length - 1} onClick={() => onIndex(index + 1)} className="flex-1">
                Next <ChevronRight />
              </Button>
            </div>
            <div className="mt-2 text-[10px] font-semibold uppercase tracking-wider text-dim">Recovery</div>
            <Button size="sm" onClick={() => reextract.mutate()} loading={reextract.isPending}>
              <RefreshCw /> Re-extract from CBZ
            </Button>
            <Button size="sm" onClick={() => fileInput.current?.click()} loading={replace.isPending}>
              <Replace /> Replace image…
            </Button>
            {img.hasReplacement && (
              <Button size="sm" onClick={() => restore.mutate()} loading={restore.isPending}>
                <Undo2 /> Restore original
              </Button>
            )}
            <div className="mt-2 text-[10px] font-semibold uppercase tracking-wider text-dim">Danger</div>
            <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
              <Trash2 /> Delete page
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) replace.mutate(f);
                e.target.value = '';
              }}
            />
            <p className="mt-2 text-[10px] leading-relaxed text-dim">
              The page extracted from the original CBZ is never overwritten — replacements are stored separately and can be undone.
            </p>
            {img.isTall && <Badge tone="info">tall strip</Badge>}
          </div>
        </div>
      </DialogContent>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete page ${img.index + 1}?`}
        description="The page is permanently removed. Scenes that only used this page are deleted too; narration segments and timeline clips referencing them are updated."
        confirmLabel="Delete page"
        danger
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </Dialog>
  );
};
