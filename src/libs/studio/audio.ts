import { execFile } from 'child_process';
import config from 'config/env';

/** Run a media tool with a safe argument array (no shell). */
export const runProcess = (bin: string, args: string[]): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${path_basename(bin)} exited ${error.code}: ${stderr.slice(-400) || error.message}`));
      else resolve({ stdout, stderr });
    });
  });

const path_basename = (p: string) => p.split(/[\\/]/).pop() || p;

/** ffprobe duration in seconds. */
export const audioDuration = async (localPath: string): Promise<number | undefined> => {
  try {
    const { stdout } = await runProcess(config.FFPROBE_PATH as string, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', localPath,
    ]);
    const d = parseFloat(stdout.trim());
    return Number.isFinite(d) ? d : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Decode audio to mono s16le PCM through ffmpeg and reduce it to a fixed
 * number of peak amplitudes for waveform display. ~960 peaks.
 */
export const waveformPeaks = async (localPath: string, buckets = 960): Promise<{ peaks: number[]; duration: number; sampleRate: number } | undefined> => {
  const sampleRate = 8000;
  try {
    const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
      execFile(
        config.FFMPEG_PATH as string,
        ['-v', 'error', '-i', localPath, '-ac', '1', '-ar', String(sampleRate), '-f', 's16le', '-'],
        { timeout: 120_000, maxBuffer: 512 * 1024 * 1024, encoding: 'buffer' as any },
        (error, stdout: any) => (error ? reject(error) : resolve({ stdout }))
      );
    });
    const pcm = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout as any, 'binary');
    const frames = Math.floor(pcm.length / 2);
    if (!frames) return undefined;
    const per = Math.max(1, Math.floor(frames / buckets));
    const peaks: number[] = [];
    for (let i = 0; i < frames; i += per) {
      let max = 0;
      const end = Math.min(frames, i + per);
      for (let j = i; j < end; j++) {
        const v = Math.abs(pcm.readInt16LE(j * 2)) / 32768;
        if (v > max) max = v;
      }
      peaks.push(Math.round(max * 1000) / 1000);
    }
    return { peaks, duration: frames / sampleRate, sampleRate };
  } catch {
    return undefined;
  }
};
