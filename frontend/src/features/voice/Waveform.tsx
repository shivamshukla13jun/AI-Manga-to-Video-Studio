import { useEffect, useRef } from 'react';

/** Renders stored peak data as a compact waveform strip. */
export const Waveform = ({ peaks, progress = 0, className }: { peaks: number[]; progress?: number; className?: string }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth * dpr;
    const h = c.clientHeight * dpr;
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    const n = peaks.length;
    if (!n) return;
    const played = Math.floor(n * progress);
    const mid = h / 2;
    for (let i = 0; i < n; i++) {
      const x = (i / n) * w;
      const bh = Math.max(1, peaks[i] * (h - 2));
      ctx.fillStyle = i <= played ? '#4f8ff7' : '#3a4152';
      ctx.fillRect(x, mid - bh / 2, Math.max(1, w / n - 0.5), bh);
    }
  }, [peaks, progress]);
  return <canvas ref={ref} className={className || 'h-10 w-full'} />;
};
