import { io, Socket } from 'socket.io-client';
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from '@/stores/auth';
import { api } from './api';
import type { Job } from './types';

let socket: Socket | null = null;
let socketToken: string | null = null;

/** One authenticated Socket.IO connection, re-created when the access token changes. */
export const getSocket = (): Socket | null => {
  const token = useAuth.getState().accessToken;
  if (!token) {
    socket?.disconnect();
    socket = null;
    return null;
  }
  if (socket && socketToken === token) return socket;
  socket?.disconnect();
  socketToken = token;
  socket = io({ path: '/socket.io', auth: { token }, transports: ['websocket', 'polling'] });
  return socket;
};

export const useSocketEvent = <T,>(event: string, handler: (data: T) => void, deps: unknown[] = []) => {
  const token = useAuth((s) => s.accessToken);
  useEffect(() => {
    const s = getSocket();
    if (!s) return;
    s.on(event, handler);
    return () => {
      s.off(event, handler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, token, ...deps]);
};

export const useProjectRoom = (projectId?: string) => {
  const token = useAuth((s) => s.accessToken);
  useEffect(() => {
    const s = getSocket();
    if (!s || !projectId) return;
    const join = () => s.emit('project:join', projectId);
    join();
    s.on('connect', join);
    return () => {
      s.off('connect', join);
      s.emit('project:leave', projectId);
    };
  }, [projectId, token]);
};

/** Job ids already toasted as failed — cleared on retry so re-failures notify again. */
const toastedFailures = new Set<string>();

/**
 * Global realtime bridge: job progress is merged into the TanStack Query
 * cache and domain events invalidate the affected queries.
 */
export const useRealtimeBridge = () => {
  const qc = useQueryClient();
  useSocketEvent<Job>('job:update', (job) => {
    if (job.status === 'failed' && !toastedFailures.has(job.id)) {
      toastedFailures.add(job.id);
      toast.error(`${job.title} failed${job.error?.message ? `: ${job.error.message}` : ''}`, {
        duration: 15000,
        action: {
          label: 'Retry',
          onClick: async () => {
            try {
              await api.post(`/api/jobs/${job.id}/retry`);
              toastedFailures.delete(job.id);
              toast.success('Retry queued');
              qc.invalidateQueries({ queryKey: ['jobs'] });
            } catch (e: any) {
              toast.error(e.message);
            }
          },
        },
      });
    }
    // broadcasts don't carry logs — keep entries accumulated via job:log
    qc.setQueryData<Job[]>(['jobs'], (prev) => {
      if (!prev) return prev;
      const idx = prev.findIndex((j) => j.id === job.id);
      if (idx === -1) return [job, ...prev];
      const next = prev.slice();
      next[idx] = { ...job, logs: prev[idx].logs };
      return next;
    });
    qc.setQueryData(['job', job.id], (prev: Job | undefined) => (prev ? { ...prev, ...job, logs: prev.logs } : prev));
    if (['completed', 'failed', 'cancelled'].includes(job.status)) {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      if (job.project) {
        qc.invalidateQueries({ queryKey: ['project', job.project] });
        qc.invalidateQueries({ queryKey: ['chapters', job.project] });
        qc.invalidateQueries({ queryKey: ['pdf-exports'] });
      }
    }
  });
  useSocketEvent<{ job: string; at: string; level: 'info' | 'warn' | 'error'; message: string }>('job:log', (entry) => {
    const append = (prev: Job[] | undefined) => {
      if (!prev) return prev;
      const idx = prev.findIndex((j) => j.id === entry.job);
      if (idx === -1) return prev;
      const next = prev.slice();
      const logs = [...(next[idx].logs || []), { at: entry.at, level: entry.level, message: entry.message }];
      next[idx] = { ...next[idx], logs: logs.slice(-200) };
      return next;
    };
    qc.setQueryData<Job[]>(['jobs'], append);
    qc.setQueryData(['job', entry.job], (prev: Job | undefined) =>
      prev ? { ...prev, logs: [...(prev.logs || []), { at: entry.at, level: entry.level, message: entry.message }].slice(-200) } : prev
    );
  });
  useSocketEvent<{ id: string; project: string }>('chapter:update', (c) => {
    qc.invalidateQueries({ queryKey: ['chapters', c.project] });
    qc.invalidateQueries({ queryKey: ['chapter-images', c.id] });
  });
  useSocketEvent<{ id: string; chapter: string }>('image:update', (img) => {
    qc.invalidateQueries({ queryKey: ['chapter-images', img.chapter] });
  });
  useSocketEvent<{ project: string }>('audio:update', (a) => {
    qc.invalidateQueries({ queryKey: ['audio', a.project] });
  });
  useSocketEvent<{ chapter: string }>('story:update', (s) => {
    qc.invalidateQueries({ queryKey: ['segments'] });
    qc.invalidateQueries({ queryKey: ['scenes', s.chapter] });
    qc.invalidateQueries({ queryKey: ['story-overview'] });
  });
};
