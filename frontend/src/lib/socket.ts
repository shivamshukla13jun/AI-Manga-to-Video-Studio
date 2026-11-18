import { io, Socket } from 'socket.io-client';
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/stores/auth';
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

/**
 * Global realtime bridge: job progress is merged into the TanStack Query
 * cache and domain events invalidate the affected queries.
 */
export const useRealtimeBridge = () => {
  const qc = useQueryClient();
  useSocketEvent<Job>('job:update', (job) => {
    qc.setQueryData<Job[]>(['jobs'], (prev) => {
      if (!prev) return prev;
      const idx = prev.findIndex((j) => j.id === job.id);
      if (idx === -1) return [job, ...prev];
      const next = prev.slice();
      next[idx] = job;
      return next;
    });
    qc.setQueryData(['job', job.id], (prev: Job | undefined) => (prev ? { ...prev, ...job } : prev));
    if (['completed', 'failed', 'cancelled'].includes(job.status)) {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      if (job.project) {
        qc.invalidateQueries({ queryKey: ['project', job.project] });
        qc.invalidateQueries({ queryKey: ['chapters', job.project] });
        qc.invalidateQueries({ queryKey: ['pdf-exports'] });
      }
    }
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
