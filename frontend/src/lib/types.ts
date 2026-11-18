export type JobStatus = 'queued' | 'active' | 'retrying' | 'completed' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  type: string;
  title: string;
  status: JobStatus;
  progress: number;
  stage?: string;
  project?: string;
  target?: { kind: string; id: string };
  result?: Record<string, any>;
  error?: { message: string; code?: string };
  attempts: number;
  maxAttempts: number;
  runCount: number;
  cancelRequested: boolean;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
  logs?: { at: string; level: 'info' | 'warn' | 'error'; message: string }[];
}

export interface ProjectStats {
  chapters: number;
  ready: number;
  images: number;
  stories: number;
}

export interface Project {
  id: string;
  title: string;
  description?: string;
  language: string;
  narrationLanguage: string;
  narrationMode: 'original' | 'recap';
  status: 'active' | 'archived';
  tags: string[];
  coverUrl: string | null;
  continuitySummary?: string;
  continuityThrough?: number;
  createdAt: string;
  updatedAt: string;
  stats?: ProjectStats;
}

export interface Chapter {
  id: string;
  project: string;
  number: number;
  title: string;
  order: number;
  status: 'uploaded' | 'extracting' | 'ready' | 'failed';
  imageCount: number;
  brokenImageCount: number;
  error?: string;
  analysisStatus: 'none' | 'processing' | 'done' | 'failed';
  storyStatus: 'none' | 'processing' | 'done' | 'failed';
  kind?: 'chapter' | 'merged';
  sourceChapters?: string[];
  pdfExport?: string;
  /** Leading archive pages skipped at extraction (cover pages) */
  skipPages?: number;
  summary?: string;
  extractedAt?: string;
  createdAt: string;
  archive?: { id: string; fileName: string; size: number };
  job?: Job;
}

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ComicImage {
  id: string;
  chapter: string;
  index: number;
  entryName: string;
  width: number;
  height: number;
  format?: string;
  size: number;
  isTall: boolean;
  status: 'ok' | 'broken' | 'replaced';
  error?: string;
  url: string | null;
  originalUrl: string | null;
  thumbnailUrl: string | null;
  hasReplacement: boolean;
  panels: { id: string; bbox: BBox; order: number; source: 'cv' | 'ai' | 'user'; confidence?: number }[];
  panelsDetectedAt?: string;
}

export interface ChapterGroup {
  id: string;
  project: string;
  name: string;
  startNumber: number;
  endNumber: number;
  chapters: string[];
  createdAt: string;
}

export interface UploadSession {
  id: string;
  fileName: string;
  size: number;
  chunkSize: number;
  totalChunks: number;
  received: number[];
  status: string;
  resumed?: boolean;
  warnings?: string[];
}

