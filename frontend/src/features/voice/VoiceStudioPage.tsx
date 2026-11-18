import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AudioLines, Pause, Play, RefreshCw, Trash2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge, Checkbox, Slider, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/primitives';
import { Input, NativeSelect } from '@/components/ui/input';
import { EmptyState, LoadingState, PageHeader } from '@/components/common/states';
import { useAction, useProjectAudio, useProjects, useSegments, useStudioSettings, useVoices, useVoiceStatus, voiceApi } from '@/lib/queries';
import { useProjectRoom } from '@/lib/socket';
import { formatCost, formatDuration } from '@/lib/utils';
import type { CostEstimate, GeneratedAudio, StorySegment } from '@/lib/types';
import { EstimateDialog } from '../story/EstimateDialog';
import { ProfilesPanel } from './ProfilesPanel';
import { Waveform } from './Waveform';

const LANGUAGES = [['hi', 'Hindi'], ['en', 'English'], ['ta', 'Tamil'], ['te', 'Telugu'], ['bn', 'Bengali']] as const;

const ProjectPicker = () => {
  const projects = useProjects();
  if (projects.isLoading) return <LoadingState />;
  return (
    <div className="p-6">
      <PageHeader title="Voice Studio" subtitle="Pick a project to synthesize narration." icon={AudioLines} />
      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
        {(projects.data || []).map((p) => (
          <Link key={p.id} to={`/voice/${p.id}`} className="group rounded-lg border border-line bg-panel p-3 hover:bg-panel-2">
            <p className="truncate text-sm font-medium group-hover:text-accent">{p.title}</p>
            <p className="text-[11px] text-muted">{p.stats?.chapters ?? 0} chapters · {p.narrationLanguage}</p>
          </Link>
        ))}
      </div>
    </div>
  );
};

