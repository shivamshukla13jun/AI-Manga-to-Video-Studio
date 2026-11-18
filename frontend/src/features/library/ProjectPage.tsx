import { useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { BookOpen, Camera, Clapperboard, FileText, FolderKanban, ImageIcon, Layers, Pencil, Sparkles, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge, Dialog, DialogContent, DialogFooter, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/primitives';
import { ConfirmDialog, ErrorState, LoadingState, PageHeader } from '@/components/common/states';
import { useAction, useChapters, useProject } from '@/lib/queries';
import { useProjectRoom } from '@/lib/socket';
import { useUploads } from '@/stores/uploads';
import { api } from '@/lib/api';
import type { Project } from '@/lib/types';
import { ProjectFormFields } from './LibraryPage';
import { ChapterManager } from './ChapterManager';
import { UploadWorkspace } from './UploadWorkspace';
import { GroupsPanel } from './GroupsPanel';
import { PagesViewer } from './PagesViewer';

export const ProjectPage = () => {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'chapters';
  const chapterParam = params.get('chapter') || undefined;
  useProjectRoom(projectId);
  const project = useProject(projectId);
  const chapters = useChapters(projectId);
  const uploading = useUploads((s) => s.items.filter((i) => i.projectId === projectId && !['done'].includes(i.status)).length);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const coverInput = useRef<HTMLInputElement>(null);

  const setTab = (t: string, extra: Record<string, string> = {}) => setParams({ tab: t, ...extra }, { replace: true });

  const cover = useAction(
    (file: File) => {
      const fd = new FormData();
      fd.append('cover', file);
      return api.post(`/api/manga/projects/${projectId}/cover`, fd);
    },
    { success: 'Cover updated', invalidate: [['project', projectId], ['projects']] }
  );
  const remove = useAction(() => api.del(`/api/manga/projects/${projectId}`), {
    success: 'Project deleted',
    invalidate: [['projects']],
    onSuccess: () => navigate('/library'),
  });

  if (project.isLoading) return <LoadingState />;
  if (project.error || !project.data) return <div className="p-6"><ErrorState error={project.error || new Error('Project not found')} /></div>;
  const p = project.data;
  const list = chapters.data || [];

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link to="/library" className="text-muted hover:text-fg">
              Library
            </Link>
            <span className="text-dim">/</span> {p.title}
          </span>
        }
        subtitle={`${p.language.toUpperCase()} → ${p.narrationLanguage.toUpperCase()} narration · ${p.narrationMode === 'original' ? 'Original story mode' : 'Recap mode'}`}
        actions={
          <>
            <Button size="sm" onClick={() => setEditing(true)}>
              <Pencil /> Edit
            </Button>
            <Button size="sm" asChild>
              <Link to={`/pdf?project=${p.id}`}>
                <FileText /> Export PDF
              </Link>
            </Button>
            <Button size="sm" asChild>
              <Link to={`/story?project=${p.id}`}>
                <Sparkles /> Story Studio
              </Link>
            </Button>
            <Button size="sm" variant="primary" asChild>
              <Link to={`/video?project=${p.id}`}>
                <Clapperboard /> Video Studio
              </Link>
            </Button>
          </>
        }
      />
      <div className="flex gap-6 p-6">
        <div className="flex w-44 shrink-0 flex-col gap-3">
          <button onClick={() => coverInput.current?.click()} className="group relative h-64 overflow-hidden rounded-lg border border-line bg-panel-3" title="Change cover">
            {p.coverUrl ? (
              <img src={p.coverUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-1 text-dim">
                <ImageIcon className="size-6" />
                <span className="text-[10px]">Add cover</span>
              </div>
            )}
            <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
              <Camera className="size-5" />
            </div>
          </button>
          <input ref={coverInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => e.target.files?.[0] && cover.mutate(e.target.files[0])} />
          <div className="flex flex-wrap gap-1.5">
            <Badge tone="info">{p.stats?.chapters ?? 0} chapters</Badge>
            <Badge tone="ok">{p.stats?.ready ?? 0} ready</Badge>
            <Badge>{p.stats?.images ?? 0} pages</Badge>
          </div>
          <p className="text-xs leading-relaxed text-muted">{p.description || 'No description.'}</p>
          <Button size="sm" variant="danger" className="mt-auto" onClick={() => setDeleting(true)}>
            <Trash2 /> Delete project
          </Button>
        </div>

        <Tabs value={tab} onValueChange={(t) => setTab(t)} className="min-w-0 flex-1">
          <TabsList>
            <TabsTrigger value="chapters">
              <Layers /> Chapters
            </TabsTrigger>
            <TabsTrigger value="upload">
              <Upload /> Upload {uploading > 0 && <Badge tone="accent">{uploading}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="pages">
              <BookOpen /> Pages
            </TabsTrigger>
            <TabsTrigger value="groups">
              <FolderKanban /> Chapter groups
            </TabsTrigger>
          </TabsList>
          <div className="pt-4">
            <TabsContent value="chapters">
              {chapters.isLoading ? <LoadingState /> : chapters.error ? <ErrorState error={chapters.error} onRetry={chapters.refetch} /> : (
                <ChapterManager projectId={projectId} chapters={list} onView={(c) => setTab('pages', { chapter: c.id })} />
              )}
            </TabsContent>
            <TabsContent value="upload">
              <UploadWorkspace projectId={projectId} chapters={list} />
            </TabsContent>
            <TabsContent value="pages">
              <PagesViewer chapters={list} chapterId={chapterParam} onChapterChange={(id) => setTab('pages', { chapter: id })} />
            </TabsContent>
            <TabsContent value="groups">
              <GroupsPanel projectId={projectId} chapters={list} />
            </TabsContent>
          </div>
        </Tabs>
      </div>

      <EditProjectDialog project={p} open={editing} onOpenChange={setEditing} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete "${p.title}"?`}
        description="All chapters, original CBZ files, extracted pages and exports of this project will be permanently deleted."
        confirmLabel="Delete project"
        danger
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
};

const EditProjectDialog = ({ project, open, onOpenChange }: { project: Project; open: boolean; onOpenChange: (o: boolean) => void }) => {
  const form = useForm({
    values: {
      title: project.title,
      description: project.description || '',
      language: project.language,
      narrationLanguage: project.narrationLanguage,
      narrationMode: project.narrationMode,
    },
  });
  const save = useAction((v: any) => api.put(`/api/manga/projects/${project.id}`, v), {
    success: 'Project saved',
    invalidate: [['project', project.id], ['projects']],
    onSuccess: () => onOpenChange(false),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Edit project">
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))}>
          <ProjectFormFields form={form as any} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={save.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