export interface PdfExport {
  id: string;
  project: string;
  fileName: string;
  chapters: string[];
  options: { pageNumbers: boolean; bookmarks: boolean; compression: 'none' | 'balanced' | 'small' };
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  pageCount?: number;
  size?: number;
  error?: string;
  job?: Job | string;
  downloadUrl: string | null;
  previewUrl: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------- story
export interface SceneRegion {
  image: string;
  bbox: BBox;
  order: number;
  imageIndex?: number;
  imageUrl: string | null;
  thumbnailUrl: string | null;
  width?: number;
  height?: number;
}

export interface DetectedScene {
  id: string;
  project: string;
  chapter: string;
  chapterNumber: number;
  order: number;
  regions: SceneRegion[];
  thumbnailUrl: string | null;
  title?: string;
  characters: string[];
  location?: string;
  action?: string;
  emotion?: string;
  description?: string;
  events: string[];
  dialogues: { speaker?: string; text: string; kind: string; uncertain: boolean }[];
  storyContext?: string;
  confidence?: number;
  source: 'ai' | 'user' | 'imported';
  userEdited: boolean;
  version: number;
  history: { index: number; at: string; source: string; note?: string; hasData: boolean }[];
  updatedAt: string;
}

export interface StorySegment {
  id: string;
  project: string;
  chapter: string;
  chapterNumber: number;
  scenes: string[];
  order: number;
  language: string;
  mode: 'original' | 'recap';
  title?: string;
  narration: string;
  tone?: string;
  emotion?: string;
  wordCount: number;
  estimatedDuration: number;
  confidence?: number;
  uncertainties: string[];
  userEdited: boolean;
  version: number;
  history: { index: number; at: string; source: string; note?: string; title?: string; narration: string }[];
  updatedAt: string;
}

export interface StoryCharacter {
  id: string;
  name: string;
  aliases: string[];
  description?: string;
  appearance?: string;
  role?: string;
  firstChapter?: number;
  lastChapter?: number;
  pronunciation?: string;
  source: 'ai' | 'user' | 'api';
  external?: { provider: string; id: number; url?: string; imageUrl?: string };
}

export interface CostEstimate {
  id: string;
  kind: string;
  provider: string;
  model: string;
  params: Record<string, any>;
  items: { key: string; label: string; chapterNumber?: number; requests?: number; inputTokens?: number; outputTokens?: number; meta?: Record<string, any>; costUSD: number }[];
  totals: { inputTokens: number; outputTokens: number; thoughtTokens: number; requests: number; costUSD: number };
  local?: { provider?: string; costUSD: number; notes?: string };
  pricing?: { version: string; inputPerMillion: number; outputPerMillion: number };
  costINR?: number;
  tokenCountMethod?: string;
  assumptions?: string[];
  budgetLimitUSD?: number;
  withinBudget: boolean;
  approvedAt?: string;
  job?: string;
  actual?: { costUSD: number; inputTokens: number; outputTokens: number; calls: number } | null;
  createdAt: string;
  isEstimate: boolean;
}

export interface StoryOverview {
  project: { id: string; title: string; narrationLanguage: string; narrationMode: 'original' | 'recap'; continuitySummary?: string; continuityThrough?: number };
  aiConfigured: boolean;
  aiProvider?: 'gemini' | 'local';
  language: string;
  mode: string;
  chapters: {
    id: string;
    number: number;
    title?: string;
    kind?: 'chapter' | 'merged';
    sourceChapters?: string[];
    pdf?: { id: string; fileName: string; status: string; pageCount?: number; size?: number; url?: string };
    status: string;
    imageCount: number;
    brokenImageCount: number;
    analysisStatus: string;
    storyStatus: string;
    summary?: string;
    scenes: number;
    editedScenes: number;
    segments: number;
    editedSegments: number;
    words: number;
    duration: number;
  }[];
}

// ---------------------------------------------------------------- voice
export interface TtsVoice {
  id: string;
  name: string;
  provider: 'gemini' | 'local';
  engine?: string;
  languages: string[];
  gender?: string;
  description?: string;
  custom?: boolean;
}

export interface VoiceProfile {
  id: string;
  name: string;
  provider: 'gemini' | 'local';
  kind: 'prebuilt' | 'custom';
  voiceId: string;
  engine?: string;
  language: string;
  languages: string[];
  gender?: string;
  description?: string;
  styleHint?: string;
  referenceUrl?: string | null;
  consentConfirmed: boolean;
  status: 'ready' | 'pending' | 'failed';
  statusError?: string;
  createdAt: string;
}

export interface GeneratedAudio {
  id: string;
  project: string;
  chapter?: string;
  chapterNumber?: number;
  segment?: string;
  purpose: 'narration' | 'preview' | 'reference';
  text: string;
  characters: number;
  words: number;
  language: string;
  provider: 'gemini' | 'local';
  modelId?: string;
  voiceId: string;
  speed: number;
  url: string | null;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  error?: string;
  duration?: number;
  waveform?: { peaks: number[]; duration: number; sampleRate: number };
  inputTokens?: number;
  outputTokens?: number;
  costUSD?: number;
  version: number;
  history: { at: string; voiceId: string; url: string | null; duration?: number }[];
  updatedAt: string;
}

export interface StudioSettings {
  budgetLimitUSD: number;
  confirmAboveUSD: number;
  displayCurrency: 'USD' | 'INR';
  usdToInr?: number;
  usdToInrUpdatedAt?: string;
  usdToInrSource?: string;
  pricingTier: 'standard' | 'batch';
  aiProvider: 'gemini' | 'local';
  defaultTtsProvider: 'local' | 'gemini';
  defaultVoiceProfile?: string;
  narrationLanguage: string;
  narrationMode: 'original' | 'recap';
  wordsPerMinute: Record<string, number>;
}

export interface PriceRow {
  provider: string;
  model: string;
  kind: string;
  tier: string;
  inputPerMillion: number;
  outputPerMillion: number;
  audioTokensPerSecond?: number;
  effectiveFrom: string;
  effectiveTo?: string;
  version: string;
}

// ---------------------------------------------------------------- video
export interface Keyframe {
  at: number;
  scale: number;
  x: number;
  y: number;
  opacity?: number;
  easing: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';
}

export interface VideoTransition {
  type: 'none' | 'fade' | 'crossfade' | 'slide-left' | 'slide-right' | 'zoom' | 'wipe';
  duration: number;
}

export type AnimationType = 'none' | 'zoom-in' | 'zoom-out' | 'pan-left' | 'pan-right' | 'pan-up' | 'pan-down' | 'ken-burns' | 'custom';
export type ClipKind = 'image' | 'audio' | 'video' | 'text';
export type TrackKind = 'background' | 'image' | 'narration' | 'music' | 'sfx' | 'subtitle' | 'overlay';

export interface TimelineClip {
  id: string;
  name?: string;
  label?: string;
  kind: ClipKind;
  start: number;
  duration: number;
  mediaStart: number;
  gain: number;
  muted: boolean;
  scene?: string;
  image?: string;
  audio?: string;
  segment?: string;
  text?: string;
  animation: { type: AnimationType; keyframes: Keyframe[] };
  transitionIn: VideoTransition;
  transitionOut: VideoTransition;
  backdrop: boolean;
  media?: {
    imageUrl?: string;
    thumbnailUrl?: string;
    imageWidth?: number;
    imageHeight?: number;
    broken?: boolean;
    audioUrl?: string;
    audioDuration?: number;
    waveform?: { peaks: number[] };
  };
}

export interface TimelineTrack {
  id: string;
  kind: TrackKind;
  name: string;
  muted: boolean;
  locked: boolean;
  order: number;
  clips: TimelineClip[];
}

export interface VideoSettings {
  width: number;
  height: number;
  fps: number;
  layout: 'blur-fill' | 'fit' | 'fill' | 'original';
  bgBlur: number;
  bgDim: number;
  targetDurationSec?: number;
}

export interface VideoProject {
  id: string;
  project: string;
  name: string;
  language: string;
  mode: 'original' | 'recap';
  settings: VideoSettings;
  estimatedDuration: number;
  revision: number;
  renderStatus: 'idle' | 'queued' | 'rendering' | 'done' | 'failed';
  outputUrl?: string;
  tracks: TimelineTrack[];
  versions: { index: number; at: string; label: string; revision: number }[];
  updatedAt: string;
}

export interface VideoSummary {
  id: string;
  project: string;
  name: string;
  language: string;
  mode: 'original' | 'recap';
  estimatedDuration: number;
  revision: number;
  renderStatus: string;
  outputUrl?: string;
  updatedAt: string;
}
