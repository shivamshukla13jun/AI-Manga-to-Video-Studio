import { useRef, useState, type PointerEvent } from 'react';
import { Lock, LockOpen, Music, Type, Volume2, VolumeX, Image as ImageIcon, Layers, Film } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TimelineClip, TimelineTrack, TrackKind } from '@/lib/types';
import { findClipRef } from './useTimelineEditor';

const TRACK_COLORS: Record<TrackKind, string> = {
  background: '#1f2937',
  image: '#2563eb',
  narration: '#16a34a',
  music: '#7c3aed',
  sfx: '#d97706',
  subtitle: '#0e7490',
  overlay: '#be185d',
};

const trackIcon = (k: TrackKind) =>
  k === 'narration' || k === 'music' || k === 'sfx' ? <Volume2 size={11} /> : k === 'subtitle' ? <Type size={11} /> : k === 'background' ? <Layers size={11} /> : k === 'image' ? <ImageIcon size={11} /> : <Film size={11} />;

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}.${Math.floor((s % 1) * 10)}`;
};

interface DragState {
  clipId: string;
  mode: 'move' | 'trim-l' | 'trim-r';
  startX: number;
  startY: number;
  origStart: number;
  origDur: number;
  origMediaStart: number;
  trackIdx: number;
}

interface Props {
  tracks: TimelineTrack[];
  duration: number;
  pxPerSec: number;
  playhead: number;
  selected: string[];
  onSelect: (ids: string[]) => void;
  onSeek: (t: number) => void;
  onClipChange: (clip: TimelineClip, fn: (c: TimelineClip, tracks: TimelineTrack[]) => void) => void;
  onTrackToggle: (trackId: string, field: 'muted' | 'locked', value: boolean) => void;
  onClipContext: (clipId: string, x: number, y: number) => void;
}

const Waveform = ({ peaks, color }: { peaks: number[]; color: string }) => {
  const w = 100;
  return (
    <svg viewBox={`0 0 ${w} 20`} preserveAspectRatio="none" className="h-full w-full opacity-60">
      {peaks.slice(0, 200).map((p, i) => (
        <rect key={i} x={(i / peaks.length) * w} y={10 - p * 9} width={Math.max(0.3, w / peaks.length - 0.15)} height={Math.max(0.5, p * 18)} fill={color} />
      ))}
    </svg>
  );
};

export const TimelinePanel = ({ tracks, duration, pxPerSec, playhead, selected, onSelect, onSeek, onClipChange, onTrackToggle, onClipContext }: Props) => {
  const [drag, setDrag] = useState<DragState | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const width = Math.max(duration + 20, 60) * pxPerSec;

  const rulerClick = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    onSeek(Math.max(0, (e.clientX - rect.left + (scrollRef.current?.scrollLeft ?? 0)) / pxPerSec));
  };

  const clipDown = (e: PointerEvent, clip: TimelineClip, trackIdx: number) => {
    if (e.button !== 0) return;
    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const mode: DragState['mode'] = x < 7 ? 'trim-l' : x > rect.width - 7 ? 'trim-r' : 'move';
    target.setPointerCapture(e.pointerId);
    setDrag({ clipId: clip.id, mode, startX: e.clientX, startY: e.clientY, origStart: clip.start, origDur: clip.duration, origMediaStart: clip.mediaStart, trackIdx });
    if (!selected.includes(clip.id)) onSelect([clip.id]);
  };

  const clipMove = (e: PointerEvent, clip: TimelineClip) => {
    if (!drag || drag.clipId !== clip.id) return;
    const dt = (e.clientX - drag.startX) / pxPerSec;
    const dTrack = Math.round((e.clientY - drag.startY) / 44);
    onClipChange(clip, (c, t) => {
      if (drag.mode === 'move') {
        c.start = Math.max(0, drag.origStart + dt);
        if (dTrack !== 0) {
          const ref = findClipRef(t, c.id);
          const target = t[Math.min(t.length - 1, Math.max(0, drag.trackIdx + dTrack))];
          if (ref && target && target.kind === ref.track.kind && target.id !== ref.track.id && !target.locked) {
            ref.track.clips = ref.track.clips.filter((x) => x.id !== c.id);
            target.clips.push(c);
          }
        }
      } else if (drag.mode === 'trim-r') {
        c.duration = Math.max(0.1, drag.origDur + dt);
      } else {
        const delta = Math.min(drag.origDur - 0.1, Math.max(-drag.origStart, dt));
        c.start = drag.origStart + delta;
        c.duration = drag.origDur - delta;
        c.mediaStart = Math.max(0, drag.origMediaStart + delta);
      }
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* track headers + lanes */}
      <div className="flex min-h-0 flex-1">
        <div className="w-40 shrink-0 border-r border-line bg-panel pt-6">
          {tracks.map((t) => (
            <div key={t.id} className="flex h-11 items-center gap-1.5 border-b border-line/50 px-2">
              <span style={{ color: TRACK_COLORS[t.kind] }}>{trackIcon(t.kind)}</span>
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{t.name}</span>
              <button className="rounded p-0.5 text-muted hover:text-foreground" onClick={() => onTrackToggle(t.id, 'muted', !t.muted)} title={t.muted ? 'Unmute' : 'Mute'}>
                {t.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
              </button>
              <button className="rounded p-0.5 text-muted hover:text-foreground" onClick={() => onTrackToggle(t.id, 'locked', !t.locked)} title={t.locked ? 'Unlock' : 'Lock'}>
                {t.locked ? <Lock size={12} /> : <LockOpen size={12} />}
              </button>
              {t.kind === 'music' && <Music size={10} className="text-muted" />}
            </div>
          ))}
        </div>

        <div ref={scrollRef} className="min-w-0 flex-1 overflow-auto bg-[#0a0a0e]" onScroll={() => {}}>
          <div style={{ width }} className="relative">
            {/* ruler */}
            <div className="sticky top-0 z-20 h-6 cursor-text border-b border-line bg-panel" onPointerDown={rulerClick}>
              {Array.from({ length: Math.ceil(width / (pxPerSec * (pxPerSec < 30 ? 10 : 5))) }).map((_, i) => {
                const sec = i * (pxPerSec < 30 ? 10 : 5);
                return (
                  <div key={i} className="absolute top-0 h-full border-l border-line/60 pl-1 text-[9px] text-muted" style={{ left: sec * pxPerSec }}>
                    {fmt(sec)}
                  </div>
                );
              })}
            </div>
            {/* lanes */}
            {tracks.map((t, ti) => (
              <div key={t.id} className={cn('relative h-11 border-b border-line/50', t.muted && 'opacity-50')}>
                {[...t.clips]
                  .sort((a, b) => a.start - b.start)
                  .map((clip) => (
                    <div
                      key={clip.id}
                      onPointerDown={(e) => clipDown(e, clip, ti)}
                      onPointerMove={(e) => clipMove(e, clip)}
                      onPointerUp={() => setDrag(null)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        onClipContext(clip.id, e.clientX, e.clientY);
                      }}
                      className={cn(
                        'absolute top-0.5 h-10 cursor-grab overflow-hidden rounded-sm border text-[10px] leading-10',
                        selected.includes(clip.id) ? 'border-white ring-1 ring-white/70' : 'border-black/40',
                        t.locked && 'pointer-events-none'
                      )}
                      style={{
                        left: clip.start * pxPerSec,
                        width: Math.max(6, clip.duration * pxPerSec),
                        background: TRACK_COLORS[t.kind],
                        opacity: clip.muted ? 0.4 : 0.92,
                      }}
                      title={clip.name || clip.kind}
                    >
                      {clip.kind === 'audio' && clip.media?.waveform?.peaks?.length ? (
                        <Waveform peaks={clip.media.waveform.peaks} color="#fff" />
                      ) : (
                        <span className="block truncate px-1.5 text-white/95">
                          {clip.backdrop ? '⬚ ' : ''}
                          {clip.name || clip.kind}
                          {clip.media?.broken ? ' ⚠' : ''}
                        </span>
                      )}
                    </div>
                  ))}
              </div>
            ))}
            {/* playhead */}
            <div className="pointer-events-none absolute top-0 bottom-0 z-10 w-px bg-red-500" style={{ left: playhead * pxPerSec }}>
              <div className="h-2.5 w-2.5 -translate-x-1/2 rounded-b-sm bg-red-500" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
