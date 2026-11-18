import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { videoApi } from '@/lib/queries';
import type { TimelineClip, TimelineTrack, VideoProject } from '@/lib/types';

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

export interface EditorState {
  tracks: TimelineTrack[];
  dirty: boolean;
  saving: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * Client-side timeline editing model: mutations mutate local state with an
 * undo stack, then debounce-persist the whole timeline via saveTimeline
 * (optimistic concurrency on `revision`).
 */
export const useTimelineEditor = (video: VideoProject | undefined, onSaved: (v: VideoProject) => void) => {
  const [tracks, setTracks] = useState<TimelineTrack[]>([]);
  const tracksRef = useRef<TimelineTrack[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const revision = useRef(0);
  const undoStack = useRef<TimelineTrack[][]>([]);
  const redoStack = useRef<TimelineTrack[][]>([]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const videoId = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!video) return;
    // adopt server state whenever the video id changes or revision moved ahead of us
    if (videoId.current !== video.id || (!dirty && video.revision !== revision.current)) {
      videoId.current = video.id;
      revision.current = video.revision;
      tracksRef.current = clone(video.tracks);
      setTracks(tracksRef.current);
      undoStack.current = [];
      redoStack.current = [];
      setDirty(false);
    }
  }, [video, dirty]);

  const save = useCallback(
    async (snapshot: TimelineTrack[], label?: string) => {
      if (!videoId.current) return;
      setSaving(true);
      try {
        const saved = await videoApi.saveTimeline(videoId.current, revision.current, snapshot, label);
        revision.current = saved.revision;
        setDirty(false);
        onSaved(saved);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          toast.error('Timeline was changed elsewhere — reloading latest');
          onSaved(undefined as unknown as VideoProject); // caller refetches
        } else {
          toast.error(e instanceof Error ? e.message : 'Save failed');
          setDirty(true);
        }
      } finally {
        setSaving(false);
      }
    },
    [onSaved]
  );

  const scheduleSave = useCallback(
    (snapshot: TimelineTrack[]) => {
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => save(snapshot), 1200);
    },
    [save]
  );

  /** Apply a mutation: push undo snapshot, update state, schedule persist. */
  const mutate = useCallback(
    (fn: (draft: TimelineTrack[]) => void, opts?: { instant?: boolean }) => {
      setTracks((prev) => {
        const draft = clone(prev);
        fn(draft);
        undoStack.current.push(prev);
        if (undoStack.current.length > 100) undoStack.current.shift();
        redoStack.current = [];
        setDirty(true);
        tracksRef.current = draft;
        if (opts?.instant) save(draft);
        else scheduleSave(draft);
        return draft;
      });
    },
    [save, scheduleSave]
  );

  const undo = useCallback(() => {
    const snap = undoStack.current.pop();
    if (snap === undefined) return;
    redoStack.current.push(tracksRef.current);
    setDirty(true);
    tracksRef.current = snap;
    setTracks(snap);
    scheduleSave(snap);
  }, [scheduleSave]);

  const redo = useCallback(() => {
    const snap = redoStack.current.pop();
    if (snap === undefined) return;
    undoStack.current.push(tracksRef.current);
    setDirty(true);
    tracksRef.current = snap;
    setTracks(snap);
    scheduleSave(snap);
  }, [scheduleSave]);

  /** Persist immediately; resolves after the save completes. */
  const flush = useCallback(async () => {
    clearTimeout(saveTimer.current);
    await save(tracksRef.current);
  }, [save]);

  return {
    tracks,
    state: { dirty, saving, canUndo: undoStack.current.length > 0, canRedo: redoStack.current.length > 0 },
    mutate,
    undo,
    redo,
    flush,
  };
};

// ------------------------------------------------------------- pure ops
export const findClipRef = (tracks: TimelineTrack[], clipId: string) => {
  for (const t of tracks) {
    const clip = t.clips.find((c) => c.id === clipId);
    if (clip) return { track: t, clip };
  }
  return undefined;
};

export const moveClip = (clip: TimelineClip, to: { start: number; trackId?: string }, tracks: TimelineTrack[]) => {
  const ref = findClipRef(tracks, clip.id);
  if (!ref) return;
  const { track } = ref;
  clip.start = Math.max(0, to.start);
  if (to.trackId && to.trackId !== track.id) {
    const target = tracks.find((t) => t.id === to.trackId);
    if (target && target.kind === track.kind) {
      track.clips = track.clips.filter((c) => c.id !== clip.id);
      target.clips.push(clip);
    }
  }
};

export const splitClipAt = (clip: TimelineClip, at: number, tracks: TimelineTrack[]) => {
  const ref = findClipRef(tracks, clip.id);
  if (!ref || at <= clip.start || at >= clip.start + clip.duration) return;
  const { track } = ref;
  const right: TimelineClip = {
    ...clone(clip),
    id: `new-${Math.random().toString(36).slice(2, 10)}`,
    start: at,
    duration: clip.start + clip.duration - at,
    mediaStart: clip.mediaStart + (at - clip.start),
    transitionIn: { type: 'none', duration: 0 },
  };
  clip.duration = at - clip.start;
  clip.transitionOut = { type: 'none', duration: 0 };
  const idx = track.clips.findIndex((c) => c.id === clip.id);
  track.clips.splice(idx + 1, 0, right);
};

export const mergeAdjacent = (track: TimelineTrack, ids: string[]) => {
  const picked = track.clips.filter((c) => ids.includes(c.id)).sort((a, b) => a.start - b.start);
  if (picked.length < 2) return;
  const all = [...track.clips].sort((a, b) => a.start - b.start);
  const idxs = picked.map((c) => all.findIndex((x) => x.id === c.id));
  if (!idxs.every((v, i) => i === 0 || v === idxs[i - 1] + 1)) return;
  const [first, ...rest] = picked;
  first.duration = rest[rest.length - 1].start + rest[rest.length - 1].duration - first.start;
  first.transitionOut = rest[rest.length - 1].transitionOut;
  track.clips = track.clips.filter((c) => !rest.some((r) => r.id === c.id));
};
