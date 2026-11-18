import * as React from 'react';
import { AlertTriangle, Loader2, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeTone, Progress } from '@/components/ui/primitives';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import type { Job } from '@/lib/types';

export const Spinner = ({ className }: { className?: string }) => <Loader2 className={cn('size-4 animate-spin text-muted', className)} />;

export const LoadingState = ({ label = 'Loading…' }: { label?: string }) => (
  <div className="flex h-40 items-center justify-center gap-2 text-xs text-muted">
    <Spinner /> {label}
  </div>
);

export const ErrorState = ({ error, onRetry }: { error: unknown; onRetry?: () => void }) => (
  <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-danger/30 bg-danger/5 p-6 text-center">
    <AlertTriangle className="size-5 text-danger" />
    <p className="text-xs text-fg">{(error as Error)?.message || 'Something went wrong'}</p>
    {onRetry && (
      <Button size="sm" onClick={onRetry}>
        <RotateCw /> Retry
      </Button>
    )}
  </div>
);

export const EmptyState = ({ icon: Icon, title, description, action }: { icon: React.ElementType; title: string; description?: string; action?: React.ReactNode }) => (
  <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line-strong px-6 py-12 text-center">
    <div className="mb-1 rounded-full bg-panel-3 p-3">
      <Icon className="size-5 text-muted" />
    </div>
    <p className="text-sm font-medium">{title}</p>
    {description && <p className="max-w-sm text-xs text-muted">{description}</p>}
    {action && <div className="mt-2">{action}</div>}
  </div>
);

export const PageHeader = ({ title, subtitle, actions, icon: Icon }: { title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode; icon?: React.ElementType }) => (
  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-4">
    <div className="flex min-w-0 items-center gap-3">
      {Icon && (
        <div className="rounded-md border border-line-strong bg-panel-3 p-2">
          <Icon className="size-4 text-accent-2" />
        </div>
      )}
      <div className="min-w-0">
        <h1 className="truncate text-base font-semibold">{title}</h1>
        {subtitle && <p className="truncate text-xs text-muted">{subtitle}</p>}
      </div>
    </div>
    {actions && <div className="flex items-center gap-2">{actions}</div>}
  </div>
);

const JOB_TONE: Record<string, BadgeTone> = {
  queued: 'neutral',
  active: 'accent',
  retrying: 'warn',
  completed: 'ok',
  failed: 'danger',
  cancelled: 'neutral',
};

export const JobStatusBadge = ({ status }: { status: string }) => <Badge tone={JOB_TONE[status] || 'neutral'}>{status}</Badge>;

export const JobInline = ({ job, className }: { job: Job; className?: string }) => (
  <div className={cn('flex min-w-0 flex-col gap-1', className)}>
    <div className="flex items-center justify-between gap-2 text-[11px]">
      <span className="truncate text-muted">{job.stage || job.title}</span>
      <span className="font-mono text-dim">{Math.round(job.progress)}%</span>
    </div>
    <Progress value={job.progress} tone={job.status === 'failed' ? 'danger' : job.status === 'retrying' ? 'warn' : 'accent'} />
  </div>
);

export const ConfirmDialog = ({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  danger,
  loading,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  children?: React.ReactNode;
}) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent title={title} description={description}>
      {children}
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant={danger ? 'danger' : 'primary'} loading={loading} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);