/** Small audio player driven by stored waveform peaks. */
const ClipPlayer = ({ audio }: { audio: GeneratedAudio }) => {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  if (!audio.url) return null;
  return (
    <div className="flex items-center gap-2">
      <Button size="xs" variant="outline" onClick={() => (playing ? ref.current?.pause() : ref.current?.play())}>
        {playing ? <Pause /> : <Play />}
      </Button>
      <div className="min-w-0 flex-1">
        <Waveform peaks={audio.waveform?.peaks || []} progress={progress} className="h-8 w-full" />
      </div>
      <span className="w-14 text-right font-mono text-[10px] text-muted">{formatDuration(audio.duration)}</span>
      <audio
        ref={ref}
        src={audio.url}
        onTimeUpdate={(e) => setProgress(e.currentTarget.duration ? e.currentTarget.currentTime / e.currentTarget.duration : 0)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
    </div>
  );
};

export const VoiceStudioPage = () => {
  const { projectId } = useParams();
  if (!projectId) return <ProjectPicker />;
  return <Studio projectId={projectId} />;
};

const Studio = ({ projectId }: { projectId: string }) => {
  const navigate = useNavigate();
  useProjectRoom(projectId);
  const status = useVoiceStatus();
  const voices = useVoices();
  const settings = useStudioSettings();
  const [language, setLanguage] = useState('hi');
  const [mode, setMode] = useState('recap');
  const segments = useSegments(projectId, language, mode);
  const audio = useProjectAudio(projectId);

  const [provider, setProvider] = useState<'gemini' | 'local'>('gemini');
  const [voiceId, setVoiceId] = useState('');
  const [speed, setSpeed] = useState(1);
  const [previewText, setPreviewText] = useState('नमस्ते! यह आवाज़ का नमूना है।');
  const [previewing, setPreviewing] = useState(false);
  const previewEl = useRef<HTMLAudioElement>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [estimate, setEstimate] = useState<CostEstimate | null>(null);

  useEffect(() => {
    if (settings.data?.defaultTtsProvider) setProvider(settings.data.defaultTtsProvider);
  }, [settings.data?.defaultTtsProvider]);

  const providerVoices = useMemo(
    () => [
      ...(voices.data?.providerVoices || []).filter((v) => v.provider === provider),
      ...(voices.data?.profiles || []).filter((p) => p.provider === provider && p.status === 'ready').map((p) => ({ id: p.voiceId, name: `${p.name} (profile)`, provider, languages: p.languages.length ? p.languages : [p.language] })),
    ],
    [voices.data, provider]
  );
  useEffect(() => {
    if (!voiceId && providerVoices.length) setVoiceId(providerVoices[0].id);
    if (voiceId && providerVoices.length && !providerVoices.some((v) => v.id === voiceId)) setVoiceId(providerVoices[0].id);
  }, [providerVoices, voiceId]);

  const list = segments.data || [];
  const audioBySegment = useMemo(() => {
    const m = new Map<string, GeneratedAudio>();
    for (const a of audio.data || []) if (a.segment) m.set(a.segment, a);
    return m;
  }, [audio.data]);
  const chosen = selected.size ? list.filter((s) => selected.has(s.id)) : list;
  const chosenIds = chosen.map((s) => s.id);
  const cloud = provider === 'gemini';

  const preview = async () => {
    setPreviewing(true);
    try {
      const blob = await voiceApi.preview({ provider, voiceId, text: previewText, language, speed });
      previewEl.current!.src = URL.createObjectURL(blob);
      await previewEl.current!.play();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setPreviewing(false);
    }
  };

  const estimateMut = useAction(
    async () => {
      if (!cloud) return runGenerate(undefined);
      setEstimate(await voiceApi.estimate({ projectId, segmentIds: chosenIds, provider, voiceId, speed }));
    },
    {}
  );
  const runGenerate = async (estimateId?: string) => {
    try {
      const r = await voiceApi.generate({ projectId, segmentIds: chosenIds, provider, voiceId, speed, estimateId });
      toast.success(`${r.audio.length} clip(s) queued`);
      setEstimate(null);
      audio.refetch();
    } catch (e: any) {
      toast.error(e.message);
    }
  };
  const regen = useAction((v: { id: string }) => voiceApi.regenerate(v.id, {}), { success: 'Regeneration queued', onSuccess: () => audio.refetch() });
  const del = useAction((id: string) => voiceApi.deleteAudio(id), { success: 'Clip deleted', onSuccess: () => audio.refetch() });

  const st = status.data?.providers;
  const ready = list.length > 0 && voiceId && (cloud ? st?.gemini?.ok : st?.local?.ok);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-2.5">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">Voice Studio</h1>
        </div>
        <span className="flex-1" />
        <div className="flex items-center gap-1.5 text-[10px]">
          <Badge tone={st?.gemini?.ok ? 'ok' : 'danger'}>Gemini {st?.gemini?.ok ? 'ready' : 'off'}</Badge>
          <span title={st?.local?.detail}><Badge tone={st?.local?.ok ? 'ok' : 'warn'}>Local {st?.local?.ok ? 'ready' : 'off'}</Badge></span>
        </div>
        <NativeSelect value={provider} onChange={(e) => { setProvider(e.target.value as 'gemini' | 'local'); }} className="h-7 w-28 text-xs">
          <option value="gemini">Gemini TTS</option>
          <option value="local">Local TTS</option>
        </NativeSelect>
        <NativeSelect value={voiceId} onChange={(e) => setVoiceId(e.target.value)} className="h-7 w-44 text-xs">
          {!providerVoices.length && <option value="">no voices</option>}
          {providerVoices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </NativeSelect>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-muted">speed</span>
          <Slider value={[speed]} min={0.5} max={2} step={0.05} onValueChange={([v]) => setSpeed(v)} className="w-20" />
          <span className="w-8 font-mono text-[10px]">{speed.toFixed(2)}×</span>
        </div>
      </div>

      <Tabs defaultValue="narration" className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-line bg-panel px-4 py-1.5">
          <TabsList>
            <TabsTrigger value="narration">Narration</TabsTrigger>
            <TabsTrigger value="voices">Voices & profiles</TabsTrigger>
          </TabsList>
          <span className="flex-1" />
          <NativeSelect value={language} onChange={(e) => setLanguage(e.target.value)} className="h-7 w-24 text-xs">
            {LANGUAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </NativeSelect>
          <NativeSelect value={mode} onChange={(e) => setMode(e.target.value)} className="h-7 w-28 text-xs">
            <option value="recap">Recap</option>
            <option value="original">Original</option>
          </NativeSelect>
        </div>

        <TabsContent value="narration" className="min-h-0 flex-1 overflow-y-auto p-4">
          {/* preview bar */}
          <div className="mb-3 flex items-center gap-2 rounded-md border border-line bg-panel p-2">
            <Input value={previewText} onChange={(e) => setPreviewText(e.target.value)} placeholder="Preview text…" className="h-8 flex-1 text-xs" />
            <Button size="sm" variant="outline" onClick={preview} loading={previewing} disabled={!voiceId}>
              <Play /> Preview voice
            </Button>
            <audio ref={previewEl} className="hidden" />
          </div>

          {!list.length ? (
            <EmptyState
              icon={AudioLines}
              title="No narration for this language/mode"
              description="Write the story first in AI Story Studio, or switch language/mode."
              action={<Button size="sm" onClick={() => navigate(`/story/${projectId}`)}>Open Story Studio</Button>}
            />
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted">
                <Checkbox
                  checked={selected.size === list.length && list.length > 0}
                  onCheckedChange={(v) => setSelected(v ? new Set(list.map((s) => s.id)) : new Set())}
                />
                <span>{selected.size || 'All'} of {list.length} segments selected</span>
                {selected.size > 0 && <Button size="xs" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>}
              </div>

              {list.map((seg: StorySegment) => {
                const clip = audioBySegment.get(seg.id);
                return (
                  <div key={seg.id} className="rounded-md border border-line bg-panel p-2.5">
                    <div className="flex items-center gap-2">
                      <Checkbox checked={selected.size === 0 || selected.has(seg.id)} onCheckedChange={(v) => setSelected((prev) => { const n = new Set(prev); v ? n.add(seg.id) : n.delete(seg.id); return n; })} />
                      <span className="text-[10px] font-mono text-muted">ch{seg.chapterNumber}·{seg.order}</span>
                      <span className="min-w-0 flex-1 truncate text-xs">{seg.narration}</span>
                      <span className="text-[10px] text-muted">{seg.wordCount}w · ~{formatDuration(seg.estimatedDuration)}</span>
                      {clip && <Badge tone={clip.status === 'ready' ? 'ok' : clip.status === 'failed' ? 'danger' : 'warn'}>{clip.status}</Badge>}
                    </div>
                    {clip && (
                      <div className="mt-2 border-t border-line pt-2">
                        {clip.status === 'ready' && <ClipPlayer audio={clip} />}
                        {clip.status === 'failed' && <p className="text-[11px] text-danger">{clip.error}</p>}
                        {['queued', 'processing'].includes(clip.status) && <p className="text-[11px] text-muted">Generating…</p>}
                        <div className="mt-1 flex items-center gap-1 text-[10px] text-muted">
                          <span>{clip.provider} · {clip.voiceId}{clip.costUSD ? ` · ${formatCost(clip.costUSD)}` : ''} · v{clip.version}</span>
                          <span className="flex-1" />
                          <Button size="xs" variant="ghost" onClick={() => regen.mutate({ id: clip.id })}><RefreshCw /> Re-gen</Button>
                          <Button size="xs" variant="ghost" onClick={() => del.mutate(clip.id)}><Trash2 className="text-danger" /></Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="voices" className="min-h-0 flex-1 overflow-y-auto p-4">
          <ProfilesPanel />
        </TabsContent>
      </Tabs>

      {list.length > 0 && (
        <div className="flex items-center gap-3 border-t border-line bg-panel px-4 py-2.5">
          <span className="text-xs text-muted">
            {chosen.length} clip(s) · {chosen.reduce((n, s) => n + s.wordCount, 0)} words · ≈{formatDuration(chosen.reduce((n, s) => n + s.estimatedDuration, 0) / speed)} narration
          </span>
          <span className="flex-1" />
          <Button variant="primary" size="sm" disabled={!ready || estimateMut.isPending} onClick={() => estimateMut.mutate()}>
            <AudioLines /> {cloud ? 'Estimate & generate' : 'Generate (local, free)'}
          </Button>
        </div>
      )}

      {!ready && (
        <div className="flex items-center gap-2 border-t border-warn/30 bg-warn/10 px-4 py-2 text-xs text-warn">
          <TriangleAlert className="size-3.5" />
          {provider === 'gemini' && !st?.gemini?.ok
            ? 'Gemini is not configured — set GEMINI_API_KEY on the server, or switch to a local engine.'
            : provider === 'local' && !st?.local?.ok
              ? `Local TTS is offline (${st?.local?.detail || 'start ai-service'})`
              : 'Pick a voice to generate.'}
        </div>
      )}

      <EstimateDialog
        estimate={estimate}
        open={!!estimate}
        onOpenChange={(o) => !o && setEstimate(null)}
        confirmLabel={`Generate ${chosen.length} clip(s)`}
        onConfirm={() => runGenerate(estimate!.id)}
      />
    </div>
  );
};
