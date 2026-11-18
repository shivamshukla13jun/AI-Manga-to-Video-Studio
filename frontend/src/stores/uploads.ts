import { create } from 'zustand';
import { API_BASE, ApiError, api } from '@/lib/api';
import { useAuth } from '@/stores/auth';
import { guessChapterNumber } from '@/lib/utils';
import type { UploadSession } from '@/lib/types';

export type UploadStatus = 'pending' | 'uploading' | 'paused' | 'finalizing' | 'done' | 'error' | 'duplicate';

export interface UploadItem {
  id: string;
  projectId: string;
  file: File;
  chapterNumber?: number;
  chapterTitle: string;
  replaceChapterId?: string;
  status: UploadStatus;
  /** bytes confirmed by the server + bytes of the in-flight chunk */
  uploadedBytes: number;
  sessionId?: string;
  error?: string;
  warnings: string[];
  chapterId?: string;
  jobId?: string;
}

interface UploadState {
  items: UploadItem[];
  add: (projectId: string, files: File[], opts?: { replaceChapterId?: string }) => void;
  update: (id: string, patch: Partial<UploadItem>) => void;
  remove: (id: string) => void;
  clearFinished: (projectId: string) => void;
  start: (id: string, opts?: { allowDuplicate?: boolean }) => void;
  startAll: (projectId: string) => void;
  pause: (id: string) => void;
}

const controllers = new Map<string, AbortController>();
const MAX_PARALLEL_FILES = 2;
const CHUNK_RETRIES = 4;

/** PUT one chunk with XHR so the UI gets byte-level progress. */
const putChunk = (sessionId: string, index: number, blob: Blob, signal: AbortSignal, onProgress: (loaded: number) => void) =>
  new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${API_BASE}/api/manga/uploads/${sessionId}/chunks/${index}`);
    xhr.setRequestHeader('Authorization', `Bearer ${useAuth.getState().accessToken}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () =>
      xhr.status < 300 ? resolve() : reject(new ApiError(JSON.parse(xhr.responseText || '{}').message || `Chunk failed (${xhr.status})`, xhr.status));
    xhr.onerror = () => reject(new ApiError('Network error', 0));
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(blob);
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const useUploads = create<UploadState>((set, get) => {
  const pump = (projectId: string) => {
    const items = get().items.filter((i) => i.projectId === projectId);
    const active = items.filter((i) => i.status === 'uploading' || i.status === 'finalizing').length;
    const next = items.filter((i) => i.status === 'pending').slice(0, Math.max(0, MAX_PARALLEL_FILES - active));
    next.forEach((i) => get().start(i.id));
  };

  const run = async (id: string, allowDuplicate?: boolean) => {
    const item = get().items.find((i) => i.id === id);
    if (!item) return;
    const ctrl = new AbortController();
    controllers.set(id, ctrl);
    const update = (patch: Partial<UploadItem>) => get().update(id, patch);
    update({ status: 'uploading', error: undefined });
    try {
      const fingerprint = `${item.file.name}:${item.file.size}:${item.file.lastModified}`;
      const session = await api.post<UploadSession>(`/api/manga/projects/${item.projectId}/uploads`, {
        fileName: item.file.name,
        size: item.file.size,
        fingerprint,
        chapterNumber: item.chapterNumber,
        chapterTitle: item.chapterTitle || undefined,
        replaceChapterId: item.replaceChapterId,
      });
      const received = new Set(session.received);
      let confirmed = [...received].reduce((sum, i) => sum + Math.min(session.chunkSize, item.file.size - i * session.chunkSize), 0);
      update({ sessionId: session.id, warnings: session.warnings || [], uploadedBytes: confirmed });

      for (let index = 0; index < session.totalChunks; index++) {
        if (received.has(index)) continue;
        const start = index * session.chunkSize;
        const blob = item.file.slice(start, Math.min(item.file.size, start + session.chunkSize));
        for (let attempt = 1; ; attempt++) {
          if (ctrl.signal.aborted) throw new DOMException('Aborted', 'AbortError');
          try {
            await putChunk(session.id, index, blob, ctrl.signal, (loaded) => update({ uploadedBytes: confirmed + loaded }));
            break;
          } catch (e: any) {
            if (e?.name === 'AbortError' || attempt >= CHUNK_RETRIES || (e.status >= 400 && e.status < 500 && e.status !== 429)) throw e;
            await sleep(800 * 2 ** attempt);
          }
        }
        confirmed += blob.size;
        update({ uploadedBytes: confirmed });
      }

      update({ status: 'finalizing' });
      const done = await api.post<{ chapter: { id: string }; job: { id: string } }>(
        `/api/manga/uploads/${session.id}/complete`,
        allowDuplicate ? { allowDuplicate: true } : {}
      );
      update({ status: 'done', chapterId: done.chapter.id, jobId: done.job.id, uploadedBytes: item.file.size });
    } catch (e: any) {
      if (e?.name === 'AbortError') update({ status: 'paused' });
      else if (e instanceof ApiError && e.status === 409 && e.errors?.duplicate) update({ status: 'duplicate', error: e.message });
      else update({ status: 'error', error: e?.message || 'Upload failed' });
    } finally {
      controllers.delete(id);
      pump(item.projectId);
    }
  };

  return {
    items: [],
    add: (projectId, files, opts) =>
      set((s) => {
        const existing = new Set(s.items.filter((i) => i.projectId === projectId && i.status !== 'done').map((i) => `${i.file.name}:${i.file.size}`));
        const added = files
          .filter((f) => /\.(cbz|zip)$/i.test(f.name) && !existing.has(`${f.name}:${f.size}`))
          .map<UploadItem>((file) => {
            const n = guessChapterNumber(file.name);
            return {
              id: crypto.randomUUID(),
              projectId,
              file,
              chapterNumber: n,
              chapterTitle: n !== undefined ? `Chapter ${n}` : file.name.replace(/\.[^.]+$/, ''),
              replaceChapterId: opts?.replaceChapterId,
              status: 'pending',
              uploadedBytes: 0,
              warnings: [],
            };
          });
        return { items: [...s.items, ...added] };
      }),
    update: (id, patch) => set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) })),
    remove: (id) => {
      const item = get().items.find((i) => i.id === id);
      controllers.get(id)?.abort();
      if (item?.sessionId && item.status !== 'done') api.del(`/api/manga/uploads/${item.sessionId}`).catch(() => undefined);
      set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
    },
    clearFinished: (projectId) => set((s) => ({ items: s.items.filter((i) => !(i.projectId === projectId && i.status === 'done')) })),
    start: (id, opts) => {
      const item = get().items.find((i) => i.id === id);
      if (!item || controllers.has(id)) return;
      void run(id, opts?.allowDuplicate);
    },
    startAll: (projectId) => {
      set((s) => ({
        items: s.items.map((i) => (i.projectId === projectId && ['paused', 'error'].includes(i.status) ? { ...i, status: 'pending' } : i)),
      }));
      pump(projectId);
    },
    pause: (id) => controllers.get(id)?.abort(),
  };
});
