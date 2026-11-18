import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

export const formatBytes = (bytes?: number | null, digits = 1) => {
  if (!bytes && bytes !== 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
};

export const formatDuration = (seconds?: number | null) => {
  if (seconds === undefined || seconds === null || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}h ${m}m ${sec}s` : m ? `${m}m ${sec}s` : `${sec}s`;
};

/** mm:ss.ff timecode for the editor */
export const timecode = (seconds: number, fps = 30) => {
  const total = Math.max(0, seconds);
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  const f = Math.floor((total % 1) * fps);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
};

export const formatDate = (d?: string | Date | null) =>
  d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export const relativeTime = (d?: string | Date | null) => {
  if (!d) return '—';
  const diff = (Date.now() - new Date(d).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
};

/** Best-effort chapter number from a filename ("Chapter 012.cbz", "ch_5.5.cbz"); mirrors the server. */
export const guessChapterNumber = (fileName: string): number | undefined => {
  const base = fileName.replace(/\.[^.]+$/, '');
  const tagged = base.match(/(?:ch(?:apter)?|ep(?:isode)?|#)\s*[._-]?\s*(\d+(?:\.\d+)?)/i);
  const any = tagged || base.match(/(\d+(?:\.\d+)?)(?!.*\d)/);
  return any ? Number(any[1]) : undefined;
};

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export const formatCost = (usd?: number | null) =>
  usd == null ? '—' : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;

export const formatNumber = (n?: number | null) => (n == null ? '—' : n.toLocaleString('en-US'));
