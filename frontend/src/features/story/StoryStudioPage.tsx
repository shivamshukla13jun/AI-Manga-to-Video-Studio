import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { BookOpen, Clapperboard, FileText, ScanSearch, Sparkles, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/input';
import { Badge, Checkbox, Progress, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/primitives';
import { EmptyState, JobErrorBanner, JobStatusBadge, LoadingState, PageHeader } from '@/components/common/states';
import { mangaApi, storyApi, useAction, useJobs, useProjects, useStoryOverview, useStudioSettings, useVideos, videoApi } from '@/lib/queries';
import { useProjectRoom } from '@/lib/socket';
import { formatDuration } from '@/lib/utils';
import type { Chapter, CostEstimate, Job } from '@/lib/types';
import { EstimateDialog } from './EstimateDialog';
import { SceneEditor } from './SceneEditor';
import { NarrationEditor } from './NarrationEditor';
import { CharactersPanel } from './CharactersPanel';

/** 1s ticker so elapsed time updates while a job runs. */
const useNow = (active: boolean) => {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
  return Date.now();
};

const LOG_TONE: Record<string, string> = { info: 'text-muted', warn: 'text-warn', error: 'text-danger' };

/** Live job console: current stage, progress bar, elapsed time, streaming log lines. */
const LiveJob = ({ job }: { job: Job }) => {
  const now = useNow(true);
  const elapsed = job.startedAt ? (now - new Date(job.startedAt).getTime()) / 1000 : undefined;
  const logs = (job.logs || []).slice(-5);
  return (
    <div className="rounded border border-line bg-panel px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <JobStatusBadge status={job.status} />
        <span className="font-medium">{job.title}</span>
        <span className="ml-auto font-mono text-muted">{elapsed !== undefined ? formatDuration(elapsed) : 'queued'}</span>
        <span className="font-mono text-muted">{Math.round(job.progress)}%</span>
      </div>
      <Progress value={job.progress} tone={job.status === 'retrying' ? 'warn' : 'accent'} className="mt-1.5" />
      {job.stage && <div className="mt-1.5 truncate text-fg">{job.stage}</div>}
      {logs.length > 0 && (
        <div className="mt-1 space-y-px font-mono text-[10px] leading-relaxed">
          {logs.map((l, i) => (
            <div key={i} className={LOG_TONE[l.level] || 'text-muted'}>
              {l.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

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
  const [estimate, setEstimate] = useState<CostEstimate | null>(null);
  const [runMode, setRunMode] = useState<'queue' | 'direct'>('queue');
  const [useOcr, setUseOcr] = useState(false);
  const [, setEstimateAction] = useState<'detect' | 'story'>('story');
  const navigate = useNavigate();

  useProjectRoom(projectId);
  const overview = useStoryOverview(projectId, language, mode);
  const aiJobs = useJobs({ project: projectId });
  const running = (aiJobs.data || []).filter((j) => ['scene-detection', 'story-generation'].includes(j.type) && ['queued', 'active', 'retrying'].includes(j.status));
  // latest failed job per AI type (jobs arrive newest-first)
  const failed = ['scene-detection', 'story-generation']
    .map((t) => (aiJobs.data || []).find((j) => j.type === t && j.status === 'failed'))
    .filter(Boolean) as Job[];

  const chapters = overview.data?.chapters || [];
  const aiProvider = (overview.data?.aiProvider || studioSettings.data?.aiProvider || 'gemini') as 'gemini' | 'local';
  const mergedUnits = chapters.filter((c: any) => c.kind === 'merged');
  const readyChapters = chapters.filter((c) => c.status === 'ready');
  const readyMerged = mergedUnits.filter((c) => c.status === 'ready');
  const readySources = readyChapters.filter((c: any) => c.kind !== 'merged');
  const chosenIds = selected.size ? [...selected] : (readyMerged.length ? readyMerged : readyChapters).map((c) => c.id);
  const chosenSet = new Set(chosenIds);
  const hasScenes = chapters.some((c: any) => c.scenes > 0 && chosenSet.has(c.id));
  const chapter: Chapter | undefined = (chapters.find((c) => c.id === chapterId) || mergedUnits[0] || chapters[0]) as any;

  // Detection always runs on the Python CV service — free, no estimate needed.
  const runDetect = useAction(async () => storyApi.detect(projectId, chosenIds, {}), {
    success: 'Scene detection queued — watch progress in Render Manager',
    onSuccess: () => { setEstimate(null); overview.refetch(); aiJobs.refetch(); },
  });
  const detectClick = () => runDetect.mutate();

  const estimateMut = useAction(
    async () => { setEstimateAction('story'); setEstimate(await storyApi.estimateStory(projectId, chosenIds, language, mode)); },
    {}
  );
  const runGenerate = useAction(
    async (estimateId?: string) => storyApi.generate(projectId, chosenIds, language, mode, estimateId, { direct: runMode === 'direct', useOcr }),
    {
      success: (r: any) => (r?.result ? `Narration written — ${r.result.segments} segments` : 'Story generation queued — watch progress in Render Manager'),
      onSuccess: () => { setEstimate(null); overview.refetch(); aiJobs.refetch(); },
    }
  );
  const generateClick = () => (aiProvider === 'local' ? runGenerate.mutate() : estimateMut.mutate());
  const runJob = useAction(
    async () => {
      if (!estimate) return;
      await storyApi.generate(projectId, chosenIds, language, mode, estimate.id, { direct: runMode === 'direct', useOcr });
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

  // Merge selected (or all ready) source chapters into ≤50MB PDF special-chapter units.
  const mergeMut = useAction(
    async () =>
      mangaApi.merge(projectId, { chapterIds: selected.size ? [...selected].filter((id) => readySources.some((c) => c.id === id)) : undefined }),
    {
      success: 'Merging into ≤50MB PDF units — each becomes a selectable special chapter',
      onSuccess: () => { setSelected(new Set()); overview.refetch(); aiJobs.refetch(); },
    }
  );

  // Send a chapter's scenes+narration to Video Studio: reuse the latest video
  // project for this manga project if one exists, else build a fresh timeline.
  const videos = useVideos(projectId);
  const openVideo = useAction(
    async (chapterIds: string[]) => {
      const existing = videos.data?.[0];
      if (existing) {
        if (chapterIds.length) await videoApi.rebuild(existing.id, chapterIds).catch(() => undefined);
        navigate(`/video/${existing.id}`);
        return;
      }
      const v = await videoApi.create({ mangaProjectId: projectId, name: overview.data?.project.title || 'Video', language, mode, chapterIds });
      navigate(`/video/${v.id}`);
    },
    {}
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
        <Link to="/settings" title="Global narration + AI provider settings">
          <Badge tone="neutral" className="cursor-pointer">{LANGUAGES.find(([v]) => v === language)?.[1] || language} · {mode === 'recap' ? 'Recap' : 'Original'} · {aiProvider === 'local' ? 'Local AI' : 'Gemini'}</Badge>
        </Link>
        <Button
          size="sm"
          variant="outline"
          disabled={!readySources.length || mergeMut.isPending}
          onClick={() => mergeMut.mutate()}
          title="Batch ready chapters into ≤50MB PDFs — each becomes a special merged chapter for detection + story"
        >
          <FileText /> {mergeMut.isPending ? 'Merging…' : 'Merge to PDF'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!readyChapters.length || runDetect.isPending}
          onClick={detectClick}
          title="Python CV panel detection — free, no AI calls"
        >
          <ScanSearch /> Detect scenes
        </Button>
        <NativeSelect
          value={runMode}
          onChange={(e) => setRunMode(e.target.value as 'queue' | 'direct')}
          className="h-8 w-44 text-xs"
          title="Background = queued job you can leave running. Direct = waits for the result here — errors show immediately."
        >
          <option value="queue">Run in background</option>
          <option value="direct">Run direct (see errors)</option>
        </NativeSelect>
        <label className="flex items-center gap-1.5 text-xs text-muted" title="Extract speech-bubble text from scene images with local OCR and feed it into the prompt">
          <Checkbox checked={useOcr} onCheckedChange={(v) => setUseOcr(v === true)} />
          OCR text
        </label>
        <Button
          size="sm"
          variant="primary"
          disabled={!ov.aiConfigured || !hasScenes || estimateMut.isPending || runGenerate.isPending}
          onClick={generateClick}
          title={aiProvider === 'local' ? 'Generate narration with the local AI service — free' : 'Generate narration with Gemini — shows cost estimate first'}
        >
          <Sparkles /> {runGenerate.isPending ? 'Generating…' : 'Generate story'}
        </Button>
      </div>

      {!ov.aiConfigured && (
        <div className="flex items-center gap-2 border-b border-warn/30 bg-warn/10 px-4 py-2 text-xs text-warn">
          <TriangleAlert className="size-3.5" /> No AI API key configured on the server (GEMINI_API_KEY). Story generation will fail until it is set (scene detection is local CV — unaffected).
        </div>
      )}
      {!mergedUnits.length && readySources.length > 0 && (
        <div className="flex items-center gap-2 border-b border-line bg-panel-2 px-4 py-2 text-xs text-muted">
          <FileText className="size-3.5" /> Merge chapters into ≤50MB PDF units first — scene detection and story generation run on the merged PDF, not per chapter.
        </div>
      )}
      {running.length > 0 && (
        <div className="space-y-2 border-b border-line bg-panel-2 px-4 py-2">
          {running.map((j) => (
            <LiveJob key={j.id} job={j} />
          ))}
        </div>
      )}
      <JobErrorBanner jobs={failed} />

      <div className="flex min-h-0 flex-1">
        {/* chapter rail */}
        <aside className="w-64 shrink-0 space-y-1 overflow-y-auto border-r border-line bg-panel p-2">
          <p className="px-1 pb-1 text-[10px] uppercase tracking-wide text-muted">PDF units &amp; chapters — select range</p>
          {[...mergedUnits, ...chapters.filter((c: any) => c.kind !== 'merged')].map((c: any) => (
            <div key={c.id} className={`rounded-md border p-2 ${chapter?.id === c.id ? 'border-accent bg-panel-3' : 'border-line bg-panel-2'}`}>
              <div className="flex items-center gap-2">
                <Checkbox checked={selected.size ? selected.has(c.id) : true} onCheckedChange={() => toggleChapter(c.id)} />
                <button className="min-w-0 flex-1 text-left" onClick={() => setParams({ chapter: c.id })}>
                  <span className="block truncate text-xs font-medium">
                    {c.kind === 'merged' ? <FileText className="mr-1 inline size-3 text-accent" /> : null}
                    {c.kind === 'merged' ? c.title : `Ch. ${c.number}${c.title ? ` — ${c.title}` : ''}`}
                  </span>
                  <span className="block text-[10px] text-muted">
                    {c.status !== 'ready' ? c.status : `${c.imageCount} pages · ${c.scenes} scenes · ${c.words}w`}
                    {c.duration > 0 && ` · ${formatDuration(c.duration)}`}
                  </span>
                </button>
              </div>
              <div className="mt-1 flex flex-wrap gap-1 pl-6">
                {c.kind === 'merged' && <Badge tone="accent">PDF unit</Badge>}
                <Badge tone={c.analysisStatus === 'done' ? 'ok' : c.analysisStatus === 'failed' ? 'danger' : c.analysisStatus === 'processing' ? 'warn' : 'neutral'}>scenes {c.analysisStatus}</Badge>
                <Badge tone={c.storyStatus === 'done' ? 'ok' : c.storyStatus === 'failed' ? 'danger' : c.storyStatus === 'processing' ? 'warn' : 'neutral'}>story {c.storyStatus}</Badge>
                {c.brokenImageCount > 0 && <Badge tone="warn">{c.brokenImageCount} broken</Badge>}
              </div>
              {c.pdf?.url && (
                <a
                  href={c.pdf.url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 block truncate pl-6 text-[10px] text-accent hover:underline"
                  title={`Open ${c.pdf.fileName}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  <FileText className="mr-1 inline size-3" />
                  {c.pdf.fileName}{c.pdf.pageCount ? ` · ${c.pdf.pageCount}p` : ''}
                </a>
              )}
              {c.storyStatus === 'done' && (
                <button
                  className="mt-1 flex items-center gap-1 pl-6 text-[10px] text-accent hover:underline"
                  disabled={openVideo.isPending}
                  onClick={(e) => { e.stopPropagation(); openVideo.mutate([c.id]); }}
                  title="Build a video timeline from this unit's scenes and narration"
                >
                  <Clapperboard className="size-3" /> Open in Video Studio
                </button>
              )}
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
        estimate={estimate}
        open={!!estimate}
        onOpenChange={(o) => !o && setEstimate(null)}
        confirmLabel="Generate narration"
        loading={runJob.isPending}
        onConfirm={() => runJob.mutate()}
      />
    </div>
  );
};
