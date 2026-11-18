import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, API_BASE, ApiError } from './api';
import { useAuth } from '@/stores/auth';
import type { Chapter, ChapterGroup, ComicImage, BBox, CostEstimate, DetectedScene, GeneratedAudio, Job, PdfExport, PriceRow, Project, StoryCharacter, StoryOverview, StorySegment, StudioSettings, TimelineClip, TimelineTrack, TrackKind, TtsVoice, VideoProject, VideoSettings, VideoSummary, VoiceProfile } from './types';

export const useProjects = () => useQuery({ queryKey: ['projects'], queryFn: () => api.get<Project[]>('/api/manga/projects') });

export const useProject = (id?: string) =>
  useQuery({ queryKey: ['project', id], queryFn: () => api.get<Project>(`/api/manga/projects/${id}`), enabled: !!id });

export const useChapters = (projectId?: string) =>
  useQuery({
    queryKey: ['chapters', projectId],
    queryFn: () => api.get<Chapter[]>(`/api/manga/projects/${projectId}/chapters`),
    enabled: !!projectId,
  });

export const useChapterImages = (chapterId?: string) =>
  useQuery({
    queryKey: ['chapter-images', chapterId],
    queryFn: () => api.get<ComicImage[]>(`/api/manga/chapters/${chapterId}/images`),
    enabled: !!chapterId,
    // signed media URLs expire after hours — refresh periodically
    staleTime: 30 * 60_000,
  });

export const useGroups = (projectId?: string) =>
  useQuery({
    queryKey: ['groups', projectId],
    queryFn: () => api.get<ChapterGroup[]>(`/api/manga/projects/${projectId}/groups`),
    enabled: !!projectId,
  });

export const useJobs = (params: { project?: string; status?: string; type?: string } = {}) => {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  return useQuery({
    queryKey: qs ? ['jobs', qs] : ['jobs'],
    queryFn: () => api.get<Job[]>(`/api/jobs${qs ? `?${qs}&limit=200` : '?limit=200'}`),
    refetchInterval: 15_000,
  });
};

export const usePdfExports = (projectId?: string) =>
  useQuery({
    queryKey: ['pdf-exports', projectId],
    queryFn: () => api.get<PdfExport[]>(`/api/pdf/exports${projectId ? `?project=${projectId}` : ''}`),
  });

/** Mutation with toast feedback and query invalidation. */
export const useAction = <TVars = void, TData = unknown>(
  fn: (vars: TVars) => Promise<TData>,
  opts: { success?: string | ((d: TData) => string); invalidate?: unknown[][]; onSuccess?: (d: TData, v: TVars) => void } = {}
) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data, vars) => {
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(data) : opts.success);
      opts.invalidate?.forEach((key) => qc.invalidateQueries({ queryKey: key }));
      opts.onSuccess?.(data, vars);
    },
    onError: (e: Error) => toast.error(e.message),
  });
};

export const jobActions = {
  cancel: (id: string) => api.post<Job>(`/api/jobs/${id}/cancel`),
  retry: (id: string) => api.post<Job>(`/api/jobs/${id}/retry`),
};

// ---------------------------------------------------------------- story

export const useStoryOverview = (projectId?: string, language?: string, mode?: string) =>
  useQuery({
    queryKey: ['story-overview', projectId, language, mode],
    queryFn: () => api.get<StoryOverview>(`/api/story/projects/${projectId}/overview?language=${language}&mode=${mode}`),
    enabled: !!projectId,
    refetchInterval: 15_000,
  });

export const useChapterScenes = (chapterId?: string) =>
  useQuery({
    queryKey: ['scenes', chapterId],
    queryFn: () => api.get<DetectedScene[]>(`/api/story/chapters/${chapterId}/scenes`),
    enabled: !!chapterId,
    staleTime: 30 * 60_000,
  });

export const useSegments = (projectId?: string, language?: string, mode?: string, chapterId?: string) =>
  useQuery({
    queryKey: ['segments', projectId, language, mode, chapterId],
    queryFn: () =>
      api.get<StorySegment[]>(`/api/story/projects/${projectId}/segments?language=${language}&mode=${mode}${chapterId ? `&chapter=${chapterId}` : ''}`),
    enabled: !!projectId,
  });

export const useCharacters = (projectId?: string) =>
  useQuery({ queryKey: ['characters', projectId], queryFn: () => api.get<StoryCharacter[]>(`/api/story/projects/${projectId}/characters`), enabled: !!projectId });

