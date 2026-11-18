import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import config from 'config/env';
import logger from 'utils/logger';

const execFileP = promisify(execFile);

export interface RenderClipMedia {
  id: string; kind: string;
  start: number; duration: number; mediaStart: number; gain: number; muted: boolean;
  text?: string; backdrop?: boolean;
  animation: { type: string; keyframes: any[] };
  transitionIn: { type: string; duration: number };
  transitionOut: { type: string; duration: number };
  media?: { imageUrl?: string; audioUrl?: string };
}
export interface RenderProps {
  tracks: { id: string; kind: string; muted: boolean; order: number; clips: RenderClipMedia[] }[];
  settings: { width: number; height: number; fps: number; layout: string; bgBlur: number; bgDim: number };
}

let cachedBundle: Promise<string> | null = null;
const bundleDir = () => {
  const dir = path.resolve(config.RENDERER_DIR, 'src', 'entry.tsx');
  if (!fs.existsSync(dir)) throw new Error(`Remotion entry not found at ${dir} — is RENDERER_DIR correct?`);
  return dir;
};

/** Bundles the Remotion entry once per process (~seconds) and caches the serve URL. */
export const getBundle = async (): Promise<string> => {
  if (!cachedBundle) {
    cachedBundle = (async () => {
      const { bundle } = await import('@remotion/bundler');
      logger.info('Bundling Remotion composition…');
      const out = await bundle({ entryPoint: bundleDir(), onProgress: (p: number) => p === 100 && logger.info('Remotion bundle ready') });
      return out;
    })();
  }
  return cachedBundle;
};

const ffargs = async (args: string[], label: string) => {
  try {
    const { stderr } = await execFileP(config.FFMPEG_PATH as string, args, { maxBuffer: 64 * 1024 * 1024 });
    return stderr;
  } catch (e: any) {
    throw new Error(`ffmpeg ${label} failed: ${e.message}\n${e.stderr?.slice(-2000) || ''}`);
  }
};

const fileOk = (p: string) => fs.existsSync(p) && fs.statSync(p).size > 0;

/**
 * Renders the timeline in fixed-length video-only segments (checkpoints).
 * Existing non-empty segment files are skipped — safe resume after failure.
 * Returns the ordered list of segment file paths.
 */
export const renderSegments = async (
  props: RenderProps,
  outDir: string,
  onProgress: (fraction: number, stage: string) => Promise<void>,
  throwIfCancelled: () => void
): Promise<string[]> => {
  const { selectComposition, renderMedia, makeCancelSignal } = await import('@remotion/renderer');
  const serveUrl = await getBundle();
  const composition = await selectComposition({ serveUrl, id: 'studio', inputProps: props as any, ...(browserOpts() as any) });
  const total = composition.durationInFrames;
  const fps = composition.fps;
  const segFrames = Math.max(fps, Math.round((config.RENDER_SEGMENT_SECONDS as number) * fps));
  const count = Math.ceil(total / segFrames);
  fs.mkdirSync(outDir, { recursive: true });

  const { cancelSignal, cancel } = makeCancelSignal();
  const files: string[] = [];
  for (let i = 0; i < count; i++) {
    throwIfCancelled();
    const from = i * segFrames;
    const to = Math.min(total - 1, from + segFrames - 1);
    const file = path.join(outDir, `seg-${String(i).padStart(4, '0')}.mp4`);
    files.push(file);
    if (fileOk(file)) {
      await onProgress((i + 1) / count, `segment ${i + 1}/${count} (checkpoint)`);
      continue;
    }
    let frame = 0;
    await renderMedia({
      composition,
      serveUrl,
      codec: 'h264',
      audioCodec: null,
      outputLocation: file,
      inputProps: props as any,
      frameRange: [from, to],
      cancelSignal,
      ...(browserOpts() as any),
      onProgress: ({ renderedFrames }: { renderedFrames: number }) => {
        frame = renderedFrames;
        throwIfCancelled();
      },
    } as any);
    await onProgress((i + 1) / count, `segment ${i + 1}/${count} (${frame} frames)`);
  }
  void cancel;
  return files;
};

const browserOpts = () => (config.RENDER_BROWSER_EXECUTABLE ? { browserExecutable: config.RENDER_BROWSER_EXECUTABLE } : {});

/** Concat segments (identical codec params → stream copy, re-encode fallback). */
export const concatSegments = async (segments: string[], outFile: string) => {
  const list = path.join(path.dirname(outFile), 'concat.txt');
  fs.writeFileSync(list, segments.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
  try {
    await ffargs(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', outFile], 'concat');
  } catch {
    await ffargs(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'fast', '-crf', '18', outFile], 'concat-encode');
  }
  if (!fileOk(outFile)) throw new Error('ffmpeg concat produced no output');
};

/** Mix every audio clip at its timeline offset, then mux with the silent video → mp4. */
export const muxWithAudio = async (
  videoFile: string,
  audioClips: { url: string; start: number; mediaStart: number; duration: number; gain: number }[],
  outFile: string,
  durationSec: number
) => {
  if (!audioClips.length) {
    await ffargs(['-y', '-i', videoFile, '-c:v', 'copy', '-t', String(durationSec), outFile], 'mux');
    return;
  }
  const args: string[] = ['-y', '-i', videoFile];
  const filters: string[] = [];
  const outs: string[] = [];
  audioClips.forEach((c, i) => {
    args.push('-ss', String(c.mediaStart), '-t', String(c.duration + 0.25), '-i', c.url);
    const label = `a${i}`;
    filters.push(
      `[${i + 1}:a]aresample=48000,volume=${Math.max(0, c.gain).toFixed(3)},atrim=0:${c.duration + 0.25},adelay=${Math.round(c.start * 1000)}|${Math.round(c.start * 1000)}[${label}]`
    );
    outs.push(`[${label}]`);
  });
  filters.push(`${outs.join('')}amix=inputs=${outs.length}:normalize=0:duration=longest,atrim=0:${durationSec}[aout]`);
  args.push('-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', String(durationSec), '-movflags', '+faststart', outFile);
  await ffargs(args, 'mux');
  if (!fileOk(outFile)) throw new Error('ffmpeg mux produced no output');
};
