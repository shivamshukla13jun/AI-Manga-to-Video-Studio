import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BookOpen, ImageIcon, Plus, Search } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Badge, Dialog, DialogContent, DialogFooter } from '@/components/ui/primitives';
import { EmptyState, ErrorState, LoadingState, PageHeader } from '@/components/common/states';
import { useAction, useProjects } from '@/lib/queries';
import { api } from '@/lib/api';
import { relativeTime } from '@/lib/utils';
import type { Project } from '@/lib/types';

export const LANGUAGES = [
  { code: 'hi', label: 'Hindi' },
  { code: 'en', label: 'English' },
  { code: 'ko', label: 'Korean' },
  { code: 'ja', label: 'Japanese' },
  { code: 'zh', label: 'Chinese' },
  { code: 'bn', label: 'Bengali' },
  { code: 'ta', label: 'Tamil' },
  { code: 'te', label: 'Telugu' },
  { code: 'mr', label: 'Marathi' },
  { code: 'es', label: 'Spanish' },
];

type ProjectForm = { title: string; description?: string; language: string; narrationLanguage: string; narrationMode: 'original' | 'recap' };

export const ProjectFormFields = ({ form }: { form: ReturnType<typeof useForm<ProjectForm>> }) => (
  <div className="grid grid-cols-2 gap-3">
    <Field label="Manga title" className="col-span-2" error={form.formState.errors.title?.message}>
      <Input placeholder="The Legendary Sword" {...form.register('title', { required: 'Title is required' })} />
    </Field>
    <Field label="Description" className="col-span-2">
      <Textarea rows={3} placeholder="Optional synopsis / notes" {...form.register('description')} />
    </Field>
    <Field label="Comic language">
      <NativeSelect {...form.register('language')}>
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </NativeSelect>
    </Field>
    <Field label="Narration language">
      <NativeSelect {...form.register('narrationLanguage')}>
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </NativeSelect>
    </Field>
    <Field label="Narration mode" className="col-span-2" hint="Original keeps every important event & dialogue; Recap condenses while preserving the plot.">
      <NativeSelect {...form.register('narrationMode')}>
        <option value="original">Original story</option>
        <option value="recap">Recap</option>
      </NativeSelect>
    </Field>
  </div>
);

export const CreateProjectDialog = ({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) => {
  const navigate = useNavigate();
  const form = useForm<ProjectForm>({ defaultValues: { language: 'ko', narrationLanguage: 'hi', narrationMode: 'original' } });
  const create = useAction((v: ProjectForm) => api.post<Project>('/api/manga/projects', v), {
    success: 'Project created',
    invalidate: [['projects']],
    onSuccess: (p) => {
      onOpenChange(false);
      form.reset();
      navigate(`/library/${p.id}`);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New manga project" description="A project groups chapters, stories, audio and videos for one series.">
        <form onSubmit={form.handleSubmit((v) => create.mutate(v))}>
          <ProjectFormFields form={form} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={create.isPending}>
              Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export const ProjectCard = ({ p }: { p: Project }) => (
  <Link to={`/library/${p.id}`} className="group panel flex overflow-hidden transition-colors hover:border-accent/60">
    <div className="relative h-36 w-24 shrink-0 bg-panel-3">
      {p.coverUrl ? (
        <img src={p.coverUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <div className="flex h-full items-center justify-center">
          <ImageIcon className="size-6 text-dim" />
        </div>
      )}
    </div>
    <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-3">
      <div className="flex items-start justify-between gap-2">
        <h3 className="truncate text-sm font-semibold group-hover:text-accent-2">{p.title}</h3>
        {p.status === 'archived' && <Badge>archived</Badge>}
      </div>
      <p className="line-clamp-2 text-xs text-muted">{p.description || 'No description'}</p>
      <div className="mt-auto flex flex-wrap gap-1.5">
        <Badge tone="info">{p.stats?.chapters ?? 0} chapters</Badge>
        <Badge>{p.stats?.images ?? 0} pages</Badge>
        <Badge tone={p.stats?.stories ? 'ok' : 'neutral'}>{p.stats?.stories ?? 0} stories</Badge>
      </div>
      <div className="text-[10px] text-dim">
        {p.language.toUpperCase()} → {p.narrationLanguage.toUpperCase()} · {p.narrationMode} · updated {relativeTime(p.updatedAt)}
      </div>
    </div>
  </Link>
);

export const LibraryPage = () => {
  const { data, isLoading, error, refetch } = useProjects();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const projects = (data || []).filter((p) => p.title.toLowerCase().includes(q.toLowerCase()));

  return (
    <div>
      <PageHeader
        icon={BookOpen}
        title="Manga Library"
        subtitle="Your comic projects, chapters and source archives"
        actions={
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-2 size-4 text-dim" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects" className="w-56 pl-7" />
            </div>
            <Button variant="primary" onClick={() => setOpen(true)}>
              <Plus /> New project
            </Button>
          </>
        }
      />
      <div className="p-6">
        {isLoading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState error={error} onRetry={refetch} />
        ) : !projects.length ? (
          <EmptyState
            icon={BookOpen}
            title={q ? 'No matching projects' : 'No projects yet'}
            description="Create a project, then upload its CBZ chapters."
            action={
              <Button variant="primary" onClick={() => setOpen(true)}>
                <Plus /> New project
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {projects.map((p) => (
              <ProjectCard key={p.id} p={p} />
            ))}
          </div>
        )}
      </div>
      <CreateProjectDialog open={open} onOpenChange={setOpen} />
    </div>
  );
};
