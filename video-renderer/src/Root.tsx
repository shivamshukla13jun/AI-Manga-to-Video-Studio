import { Composition } from 'remotion';
import { StudioComp, StudioCompProps } from './StudioComp';

export const RemotionRoot = () => (
  <Composition
    id="studio"
    component={StudioComp as any}
    durationInFrames={1}
    fps={30}
    width={1920}
    height={1080}
    defaultProps={{ tracks: [], settings: { fps: 30, width: 1920, height: 1080, layout: 'blur-fill', bgBlur: 40, bgDim: 0.55 } } as unknown as StudioCompProps}
    calculateMetadata={({ props }) => {
      const fps = props.settings.fps || 30;
      const duration = Math.max(1, ...props.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)));
      return {
        durationInFrames: Math.max(1, Math.round(duration * fps)),
        fps,
        width: props.settings.width,
        height: props.settings.height,
      };
    }}
  />
);
