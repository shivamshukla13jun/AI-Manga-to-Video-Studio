import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  AudioLines,
  BookOpen,
  Clapperboard,
  FileText,
  Layers,
  LayoutDashboard,
  MonitorPlay,
  Plus,
  Sparkles,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState, JobInline, JobStatusBadge, LoadingState, PageHeader } from '@/components/common/states';
import { useJobs, useProjects } from '@/lib/queries';
import { useAuth } from '@/stores/auth';
import { relativeTime } from '@/lib/utils';
import { CreateProjectDialog, ProjectCard } from '@/features/library/LibraryPage';

const WORKFLOW = [
  { icon: Upload, label: 'Upload CBZ', to: '/library' },
  { icon: Layers, label: 'Organize chapters', to: '/library' },
  { icon: FileText, label: 'Convert to PDF', to: '/pdf' },
  { icon: Sparkles, label: 'Detect scenes & story', to: '/story' },
  { icon: AudioLines, label: 'Voice & cost', to: '/voice' },
  { icon: Clapperboard, label: 'Edit video', to: '/video' },
  { icon: MonitorPlay, label: 'Render MP4', to: '/renders' },
];

const Stat = ({ label, value, icon: Icon }: { label: string; value: number | string; icon: React.ElementType }) => (
  <div className="panel flex items-center gap-3 p-4">
    <div className="rounded-md bg-accent/12 p-2">
      <Icon className="size-4 text-accent-2" />
    </div>
    <div>
      <div className="text-lg font-semibold leading-none">{value}</div>
      <div className="mt-1 text-[11px] text-muted">{label}</div>
    </div>
  </div>
);

export const DashboardPage = () => {
  const user = useAuth((s) => s.user);
  const projects = useProjects();
  const jobs = useJobs();
  const [open, setOpen] = useState(false);
  const p = projects.data || [];
  const active = (jobs.data || []).filter((j) => ['queued', 'active', 'retrying'].includes(j.status));
  const recent = (jobs.data || []).slice(0, 8);

  return (
    <div>
      <PageHeader
        icon={LayoutDashboard}
        title={`Welcome back${user?.name ? `, ${user.name.split(' ')[0]}` : ''}`}
        subtitle="Turn manga & manhwa chapters into narrated storytelling videos"
        actions={
          <Button variant="primary" onClick={() => setOpen(true)}>
            <Plus /> New project
          </Button>
        }
      />
      <div className="flex flex-col gap-6 p-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat icon={BookOpen} label="Projects" value={p.length} />
          <Stat icon={Layers} label="Chapters" value={p.reduce((n, x) => n + (x.stats?.chapters || 0), 0)} />
          <Stat icon={FileText} label="Comic pages" value={p.reduce((n, x) => n + (x.stats?.images || 0), 0)} />
          <Stat icon={MonitorPlay} label="Running jobs" value={active.length} />
        </div>

        <div className="panel">
          <div className="panel-header">Production pipeline</div>
          <div className="flex flex-wrap items-center gap-1 p-3">
            {WORKFLOW.map((s, i) => (
              <div key={s.label} className="flex items-center gap-1">
                <Link to={s.to} className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-xs hover:border-accent/60 hover:bg-panel-3">
                  <s.icon className="size-3.5 text-accent-2" /> {s.label}
                </Link>
                {i < WORKFLOW.length - 1 && <ArrowRight className="size-3 text-dim" />}
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
          <div className="xl:col-span-2">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">Recent projects</h2>
              <Link to="/library" className="text-xs text-accent-2 hover:underline">
                View library
              </Link>
            </div>
            {projects.isLoading ? (
              <LoadingState />
            ) : p.length ? (
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {p.slice(0, 4).map((x) => (
                  <ProjectCard key={x.id} p={x} />
                ))}
              </div>
            ) : (
              <EmptyState icon={BookOpen} title="No projects yet" description="Create your first manga project to start uploading chapters." />
            )}
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">Background activity</h2>
              <Link to="/renders" className="text-xs text-accent-2 hover:underline">
                All jobs
              </Link>
            </div>
            <div className="panel divide-y divide-line">
              {jobs.isLoading ? (
                <LoadingState />
              ) : recent.length ? (
                recent.map((j) => (
                  <div key={j.id} className="flex flex-col gap-1.5 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs">{j.title}</span>
                      <JobStatusBadge status={j.status} />
                    </div>
                    {['active', 'retrying'].includes(j.status) ? (
                      <JobInline job={j} />
                    ) : (
                      <span className="text-[10px] text-dim">
                        {j.error?.message ? <span className="text-danger">{j.error.message}</span> : relativeTime(j.updatedAt)}
                      </span>
                    )}
                  </div>
                ))
              ) : (
                <p className="p-4 text-xs text-muted">No jobs yet.</p>
              )}
            </div>
          </div>
        </div>
      </div>
      <CreateProjectDialog open={open} onOpenChange={setOpen} />
    </div>
  );
};