export const storyApi = {
  estimateScenes: (projectId: string, chapterIds: string[]) => api.post<CostEstimate>('/api/story/estimate/scenes', { projectId, chapterIds }),
  estimateStory: (projectId: string, chapterIds: string[], language: string, mode: string) =>
    api.post<CostEstimate>('/api/story/estimate/story', { projectId, chapterIds, language, mode }),
  detect: (projectId: string, chapterIds: string[], estimateId: string, opts: { overwriteEdited?: boolean; redetectPanels?: boolean } = {}) =>
    api.post<Job[]>('/api/story/detect', { projectId, chapterIds, estimateId, ...opts }),
  generate: (projectId: string, chapterIds: string[], language: string, mode: string, estimateId: string, opts: { overwriteEdited?: boolean } = {}) =>
    api.post<Job>('/api/story/generate', { projectId, chapterIds, language, mode, estimateId, ...opts }),
  updateScene: (id: string, body: Partial<DetectedScene>) => api.put<DetectedScene>(`/api/story/scenes/${id}`, body),
  createScene: (chapterId: string, body: { afterSceneId?: string; regions: { image: string; bbox: BBox }[]; title?: string }) =>
    api.post<DetectedScene>(`/api/story/chapters/${chapterId}/scenes`, body),
  deleteScene: (id: string) => api.del(`/api/story/scenes/${id}`),
  splitScene: (id: string, body: { regionIndex?: number; atY?: number }) => api.post<DetectedScene[]>(`/api/story/scenes/${id}/split`, body),
  mergeScenes: (ids: string[]) => api.post<DetectedScene>('/api/story/scenes/merge', { ids }),
  reorderScenes: (chapterId: string, ids: string[]) => api.put(`/api/story/chapters/${chapterId}/scenes/reorder`, { ids }),
  regenerateScene: (id: string, force = false) => api.post<Job>(`/api/story/scenes/${id}/regenerate`, { force }),
  restoreScene: (id: string, historyIndex: number) => api.post<DetectedScene>(`/api/story/scenes/${id}/restore`, { historyIndex }),
  updateSegment: (id: string, body: { narration?: string; title?: string }) => api.put<StorySegment>(`/api/story/segments/${id}`, body),
  deleteSegment: (id: string) => api.del(`/api/story/segments/${id}`),
  splitSegment: (id: string, body: { at: number; sceneSplitIndex?: number }) => api.post<StorySegment[]>(`/api/story/segments/${id}/split`, body),
  mergeSegments: (ids: string[]) => api.post<StorySegment>('/api/story/segments/merge', { ids }),
  reorderSegments: (ids: string[]) => api.put('/api/story/segments/reorder', { ids }),
  rewriteSegment: (id: string, body: { action: string; tone?: string; language?: string; force?: boolean }) =>
    api.post<Job>(`/api/story/segments/${id}/rewrite`, body),
  restoreSegment: (id: string, historyIndex: number) => api.post<StorySegment>(`/api/story/segments/${id}/restore`, { historyIndex }),
};

// ---------------------------------------------------------------- voice

export const useVoiceStatus = () =>
  useQuery({
    queryKey: ['voice-status'],
    queryFn: () => api.get<{ providers: Record<string, { ok: boolean; detail?: string; configured: boolean }>; localTtsUrl: string }>('/api/voice/status'),
    refetchInterval: 30_000,
  });

export const useVoices = () =>
  useQuery({
    queryKey: ['voices'],
    queryFn: () => api.get<{ providerVoices: TtsVoice[]; profiles: VoiceProfile[]; errors: Record<string, string> }>('/api/voice/voices'),
    refetchInterval: 60_000,
  });

export const useProjectAudio = (projectId?: string) =>
  useQuery({ queryKey: ['audio', projectId], queryFn: () => api.get<GeneratedAudio[]>(`/api/voice/audio?project=${projectId}`), enabled: !!projectId });

export const useStudioSettings = () => useQuery({ queryKey: ['studio-settings'], queryFn: () => api.get<StudioSettings>('/api/voice/settings') });
export const usePriceTable = () => useQuery({ queryKey: ['pricing'], queryFn: () => api.get<PriceRow[]>('/api/voice/pricing') });

