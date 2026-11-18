import { Types } from 'mongoose';
import MangaChapter from 'models/manga-chapter.model';
import DetectedScene, { IDetectedSceneDocument } from 'models/detected-scene.model';
import StorySegment from 'models/story-segment.model';
import GeneratedAudio from 'models/generated-audio.model';
import VideoProject, { IClip, ITrack, IVideoProjectDocument } from 'models/video-project.model';

const mkTrack = (kind: ITrack['kind'], name: string, order: number): ITrack =>
  ({ _id: new Types.ObjectId(), kind, name, muted: false, locked: false, order, clips: [] }) as ITrack;

const mkClip = (partial: Partial<IClip> & Pick<IClip, 'kind' | 'start' | 'duration'>): IClip =>
  ({
    _id: new Types.ObjectId(),
    mediaStart: 0,
    gain: 1,
    muted: false,
    animation: { type: 'ken-burns', keyframes: [] },
    transitionIn: { type: 'fade', duration: 0.4 },
    transitionOut: { type: 'none', duration: 0 },
    backdrop: false,
    ...partial,
  }) as IClip;

/**
 * Build an editable timeline: one image clip (+ blurred backdrop clip) per
 * detected scene, timed to its narration; narration audio clips on their own
 * track; subtitles from the segment text. Every clip keeps a live reference
 * to its source scene/image/audio — nothing is copied.
 */
export const buildTimeline = async (video: IVideoProjectDocument, chapterIds?: string[]) => {
  const chapterFilter: Record<string, unknown> = { project: video.project, status: 'ready' };
  if (chapterIds?.length) chapterFilter._id = { $in: chapterIds };
  const chapters = await MangaChapter.find(chapterFilter).sort({ number: 1, order: 1 });
  const segments = await StorySegment.find({ chapter: { $in: chapters.map((c) => c._id) }, language: video.language, mode: video.mode }).sort({ chapterNumber: 1, order: 1 });
  const audios = await GeneratedAudio.find({ project: video.project, segment: { $in: segments.map((s) => s._id) }, status: 'ready' });
  const audioBySegment = new Map(audios.map((a) => [String(a.segment), a]));
  const scenesByChapter = new Map<string, IDetectedSceneDocument[]>();
  for (const c of chapters) scenesByChapter.set(String(c._id), await DetectedScene.find({ chapter: c._id }).sort({ order: 1 }));

  const sceneToSeg = new Map<string, (typeof segments)[number]>();
  for (const seg of segments) for (const sid of seg.scenes) sceneToSeg.set(String(sid), seg);

  const bg = mkTrack('background', 'Background fill', 0);
  const images = mkTrack('image', 'Scenes', 1);
  const narration = mkTrack('narration', 'Narration', 2);
  const subtitles = mkTrack('subtitle', 'Subtitles', 3);
  const music = mkTrack('music', 'Music', 4);

  let cursor = 0;
  let lastEnd = 0;
  for (const chapter of chapters) {
    const scenes = scenesByChapter.get(String(chapter._id)) || [];
    const chapterSegs = segments.filter((s) => String(s.chapter) === String(chapter._id));
    const segStart = new Map<string, number>();
    const segSpan = new Map<string, number>();

    for (const scene of scenes) {
      const seg = sceneToSeg.get(String(scene._id));
      const audio = seg ? audioBySegment.get(String(seg._id)) : undefined;
      const sceneCount = seg ? Math.max(1, seg.scenes.length) : 1;
      const spoken = audio?.duration ?? seg?.estimatedDuration ?? 0;
      const dur = Math.max(1.2, spoken / sceneCount || 3);
      const start = cursor;

      // narration audio clips are placed once, at the scene span start
      if (seg && audio && !segStart.has(String(seg._id))) {
        segStart.set(String(seg._id), start);
        segSpan.set(String(seg._id), 0);
      }
      if (seg) segSpan.set(String(seg._id), (segSpan.get(String(seg._id)) || 0) + dur);

      const region = scene.regions[0];
      const clip = mkClip({
        kind: 'image',
        start,
        duration: dur,
        scene: scene._id as Types.ObjectId,
        image: region?.image,
        segment: seg?._id as Types.ObjectId | undefined,
        name: scene.title || `Ch${chapter.number} · scene ${scene.order}`,
      });
      images.clips.push(clip);
      bg.clips.push(mkClip({ kind: 'image', start, duration: dur, image: region?.image, scene: scene._id as Types.ObjectId, backdrop: true, name: `bg ${scene.order}` }));
      cursor += dur;
      lastEnd = Math.max(lastEnd, cursor);
    }

    for (const seg of chapterSegs) {
      const audio = audioBySegment.get(String(seg._id));
      const start = segStart.get(String(seg._id));
      const span = segSpan.get(String(seg._id)) || audio?.duration || seg.estimatedDuration;
      if (start !== undefined) {
        if (audio) {
          narration.clips.push(
            mkClip({ kind: 'audio', start, duration: audio.duration || span, audio: audio._id as Types.ObjectId, segment: seg._id as Types.ObjectId, name: `Ch${seg.chapterNumber} narration ${seg.order}` })
          );
        }
        subtitles.clips.push(
          mkClip({ kind: 'text', start, duration: span, text: seg.narration, segment: seg._id as Types.ObjectId, name: `sub ${seg.chapterNumber}.${seg.order}` })
        );
      }
    }
  }

  video.tracks = [bg, images, narration, subtitles, music];
  video.estimatedDuration = Math.round(lastEnd * 10) / 10;
  video.revision += 1;
  return video;
};

/** Timeline end (seconds) — the longest clip end across tracks. */
export const timelineDuration = (tracks: ITrack[]) => {
  let end = 0;
  for (const t of tracks) for (const c of t.clips) end = Math.max(end, c.start + c.duration);
  return Math.round(end * 10) / 10;
};

/** Snapshot the current timeline into the version ring (keeps 25). */
export const snapshotVersion = (video: IVideoProjectDocument, label: string) => {
  video.versions.push({ at: new Date(), label, revision: video.revision, tracks: video.tracks });
  video.versions = video.versions.slice(-25) as any;
};
