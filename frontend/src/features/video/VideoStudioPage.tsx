import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Player, type PlayerRef } from '@remotion/player';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Clapperboard, GitBranch, History, Plus, Redo2, RefreshCw, Save,
  Scissors, Merge, Trash2, Undo2, ZoomIn, ZoomOut,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NativeSelect, Field, Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from '@/components/ui/primitives';
import { LoadingState, PageHeader } from '@/components/common/states';
import { useProjects, useVideo, useVideos, videoApi } from '@/lib/queries';
import type { VideoProject } from '@/lib/types';
import { StudioComposition } from './StudioComposition';
import { TimelinePanel } from './TimelinePanel';
import { ClipInspector } from './ClipInspector';
import { findClipRef, mergeAdjacent, splitClipAt, useTimelineEditor } from './useTimelineEditor';

const fmtT = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export const VideoStudioPage = () => {
  const { videoId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const projects = useProjects();
  const [projectId, setProjectId] = useState<string>();
  const videos = useVideos(projectId);
  const video = useVideo(videoId);
  const rendering = video.data?.renderStatus === 'rendering' || video.data?.renderStatus === 'queued';
  useEffect(() => {
    if (!rendering) return;
    const iv = setInterval(() => video.refetch(), 3000);
    return () => clearInterval(iv);
  }, [rendering]);

  const [selected, setSelected] = useState<string[]>([]);
  const [playhead, setPlayhead] = useState(0);
  const [pxPerSec, setPxPerSec] = useState(60);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('Main Edit');
  const [versionLabel, setVersionLabel] = useState('');
  const [menu, setMenu] = useState<{ clipId: string; x: number; y: number } | null>(null);
  const [seekTarget, setSeekTarget] = useState<number>();
  const playerRef = useRef<PlayerRef>(null);

  useEffect(() => {
    if (!projectId && projects.data?.length) setProjectId(projects.data[0].id);
  }, [projects.data, projectId]);
  useEffect(() => {
    if (!videoId && videos.data?.length) navigate(`/video/${videos.data[0].id}`, { replace: true });
  }, [videos.data, videoId, navigate]);

  const onSaved = useCallback(
    (v: VideoProject) => {
      if (v) qc.setQueryData(['video', v.id], v);
      else video.refetch();
    },
    [qc, video]
  );
  const editor = useTimelineEditor(video.data, onSaved);
  const tracks = editor.tracks;
  const settings = video.data?.settings;

  const duration = useMemo(
    () => Math.max(1, ...tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration))),
    [tracks]
  );

  // keep playhead synced with the Remotion player
  useEffect(() => {
    const iv = setInterval(() => {
      const p = playerRef.current;
      if (p && settings) setPlayhead(p.getCurrentFrame() / settings.fps);
    }, 100);
    return () => clearInterval(iv);
  }, [settings]);

  const seek = useCallback(
    (t: number) => {
      if (!settings) return;
      playerRef.current?.seekTo(Math.max(0, Math.round(t * settings.fps)));
      setSeekTarget(t);
    },
    [settings]
  );

  const selectedClip = selected.length === 1 ? findClipRef(tracks, selected[0])?.clip : undefined;

  const doSplit = useCallback(() => {
    if (!selectedClip) return toast.error('Select a clip to split');
    editor.mutate((t) => splitClipAt(findClipRef(t, selectedClip.id)!.clip, playhead, t));
    setSelected([]);
  }, [selectedClip, playhead, editor]);

  const doMerge = useCallback(() => {
    if (selected.length < 2) return toast.error('Select two adjacent clips (shift-click) to merge');
    editor.mutate((t) => {
      const ref = findClipRef(t, selected[0]);
      if (ref) mergeAdjacent(ref.track, selected);
    });
    setSelected([]);
  }, [selected, editor]);

  const doDelete = useCallback(() => {
    if (!selected.length) return;
    editor.mutate((t) => t.forEach((tr) => (tr.clips = tr.clips.filter((c) => !selected.includes(c.id)))));
    setSelected([]);
  }, [selected, editor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
      if (e.ctrlKey && e.key === 'z' && !e.shiftKey) { e.preventDefault(); editor.undo(); }
      else if (e.ctrlKey && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); editor.redo(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); doDelete(); }
      else if (e.key.toLowerCase() === 's') { e.preventDefault(); doSplit(); }
      else if (e.key === ' ') { e.preventDefault(); playerRef.current?.isPlaying() ? playerRef.current.pause() : playerRef.current?.play(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor, doDelete, doSplit]);

  const selectClip = (id: string, additive: boolean) =>
    setSelected((prev) => (additive ? (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]) : [id]));

  if (projects.isLoading || (videoId && video.isLoading)) return <LoadingState label="Loading Video Studio" />;

  const saveVersion = async () => {
    if (!videoId || !versionLabel.trim()) return;
    editor.flush();
    await videoApi.createVersion(videoId, versionLabel.trim());
    toast.success('Version saved');
    setVersionLabel('');
    video.refetch();
  };

  return (
    <div className="flex h-full min-h-0 flex-col" onClick={() => setMenu(null)}>
      <PageHeader
        icon={Clapperboard}
        title={video.data ? video.data.name : 'Video Studio'}
        subtitle={
          video.data
            ? `${fmtT(duration)} · ${settings?.width}×${settings?.height}@${settings?.fps} · rev ${video.data.revision}${editor.state.dirty ? ' · unsaved' : ''}${editor.state.saving ? ' · saving…' : ''}`
            : 'Pick a project to start editing'
        }
        actions={
          <>
            <NativeSelect value={projectId || ''} onChange={(e) => setProjectId(e.target.value)} className="h-8 w-44 text-xs">
              {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </NativeSelect>
            <NativeSelect value={videoId || ''} onChange={(e) => e.target.value && navigate(`/video/${e.target.value}`)} className="h-8 w-44 text-xs">
              <option value="">— timeline —</option>
              {videos.data?.map((v) => <option key={v.id} value={v.id}>{v.name} (rev {v.revision})</option>)}
            </NativeSelect>
            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
              <DialogTrigger asChild>
                <Button size="sm" variant="secondary" disabled={!projectId}><Plus size={13} /> New timeline</Button>
              </DialogTrigger>
              <DialogContent title="New video timeline" description="Auto-builds tracks from detected scenes and generated narration audio.">
                <Field label="Name"><Input value={createName} onChange={(e) => setCreateName(e.target.value)} /></Field>
                <DialogFooter>
                  <Button
                    onClick={async () => {
                      if (!projectId) return;
                      const v = await videoApi.create({ mangaProjectId: projectId, name: createName });
                      setCreateOpen(false);
                      navigate(`/video/${v.id}`);
                    }}
                  >Create & auto-build</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        }
      />

      {!video.data ? (
        <LoadingState label="No timeline yet — create one" />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)_260px]">
          {/* versions / info rail */}
          <div className="flex min-h-0 flex-col border-r border-line bg-panel">
            <div className="panel-header"><span>Project</span></div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-xs">
              <div className="flex items-center gap-1">
                <Input value={versionLabel} onChange={(e) => setVersionLabel(e.target.value)} placeholder="Version label" className="h-7 text-xs" />
                <Button size="sm" variant="secondary" className="h-7 px-2" onClick={saveVersion} disabled={!versionLabel.trim()}><Save size={12} /></Button>
              </div>
              <div className="space-y-1">
                {video.data.versions.slice().reverse().map((v) => (
                  <button
                    key={v.index}
                    className="flex w-full items-center gap-1.5 rounded border border-line px-2 py-1 text-left hover:bg-panel-2"
                    onClick={async () => {
                      await videoApi.restore(videoId!, v.index);
                      toast.success(`Restored “${v.label}”`);
                      video.refetch();
                    }}
                  >
                    <History size={11} className="shrink-0 text-muted" />
                    <span className="min-w-0 flex-1 truncate">{v.label}</span>
                    <span className="text-[9px] text-muted">r{v.revision}</span>
                  </button>
                ))}
                {!video.data.versions.length && <p className="text-muted">No saved versions.</p>}
              </div>
              <div className="rounded border border-line p-2 text-[10px] leading-relaxed text-muted">
                <p>Language: {video.data.language} · {video.data.mode}</p>
                <p>Layout: {video.data.settings.layout}</p>
                <p>Output: {video.data.renderStatus}{video.data.outputUrl && <> · <a className="text-accent underline" href={video.data.outputUrl} target="_blank">MP4</a></>}</p>
              </div>
            </div>
          </div>

          {/* center: preview + timeline */}
          <div className="flex min-h-0 min-w-0 flex-col">
            <div className="flex min-h-0 flex-1 items-center justify-center bg-black p-2">
              <Player
                ref={playerRef}
                component={StudioComposition}
                inputProps={{ tracks, settings: settings! }}
                durationInFrames={Math.max(1, Math.round(duration * settings!.fps))}
                compositionWidth={settings!.width}
                compositionHeight={settings!.height}
                fps={settings!.fps}
                controls
                style={{ maxHeight: '100%', maxWidth: '100%', aspectRatio: `${settings!.width}/${settings!.height}` }}
                doubleClickToFullscreen
              />
            </div>

            {/* timeline toolbar */}
            <div className="flex h-9 items-center gap-1 border-y border-line bg-panel px-2">
              <Button size="sm" variant="ghost" className="h-7 px-1.5" onClick={editor.undo} disabled={!editor.state.canUndo} title="Undo (Ctrl+Z)"><Undo2 size={14} /></Button>
              <Button size="sm" variant="ghost" className="h-7 px-1.5" onClick={editor.redo} disabled={!editor.state.canRedo} title="Redo"><Redo2 size={14} /></Button>
              <span className="mx-1 h-4 w-px bg-line" />
              <Button size="sm" variant="ghost" className="h-7 px-1.5" onClick={doSplit} title="Split clip at playhead (S)"><Scissors size={14} /></Button>
              <Button size="sm" variant="ghost" className="h-7 px-1.5" onClick={doMerge} title="Merge adjacent selected clips"><Merge size={14} /></Button>
              <Button size="sm" variant="ghost" className="h-7 px-1.5" onClick={doDelete} title="Delete selected (Del)"><Trash2 size={14} /></Button>
              <span className="mx-1 h-4 w-px bg-line" />
              <Button size="sm" variant="ghost" className="h-7 px-1.5" onClick={() => setPxPerSec((z) => Math.max(8, z / 1.5))}><ZoomOut size={14} /></Button>
              <Button size="sm" variant="ghost" className="h-7 px-1.5" onClick={() => setPxPerSec((z) => Math.min(400, z * 1.5))}><ZoomIn size={14} /></Button>
              <span className="mx-1 h-4 w-px bg-line" />
              <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" onClick={() => videoApi.addTrack(videoId!, 'overlay', 'Overlay').then(() => video.refetch())}><Plus size={13} /> Track</Button>
              <Button
                size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs"
                onClick={async () => {
                  await videoApi.rebuild(videoId!);
                  toast.success('Timeline rebuilt from scenes + audio');
                  video.refetch();
                }}
                title="Regenerate tracks from scenes and narration"
              ><RefreshCw size={13} /> Rebuild</Button>
              <Button
                size="sm" variant="secondary" className="h-7 gap-1 px-2 text-xs"
                disabled={rendering}
                onClick={async () => {
                  try {
                    await editor.flush();
                    await videoApi.render(videoId!);
                    toast.success('Render queued — progress in Render Manager');
                    video.refetch();
                  } catch (e) { toast.error(e instanceof Error ? e.message : 'Render failed to start'); }
                }}
                title="Render final MP4 (Remotion + FFmpeg)"
              ><Clapperboard size={13} /> {rendering ? 'Rendering…' : 'Render MP4'}</Button>
              <span className="ml-auto font-mono text-[10px] text-muted">{fmtT(playhead)} / {fmtT(duration)}</span>
            </div>

            <div className="h-56 min-h-0 border-t border-line">
              <TimelinePanel
                tracks={tracks}
                duration={duration}
                pxPerSec={pxPerSec}
                playhead={seekTarget ?? playhead}
                selected={selected}
                onSelect={(ids) => setSelected(ids)}
                onSeek={seek}
                onClipChange={(clip, fn) => editor.mutate((t) => { const ref = findClipRef(t, clip.id); if (ref) fn(ref.clip, t); })}
                onTrackToggle={(id, field, value) => editor.mutate((t) => { const tr = t.find((x) => x.id === id); if (tr) tr[field] = value; })}
                onClipContext={(clipId, x, y) => { selectClip(clipId, false); setMenu({ clipId, x, y }); }}
              />
            </div>
          </div>

          {/* right: inspector */}
          <div className="min-h-0 overflow-y-auto border-l border-line bg-panel">
            <div className="panel-header"><span>Clip</span><GitBranch size={12} className="text-muted" /></div>
            <ClipInspector
              clip={selectedClip}
              onChange={(fn) => {
                if (!selectedClip) return;
                editor.mutate((t) => { const ref = findClipRef(t, selectedClip.id); if (ref) fn(ref.clip); });
              }}
            />
          </div>
        </div>
      )}

      {/* clip context menu */}
      {menu && (
        <div className="fixed z-50 w-44 rounded border border-line bg-panel-2 py-1 text-xs shadow-xl" style={{ left: menu.x, top: menu.y }}>
          <button className="block w-full px-3 py-1.5 text-left hover:bg-panel-3" onClick={() => { doSplit(); setMenu(null); }}><Scissors size={11} className="mr-2 inline" />Split at playhead</button>
          <button className="block w-full px-3 py-1.5 text-left hover:bg-panel-3" onClick={() => { selectClip(menu.clipId, false); doDelete(); setMenu(null); }}><Trash2 size={11} className="mr-2 inline" />Delete</button>
          <button
            className="block w-full px-3 py-1.5 text-left hover:bg-panel-3"
            onClick={() => {
              const ref = findClipRef(tracks, menu.clipId);
              const next = ref && [...ref.track.clips].sort((a, b) => a.start - b.start);
              const i = next?.findIndex((c) => c.id === menu.clipId) ?? -1;
              if (next && i >= 0 && i + 1 < next.length) setSelected([menu.clipId, next[i + 1].id]);
              setMenu(null);
            }}
          ><Merge size={11} className="mr-2 inline" />Select with next</button>
        </div>
      )}
    </div>
  );
};