export const voiceApi = {
  // binary response — bypass the JSON wrapper
  preview: async (body: { provider: string; voiceId: string; text: string; language: string; speed?: number }) => {
    const res = await fetch(`${API_BASE}/api/voice/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${useAuth.getState().accessToken}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new ApiError((await res.json().catch(() => ({})))?.message || `Preview failed (${res.status})`, res.status);
    return res.blob();
  },
  createProfile: (body: Partial<VoiceProfile>) => api.post<VoiceProfile>('/api/voice/profiles', body),
  deleteProfile: (id: string) => api.del(`/api/voice/profiles/${id}`),
  replicate: (id: string, form: FormData) => api.post<VoiceProfile>(`/api/voice/profiles/${id}/replicate`, form),
  estimate: (body: { projectId: string; segmentIds: string[]; provider: string; voiceId: string; speed: number }) =>
    api.post<CostEstimate>('/api/voice/estimate', body),
  generate: (body: { projectId: string; segmentIds: string[]; provider: string; voiceId: string; speed: number; estimateId?: string }) =>
    api.post<{ job: Job; audio: GeneratedAudio[] }>('/api/voice/generate', body),
  regenerate: (id: string, body: { voiceId?: string; speed?: number; estimateId?: string }) =>
    api.post<{ job: Job; audio: GeneratedAudio }>(`/api/voice/audio/${id}/regenerate`, body),
  deleteAudio: (id: string) => api.del(`/api/voice/audio/${id}`),
  updateSettings: (body: Partial<StudioSettings>) => api.put('/api/voice/settings', body),
  refreshFx: () => api.post<{ usdToInr: number }>('/api/voice/settings/refresh-fx'),
};

// ---------------------------------------------------------------- video
export const useVideos = (projectId?: string) =>
  useQuery({ queryKey: ['videos', projectId], queryFn: () => api.get<VideoSummary[]>(`/api/video/projects${projectId ? `?project=${projectId}` : ''}`) });
export const useVideo = (id?: string) =>
  useQuery({ queryKey: ['video', id], queryFn: () => api.get<VideoProject>(`/api/video/projects/${id}`), enabled: !!id });

export const videoApi = {
  create: (body: { mangaProjectId: string; name: string; language?: string; mode?: string; chapterIds?: string[]; settings?: Partial<VideoSettings> }) =>
    api.post<VideoProject>('/api/video/projects', body),
  saveTimeline: (id: string, baseRevision: number, tracks: TimelineTrack[], label?: string) =>
    api.put<VideoProject>(`/api/video/projects/${id}/timeline`, { baseRevision, tracks, label }),
  rebuild: (id: string, chapterIds?: string[]) => api.post<VideoProject>(`/api/video/projects/${id}/rebuild`, { chapterIds }),
  updateClip: (vid: string, trackId: string, clipId: string, body: Partial<TimelineClip>) =>
    api.put<VideoProject>(`/api/video/projects/${vid}/tracks/${trackId}/clips/${clipId}`, body),
  splitClip: (vid: string, trackId: string, clipId: string, at: number) =>
    api.post<VideoProject>(`/api/video/projects/${vid}/tracks/${trackId}/clips/${clipId}/split`, { at }),
  mergeClips: (vid: string, trackId: string, ids: string[]) =>
    api.post<VideoProject>(`/api/video/projects/${vid}/clips/merge`, { trackId, ids }),
  deleteClip: (vid: string, trackId: string, clipId: string) =>
    api.del(`/api/video/projects/${vid}/tracks/${trackId}/clips/${clipId}`),
  addTrack: (vid: string, kind: TrackKind, name: string) =>
    api.post<VideoProject>(`/api/video/projects/${vid}/tracks`, { kind, name }),
  updateTrack: (vid: string, trackId: string, body: Partial<TimelineTrack>) =>
    api.put<VideoProject>(`/api/video/projects/${vid}/tracks/${trackId}`, body),
  deleteTrack: (vid: string, trackId: string) => api.del(`/api/video/projects/${vid}/tracks/${trackId}`),
  createVersion: (vid: string, label: string) => api.post(`/api/video/projects/${vid}/versions`, { label }),
  restore: (vid: string, index: number) => api.post<VideoProject>(`/api/video/projects/${vid}/restore`, { index }),
  render: (vid: string) => api.post<{ job: Job }>(`/api/video/projects/${vid}/render`),
  remove: (vid: string) => api.del(`/api/video/projects/${vid}`),
};
