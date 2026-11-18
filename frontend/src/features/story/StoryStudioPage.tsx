import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { BookOpen, ScanSearch, Sparkles, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge, Checkbox, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/primitives';
import { EmptyState, JobStatusBadge, LoadingState, PageHeader } from '@/components/common/states';
import { storyApi, useAction, useJobs, useProjects, useStoryOverview, useStudioSettings } from '@/lib/queries';
import { useProjectRoom } from '@/lib/socket';
import { formatDuration } from '@/lib/utils';
import type { Chapter, CostEstimate } from '@/lib/types';
import { EstimateDialog } from './EstimateDialog';
import { SceneEditor } from './SceneEditor';
import { NarrationEditor } from './NarrationEditor';
import { CharactersPanel } from './CharactersPanel';

const LANGUAGES = [
  ['hi', 'Hindi'], ['en', 'English'], ['ja', 'Japanese'], ['ko', 'Korean'], ['ta', 'Tamil'], ['te', 'Telugu'], ['bn', 'Bengali'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'],
] as const;

/** /story without a project → pick one. */
const ProjectPicker = () => {
  const projects = useProjects();
  if (projects.isLoading) return <LoadingState />;
  const list = projects.data || [];
  return (
    <div className="p-6">
      <PageHeader title="AI Story Studio" subtitle="Choose a project to analyse scenes and write narration." icon={Sparkles} />
      {!list.length ? (
        <EmptyState icon={BookOpen} title="No projects" description="Create a manga project first." action={<Link to="/library"><Button variant="primary" size="sm">Open library</Button></Link>} />
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
          {list.map((p) => (
            <Link key={p.id} to={`/story/${p.id}`} className="group rounded-lg border border-line bg-panel p-3 hover:border-line-strong hover:bg-panel-2">
              <div className="mb-2 aspect-[3/4] overflow-hidden rounded bg-panel-3">
                {p.coverUrl ? <img src={p.coverUrl} alt="" className="size-full object-cover" /> : <div className="flex size-full items-center justify-center"><BookOpen className="text-muted" /></div>}
              </div>
              <p className="truncate text-sm font-medium group-hover:text-accent">{p.title}</p>
              <p className="text-[11px] text-muted">{p.stats?.chapters ?? 0} chapters · {p.narrationLanguage}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
};

export const StoryStudioPage = () => {
  const { projectId } = useParams();
  if (!projectId) return <ProjectPicker />;
  return <Studio projectId={projectId} />;
};

const Studio = ({ projectId }: { projectId: string }) => {
  const [params, setParams] = useSearchParams();
  const chapterId = params.get('chapter') || undefined;
  const studioSettings = useStudioSettings();
  const language = studioSettings.data?.narrationLanguage || 'hi';
  const mode = studioSettings.data?.narrationMode || 'recap';
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [estimate, setEstimate] = useState<{ est: CostEstimate; kind: 'detect' | 'generate' } | null>(null);
  const navigate = useNavigate();

  useProjectRoom(projectId);
  const overview = useStoryOverview(projectId, language, mode);
  const aiJobs = useJobs({ project: projectId });
  const running = (aiJobs.data || []).filter((j) => ['scene-detection', 'story-generation'].includes(j.type) && ['queued', 'active', 'retrying'].includes(j.status));

  const chapters = overview.data?.chapters || [];
  const readyChapters = chapters.filter((c) => c.status === 'ready');
  const chosenIds = selected.size ? [...selected] : readyChapters.map((c) => c.id);
  const chosenSet = new Set(chosenIds);
  const hasScenes = chapters.some((c: any) => c.scenes > 0 && chosenSet.has(c.id));
  const chapter: Chapter | undefined = (chapters.find((c) => c.id === chapterId) || chapters[0]) as any;

  const estimateMut = useAction(
    async (v: { kind: 'detect' | 'generate' }) => {
      const est = v.kind === 'detect' ? await storyApi.estimateScenes(projectId, chosenIds) : await storyApi.estimateStory(projectId, chosenIds, language, mode);
      setEstimate({ est, kind: v.kind });
    },
    {}
  );
  const runJob = useAction(
    async () => {
      if (!estimate) return;
      if (estimate.kind === 'detect') await storyApi.detect(projectId, chosenIds, estimate.est.id);
      else await storyApi.generate(projectId, chosenIds, language, mode, estimate.est.id);
    },
    {
      success: 'Job queued — watch progress in Render Manager',
      onSuccess: () => {
        setEstimate(null);
        overview.refetch();
        aiJobs.refetch();
      },
    }
  );

  const toggleChapter = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  if (overview.isLoading) return <LoadingState label="Loading story studio…" />;
  if (!overview.data) return <EmptyState icon={TriangleAlert} title="Project not found" />;
  const ov = overview.data;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-line bg-panel px-4 py-2.5">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">{ov.project.title}</h1>
          <p className="text-[11px] text-muted">AI Story Studio</p>
        </div>
        <span className="flex-1" />
        <Link to="/settings" title="Global narration settings">
          <Badge tone="neutral" className="cursor-pointer">{LANGUAGES.find(([v]) => v === language)?.[1] || language} · {mode === 'recap' ? 'Recap' : 'Original'}</Badge>
        </Link>
        {hasScenes && (
          <Button size="sm" variant="outline" disabled={!ov.aiConfigured || !readyChapters.length || estimateMut.isPending} onClick={() => estimateMut.mutate({ kind: 'generate' })} title="Re-narrate existing scenes (e.g. after changing narration style or editing scenes)">
            <Sparkles /> Rewrite story
          </Button>
        )}
        <Button size="sm" variant="primary" disabled={!ov.aiConfigured || !readyChapters.length || estimateMut.isPending} onClick={() => estimateMut.mutate({ kind: 'detect' })} title="Detect scenes and generate narration in one step">
          <ScanSearch /> Detect + narrate
        </Button>
      </div>

      {!ov.aiConfigured && (
        <div className="flex items-center gap-2 border-b border-warn/30 bg-warn/10 px-4 py-2 text-xs text-warn">
          <TriangleAlert className="size-3.5" /> No AI API key configured on the server (GEMINI_API_KEY). Scene detection and story generation will fail until it is set.
        </div>
      )}
      {running.length > 0 && (
        <div className="flex items-center gap-3 border-b border-line bg-panel-2 px-4 py-1.5 text-xs">
          {running.map((j) => (
            <span key={j.id} className="flex items-center gap-2">
              <JobStatusBadge status={j.status} /> {j.title} <span className="font-mono text-muted">{Math.round(j.progress)}%</span>
            </span>
          ))}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* chapter rail */}
        <aside className="w-64 shrink-0 space-y-1 overflow-y-auto border-r border-line bg-panel p-2">
          <p className="px-1 pb-1 text-[10px] uppercase tracking-wide text-muted">Chapters — select range</p>
          {chapters.map((c) => (
            <div key={c.id} className={`rounded-md border p-2 ${chapter?.id === c.id ? 'border-accent bg-panel-3' : 'border-line bg-panel-2'}`}>
              <div className="flex items-center gap-2">
                <Checkbox checked={selected.size ? selected.has(c.id) : true} onCheckedChange={() => toggleChapter(c.id)} />
                <button className="min-w-0 flex-1 text-left" onClick={() => setParams({ chapter: c.id })}>
                  <span className="block truncate text-xs font-medium">Ch. {c.number}{c.title ? ` — ${c.title}` : ''}</span>
                  <span className="block text-[10px] text-muted">
                    {c.status !== 'ready' ? c.status : `${c.imageCount} pages · ${c.scenes} scenes · ${c.words}w`}
                    {c.duration > 0 && ` · ${formatDuration(c.duration)}`}
                  </span>
                </button>
              </div>
              <div className="mt-1 flex gap-1 pl-6">
                <Badge tone={c.analysisStatus === 'done' ? 'ok' : c.analysisStatus === 'failed' ? 'danger' : c.analysisStatus === 'processing' ? 'warn' : 'neutral'}>scenes {c.analysisStatus}</Badge>
                <Badge tone={c.storyStatus === 'done' ? 'ok' : c.storyStatus === 'failed' ? 'danger' : c.storyStatus === 'processing' ? 'warn' : 'neutral'}>story {c.storyStatus}</Badge>
                {c.brokenImageCount > 0 && <Badge tone="warn">{c.brokenImageCount} broken</Badge>}
              </div>
            </div>
          ))}
          {selected.size > 0 && (
            <Button size="xs" variant="ghost" className="w-full" onClick={() => setSelected(new Set())}>
              Clear selection ({selected.size})
            </Button>
          )}
        </aside>

        {/* editor */}
        <main className="min-w-0 flex-1 overflow-y-auto p-4">
          {chapter ? (
            <Tabs defaultValue="scenes">
              <TabsList>
                <TabsTrigger value="scenes">Scenes</TabsTrigger>
                <TabsTrigger value="narration">Narration</TabsTrigger>
                <TabsTrigger value="characters">Characters</TabsTrigger>
              </TabsList>
              <TabsContent value="scenes" className="mt-3">
                <SceneEditor chapter={chapter} onChanged={() => overview.refetch()} />
              </TabsContent>
              <TabsContent value="narration" className="mt-3 max-w-3xl">
                <NarrationEditor projectId={projectId} language={language} mode={mode} chapterId={chapter.id} />
              </TabsContent>
              <TabsContent value="characters" className="mt-3 max-w-lg">
                <CharactersPanel projectId={projectId} />
              </TabsContent>
            </Tabs>
          ) : (
            <EmptyState icon={BookOpen} title="No chapters" description="Upload CBZ chapters in the library first." action={<Button size="sm" onClick={() => navigate(`/library/${projectId}`)}>Open project</Button>} />
          )}
        </main>
      </div>

      <EstimateDialog
        estimate={estimate?.est || null}
        open={!!estimate}
        onOpenChange={(o) => !o && setEstimate(null)}
        confirmLabel={estimate?.kind === 'detect' ? 'Detect scenes + narrate' : 'Rewrite narration'}
        loading={runJob.isPending}
        onConfirm={() => runJob.mutate()}
      />
    </div>
  );
};
