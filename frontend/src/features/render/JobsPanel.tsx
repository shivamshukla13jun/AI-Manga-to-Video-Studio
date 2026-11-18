import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Ban, ChevronDown, ChevronRight, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/input';
import { EmptyState, JobInline, JobStatusBadge, LoadingState } from '@/components/common/states';
import { jobActions, useAction, useJobs } from '@/lib/queries';
import { api } from '@/lib/api';
import { formatDate, formatDuration, relativeTime } from '@/lib/utils';
import type { Job } from '@/lib/types';
import { ListChecks } from 'lucide-react';

const TYPES = [
  ['', 'All job types'],
  ['cbz-extraction', 'CBZ extraction'],
  ['image-reextract', 'Page re-extraction'],
  ['pdf-conversion', 'PDF conversion'],
  ['image-processing', 'Image processing'],
  ['scene-detection', 'Scene detection'],
  ['story-generation', 'Story generation'],
  ['tts-generation', 'Audio generation'],
  ['video-rendering', 'Video rendering'],
];

const JobLogs = ({ id }: { id: string }) => {
  const { data, isLoading } = useQuery({ queryKey: ['job', id], queryFn: () => api.get<Job>(`/api/jobs/${id}`), refetchInterval: 3000 });
  if (isLoading) return <LoadingState label="Loading logs…" />;
  return (
    <div className="max-h-56 overflow-y-auto rounded border border-line bg-bg p-2 font-mono text-[11px]">
      {data?.logs?.length ? (
        data.logs.map((l, i) => (
          <div key={i} className={l.level === 'error' ? 'text-danger' : l.level === 'warn' ? 'text-warn' : 'text-muted'}>
            <span className="text-dim">{new Date(l.at).toLocaleTimeString()}</span> {l.message}
          </div>
        ))
      ) : (
        <span className="text-dim">No log entries</span>
      )}
    </div>
  );
};

export const JobsPanel = ({ defaultType = '', project }: { defaultType?: string; project?: string }) => {
  const [type, setType] = useState(defaultType);
  const [status, setStatus] = useState('');
  const jobs = useJobs({ type, status, project });
  const [open, setOpen] = useState<string | null>(null);
  const cancel = useAction((id: string) => jobActions.cancel(id), { success: 'Cancellation requested', invalidate: [['jobs']] });
  const retry = useAction((id: string) => jobActions.retry(id), { success: 'Retry queued', invalidate: [['jobs']] });

  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line p-2">
        <NativeSelect value={type} onChange={(e) => setType(e.target.value)} className="w-52">
          {TYPES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect value={status} onChange={(e) => setStatus(e.target.value)} className="w-40">
          <option value="">Any status</option>
          <option value="queued,active,retrying">Running</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="cancelled">Cancelled</option>
        </NativeSelect>
      </div>
      {jobs.isLoading ? (
        <LoadingState />
      ) : !jobs.data?.length ? (
        <div className="p-4">
          <EmptyState icon={ListChecks} title="No jobs" description="Background jobs (extraction, PDF, AI, audio, rendering) appear here with live progress." />
        </div>
      ) : (
        <div className="divide-y divide-line">
          {jobs.data.map((j) => {
            const running = ['queued', 'active', 'retrying'].includes(j.status);
            const elapsed = j.startedAt ? ((j.completedAt ? new Date(j.completedAt) : new Date()).getTime() - new Date(j.startedAt).getTime()) / 1000 : undefined;
            return (
              <div key={j.id} className="px-3 py-2.5">
                <div className="flex items-center gap-3">
                  <button onClick={() => setOpen(open === j.id ? null : j.id)} className="text-dim hover:text-fg" aria-label="Toggle logs">
                    {open === j.id ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-xs font-medium">{j.title}</span>
                      <JobStatusBadge status={j.status} />
                      {j.maxAttempts > 1 && j.attempts > 1 && <span className="text-[10px] text-warn">attempt {j.attempts}/{j.maxAttempts}</span>}
                    </div>
                    <div className="text-[10px] text-dim">
                      {j.type} · created {relativeTime(j.createdAt)}
                      {elapsed !== undefined && ` · ${formatDuration(elapsed)}`}
                      {j.completedAt && ` · finished ${formatDate(j.completedAt)}`}
                    </div>
                  </div>
                  <div className="w-64">{running ? <JobInline job={j} /> : j.error?.message ? <p className="line-clamp-2 text-[11px] text-danger">{j.error.message}</p> : null}</div>
                  <div className="flex w-16 justify-end gap-0.5">
                    {running && !j.cancelRequested && (
                      <Button size="icon-sm" variant="ghost" onClick={() => cancel.mutate(j.id)} aria-label="Cancel">
                        <Ban />
                      </Button>
                    )}
                    {['failed', 'cancelled'].includes(j.status) && (
                      <Button size="icon-sm" variant="ghost" onClick={() => retry.mutate(j.id)} aria-label="Retry">
                        <RotateCw />
                      </Button>
                    )}
                  </div>
                </div>
                {open === j.id && (
                  <div className="mt-2 pl-6">
                    <JobLogs id={j.id} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
