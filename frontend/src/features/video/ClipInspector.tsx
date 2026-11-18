import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label, NativeSelect } from '@/components/ui/input';
import type { AnimationType, Keyframe, TimelineClip, VideoTransition } from '@/lib/types';

const ANIMS: AnimationType[] = ['none', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down', 'ken-burns', 'custom'];
const TRANS: VideoTransition['type'][] = ['none', 'fade', 'crossfade', 'slide-left', 'slide-right', 'zoom', 'wipe'];

interface Props {
  clip: TimelineClip | undefined;
  onChange: (fn: (c: TimelineClip) => void) => void;
}

const Num = ({ label, value, step = 0.1, on }: { label: string; value: number; step?: number; on: (v: number) => void }) => (
  <div>
    <Label className="text-[10px]">{label}</Label>
    <Input type="number" step={step} value={Math.round(value * 100) / 100} onChange={(e) => on(Number(e.target.value) || 0)} className="h-7 text-xs" />
  </div>
);

export const ClipInspector = ({ clip, onChange }: Props) => {
  if (!clip)
    return <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted">Select a clip on the timeline to edit its animation, transitions and timing.</div>;

  const set = <K extends keyof TimelineClip>(k: K, v: TimelineClip[K]) => onChange((c) => void (c[k] = v));

  return (
    <div className="space-y-4 p-3 text-xs">
      <div>
        <Label className="text-[10px]">Name</Label>
        <Input value={clip.name || ''} onChange={(e) => set('name', e.target.value)} className="h-7 text-xs" />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Num label="Start (s)" value={clip.start} on={(v) => set('start', Math.max(0, v))} />
        <Num label="Duration (s)" value={clip.duration} on={(v) => set('duration', Math.max(0.1, v))} />
        <Num label="Media in (s)" value={clip.mediaStart} on={(v) => set('mediaStart', Math.max(0, v))} />
      </div>
      {clip.kind === 'audio' && (
        <div className="grid grid-cols-2 gap-2">
          <Num label="Gain" value={clip.gain} step={0.05} on={(v) => set('gain', Math.max(0, Math.min(4, v)))} />
          <label className="mt-4 flex items-center gap-2">
            <input type="checkbox" checked={clip.muted} onChange={(e) => set('muted', e.target.checked)} /> Muted
          </label>
        </div>
      )}
      {clip.kind === 'image' && (
        <>
          <div>
            <Label className="text-[10px]">Animation</Label>
            <NativeSelect value={clip.animation.type} onChange={(e) => set('animation', { ...clip.animation, type: e.target.value as AnimationType })} className="h-7 text-xs">
              {ANIMS.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-[10px]">Transition in</Label>
              <NativeSelect value={clip.transitionIn.type} onChange={(e) => set('transitionIn', { ...clip.transitionIn, type: e.target.value as VideoTransition['type'] })} className="h-7 text-xs">
                {TRANS.map((t) => <option key={t} value={t}>{t}</option>)}
              </NativeSelect>
              <Num label="sec" value={clip.transitionIn.duration} on={(v) => set('transitionIn', { ...clip.transitionIn, duration: Math.max(0, Math.min(5, v)) })} />
            </div>
            <div>
              <Label className="text-[10px]">Transition out</Label>
              <NativeSelect value={clip.transitionOut.type} onChange={(e) => set('transitionOut', { ...clip.transitionOut, type: e.target.value as VideoTransition['type'] })} className="h-7 text-xs">
                {TRANS.map((t) => <option key={t} value={t}>{t}</option>)}
              </NativeSelect>
              <Num label="sec" value={clip.transitionOut.duration} on={(v) => set('transitionOut', { ...clip.transitionOut, duration: Math.max(0, Math.min(5, v)) })} />
            </div>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <Label className="text-[10px]">Keyframes {clip.animation.type !== 'custom' && <span className="text-muted">(custom type only)</span>}</Label>
              <Button
                size="sm" variant="ghost" className="h-6 px-1.5 text-[10px]"
                disabled={clip.animation.type !== 'custom'}
                onClick={() =>
                  onChange((c) => {
                    c.animation.keyframes.push({ at: 0.5, scale: 1.1, x: 0, y: 0, easing: 'linear' } as Keyframe);
                    c.animation.keyframes.sort((a, b) => a.at - b.at);
                  })
                }
              >
                <Plus size={11} /> Add
              </Button>
            </div>
            {clip.animation.type === 'custom' &&
              clip.animation.keyframes.map((k, i) => (
                <div key={i} className="mb-1 grid grid-cols-5 items-end gap-1 rounded border border-line/60 p-1">
                  <Num label="at" value={k.at} step={0.05} on={(v) => onChange((c) => void (c.animation.keyframes[i].at = Math.min(1, Math.max(0, v))))} />
                  <Num label="scale" value={k.scale} on={(v) => onChange((c) => void (c.animation.keyframes[i].scale = v))} />
                  <Num label="x" value={k.x} step={1} on={(v) => onChange((c) => void (c.animation.keyframes[i].x = v))} />
                  <Num label="y" value={k.y} step={1} on={(v) => onChange((c) => void (c.animation.keyframes[i].y = v))} />
                  <Button size="sm" variant="ghost" className="h-6 px-1" onClick={() => onChange((c) => void c.animation.keyframes.splice(i, 1))}>
                    <Trash2 size={11} />
                  </Button>
                </div>
              ))}
          </div>
        </>
      )}
      {clip.kind === 'text' && (
        <div>
          <Label className="text-[10px]">Text</Label>
          <textarea
            value={clip.text || ''}
            onChange={(e) => set('text', e.target.value)}
            rows={4}
            className="w-full rounded border border-line bg-panel-2 p-2 text-xs"
          />
        </div>
      )}
      <div className="rounded border border-line/60 p-2 text-[10px] text-muted">
        kind: {clip.kind} {clip.scene && <>· scene linked</>} {clip.media?.broken && <span className="text-amber-400">· source image broken</span>}
      </div>
    </div>
  );
};
