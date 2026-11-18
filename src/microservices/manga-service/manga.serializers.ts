import { mediaUrl } from 'libs/studio/media';
import type { IMangaProjectDocument } from 'models/manga-project.model';
import type { IMangaChapterDocument } from 'models/manga-chapter.model';
import type { IComicImageDocument } from 'models/comic-image.model';
import type { IChapterGroupDocument } from 'models/chapter-group.model';
import type { IUploadSessionDocument } from 'models/upload-session.model';

export const serializeProject = (p: IMangaProjectDocument, stats?: Record<string, number>) => ({
  id: String(p._id),
  title: p.title,
  description: p.description,
  language: p.language,
  narrationLanguage: p.narrationLanguage,
  narrationMode: p.narrationMode,
  status: p.status,
  tags: p.tags,
  coverUrl: mediaUrl(p.cover),
  continuitySummary: p.continuitySummary,
  continuityThrough: p.continuityThrough,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
  stats,
});

export const serializeChapter = (c: IMangaChapterDocument, extra?: Record<string, unknown>) => ({
  id: String(c._id),
  project: String(c.project),
  number: c.number,
  title: c.title,
  order: c.order,
  status: c.status,
  imageCount: c.imageCount,
  brokenImageCount: c.brokenImageCount,
  error: c.error,
  analysisStatus: c.analysisStatus,
  storyStatus: c.storyStatus,
  summary: c.summary,
  extractedAt: c.extractedAt,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
  ...extra,
});

export const serializeImage = (img: IComicImageDocument) => ({
  id: String(img._id),
  chapter: String(img.chapter),
  index: img.index,
  entryName: img.entryName,
  width: img.width,
  height: img.height,
  format: img.format,
  size: img.size,
  isTall: img.isTall,
  status: img.status,
  error: img.error,
  url: mediaUrl(img.file),
  originalUrl: mediaUrl(img.originalFile),
  thumbnailUrl: mediaUrl(img.thumbnail),
  hasReplacement: !!img.originalFile && String(img.originalFile) !== String(img.file),
  panels: img.panels.map((p) => ({ id: String(p._id), bbox: p.bbox, order: p.order, source: p.source, confidence: p.confidence })),
  panelsDetectedAt: img.panelsDetectedAt,
});

export const serializeGroup = (g: IChapterGroupDocument) => ({
  id: String(g._id),
  project: String(g.project),
  name: g.name,
  startNumber: g.startNumber,
  endNumber: g.endNumber,
  chapters: g.chapters.map(String),
  createdAt: g.createdAt,
});

export const serializeUpload = (s: IUploadSessionDocument) => ({
  id: String(s._id),
  project: String(s.project),
  fileName: s.fileName,
  size: s.size,
  chunkSize: s.chunkSize,
  totalChunks: s.totalChunks,
  received: s.received,
  status: s.status,
  error: s.error,
  chapter: s.chapter ? String(s.chapter) : undefined,
  chapterNumber: s.chapterNumber,
  chapterTitle: s.chapterTitle,
  expiresAt: s.expiresAt,
});
