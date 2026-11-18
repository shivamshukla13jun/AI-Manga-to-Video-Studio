import { mediaUrl } from 'libs/studio/media';
import type { IDetectedSceneDocument } from 'models/detected-scene.model';
import type { IStorySegmentDocument } from 'models/story-segment.model';
import type { ICharacterDocument } from 'models/character.model';
import type { IComicImageDocument } from 'models/comic-image.model';

export const serializeScene = (s: IDetectedSceneDocument, images?: Map<string, IComicImageDocument>) => {
  const regions = s.regions.map((r) => {
    const img = images?.get(String(r.image));
    return {
      image: String(r.image),
      bbox: r.bbox,
      order: r.order,
      imageIndex: img?.index,
      imageUrl: img ? mediaUrl(img.file) : null,
      thumbnailUrl: img ? mediaUrl(img.thumbnail) : null,
      width: img?.width,
      height: img?.height,
    };
  });
  return {
    id: String(s._id),
    project: String(s.project),
    chapter: String(s.chapter),
    chapterNumber: s.chapterNumber,
    order: s.order,
    regions,
    // Scenes store no files — the card thumbnail falls back to the first region's page thumb
    thumbnailUrl: mediaUrl(s.thumbnail) ?? regions[0]?.thumbnailUrl ?? null,
    title: s.title,
    characters: s.characters,
    location: s.location,
    action: s.action,
    emotion: s.emotion,
    description: s.description,
    events: s.events,
    dialogues: s.dialogues,
    storyContext: s.storyContext,
    confidence: s.confidence,
    source: s.source,
    userEdited: s.userEdited,
    version: s.version,
    history: s.history.map((h, i) => ({ index: i, at: h.at, source: h.source, note: h.note, hasData: !!h.data })),
    updatedAt: s.updatedAt,
  };
};

export const serializeSegment = (g: IStorySegmentDocument) => ({
  id: String(g._id),
  project: String(g.project),
  chapter: String(g.chapter),
  chapterNumber: g.chapterNumber,
  scenes: g.scenes.map(String),
  order: g.order,
  language: g.language,
  mode: g.mode,
  title: g.title,
  narration: g.narration,
  tone: g.tone,
  emotion: g.emotion,
  wordCount: g.wordCount,
  estimatedDuration: g.estimatedDuration,
  confidence: g.confidence,
  uncertainties: g.uncertainties,
  userEdited: g.userEdited,
  version: g.version,
  history: g.history.map((h, i) => ({ index: i, at: h.at, source: h.source, note: h.note, title: h.title, narration: h.narration })),
  updatedAt: g.updatedAt,
});

export const serializeCharacter = (c: ICharacterDocument) => ({
  id: String(c._id),
  name: c.name,
  aliases: c.aliases,
  description: c.description,
  appearance: c.appearance,
  role: c.role,
  firstChapter: c.firstChapter,
  lastChapter: c.lastChapter,
  pronunciation: c.pronunciation,
  source: c.source,
  external: c.external,
});
