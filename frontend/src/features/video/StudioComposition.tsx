import { AbsoluteFill, Audio, Sequence, useCurrentFrame } from 'remotion';
import type { Keyframe, TimelineClip, TimelineTrack, VideoSettings } from '@/lib/types';

export interface StudioCompositionProps {
  tracks: TimelineTrack[];
  settings: VideoSettings;
}

const ease = (t: number, easing: Keyframe['easing']) => {
  const c = Math.min(1, Math.max(0, t));
  switch (easing) {
    case 'ease-in': return c * c;
    case 'ease-out': return 1 - (1 - c) * (1 - c);
    case 'ease-in-out': return c < 0.5 ? 2 * c * c : 1 - Math.pow(-2 * c + 2, 2) / 2;
    default: return c;
  }
};

/** Default keyframes for the preset animation types (normalized 0..1 time). */
const presetKeys = (type: string): Keyframe[] => {
  switch (type) {
    case 'zoom-in': return [{ at: 0, scale: 1, x: 0, y: 0, easing: 'ease-out' }, { at: 1, scale: 1.15, x: 0, y: 0, easing: 'linear' }];
    case 'zoom-out': return [{ at: 0, scale: 1.15, x: 0, y: 0, easing: 'ease-out' }, { at: 1, scale: 1, x: 0, y: 0, easing: 'linear' }];
    case 'pan-left': return [{ at: 0, scale: 1.12, x: 30, y: 0, easing: 'linear' }, { at: 1, scale: 1.12, x: -30, y: 0, easing: 'linear' }];
    case 'pan-right': return [{ at: 0, scale: 1.12, x: -30, y: 0, easing: 'linear' }, { at: 1, scale: 1.12, x: 30, y: 0, easing: 'linear' }];
    case 'pan-up': return [{ at: 0, scale: 1.12, x: 0, y: 40, easing: 'linear' }, { at: 1, scale: 1.12, x: 0, y: -40, easing: 'linear' }];
    case 'pan-down': return [{ at: 0, scale: 1.12, x: 0, y: -40, easing: 'linear' }, { at: 1, scale: 1.12, x: 0, y: 40, easing: 'linear' }];
    case 'ken-burns': return [{ at: 0, scale: 1, x: -12, y: 8, easing: 'ease-in-out' }, { at: 1, scale: 1.14, x: 12, y: -8, easing: 'linear' }];
    default: return [{ at: 0, scale: 1, x: 0, y: 0, easing: 'linear' }, { at: 1, scale: 1, x: 0, y: 0, easing: 'linear' }];
  }
};

/** Interpolate clip animation at local progress 0..1. Keyframe `at` is normalized fraction of clip duration. */
const animAt = (clip: TimelineClip, p: number) => {
  const keys = clip.animation.type === 'custom' ? clip.animation.keyframes : presetKeys(clip.animation.type);
  if (!keys.length) return { scale: 1, x: 0, y: 0 };
  const sorted = [...keys].sort((a, b) => a.at - b.at);
  if (p <= sorted[0].at) return sorted[0];
  if (p >= sorted[sorted.length - 1].at) return sorted[sorted.length - 1];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1];
    if (p >= a.at && p <= b.at) {
      const t = ease((p - a.at) / Math.max(0.0001, b.at - a.at), a.easing);
      return {
        scale: a.scale + (b.scale - a.scale) * t,
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        opacity: a.opacity === undefined && b.opacity === undefined ? 1 : (a.opacity ?? 1) + ((b.opacity ?? 1) - (a.opacity ?? 1)) * t,
      };
    }
  }
  return sorted[0];
};

const transitionOpacity = (clip: TimelineClip, local: number) => {
  let o = 1;
  if (['fade', 'crossfade', 'zoom'].includes(clip.transitionIn.type) && clip.transitionIn.duration > 0)
    o *= Math.min(1, local / clip.transitionIn.duration);
  if (['fade', 'crossfade'].includes(clip.transitionOut.type) && clip.transitionOut.duration > 0)
    o *= Math.min(1, (clip.duration - local) / clip.transitionOut.duration);
  return Math.max(0, Math.min(1, o));
};

const ImageClip = ({ clip, settings }: { clip: TimelineClip; settings: VideoSettings }) => {
  const frame = useCurrentFrame();
  const fps = settings.fps;
  const local = frame / fps; // seconds within clip
  const p = Math.min(1, Math.max(0, local / clip.duration));
  const a = animAt(clip, p);
  const opacity = transitionOpacity(clip, local) * (a.opacity ?? 1);
  const url = clip.media?.imageUrl;
  if (!url) return <AbsoluteFill style={{ background: '#0b0b10' }} />;
  return (
    <AbsoluteFill style={{ opacity }}>
      {clip.backdrop ? (
        <AbsoluteFill>
          <img
            src={url}
            style={{
              width: '100%', height: '100%', objectFit: 'cover',
              filter: `blur(${settings.bgBlur}px) brightness(${1 - settings.bgDim}) saturate(1.1)`,
              transform: 'scale(1.15)',
            }}
          />
        </AbsoluteFill>
      ) : (
        <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', overflow: 'hidden' }}>
          <img
            src={url}
            style={{
              maxWidth: '100%', maxHeight: '100%',
              objectFit: settings.layout === 'fill' ? 'cover' : 'contain',
              transform: `translate(${a.x}px, ${a.y}px) scale(${a.scale})`,
            }}
          />
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};

const SubtitleClip = ({ clip }: { clip: TimelineClip }) => (
  <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', pointerEvents: 'none' }}>
    <div
      style={{
        maxWidth: '80%', marginBottom: 48, padding: '8px 18px',
        background: 'rgba(0,0,0,0.72)', borderRadius: 8,
        color: '#fff', fontSize: 34, lineHeight: 1.4, textAlign: 'center',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      {clip.text}
    </div>
  </AbsoluteFill>
);

/** Remotion composition rendering the studio timeline: backdrop, scenes, audio, subtitles. */
export const StudioComposition = ({ tracks, settings }: StudioCompositionProps) => {
  const fps = settings.fps;
  return (
    <AbsoluteFill style={{ background: '#000' }}>
      {[...tracks]
        .sort((a, b) => a.order - b.order)
        .filter((t) => !t.muted)
        .map((track) =>
          track.clips.map((clip) => {
            const from = Math.round(clip.start * fps);
            const dur = Math.max(1, Math.round(clip.duration * fps));
            if (clip.kind === 'image' && clip.media?.imageUrl)
              return (
                <Sequence key={clip.id} from={from} durationInFrames={dur} layout="none">
                  <ImageClip clip={clip} settings={settings} />
                </Sequence>
              );
            if (clip.kind === 'audio' && clip.media?.audioUrl)
              return (
                <Sequence key={clip.id} from={from} durationInFrames={dur} layout="none">
                  <Audio src={clip.media.audioUrl} startFrom={Math.round(clip.mediaStart * fps)} volume={clip.muted ? 0 : clip.gain} />
                </Sequence>
              );
            if (clip.kind === 'text' && clip.text)
              return (
                <Sequence key={clip.id} from={from} durationInFrames={dur} layout="none">
                  <SubtitleClip clip={clip} />
                </Sequence>
              );
            return null;
          })
        )}
    </AbsoluteFill>
  );
};
