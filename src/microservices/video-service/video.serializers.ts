import { Types } from 'mongoose';
import ComicImage from 'models/comic-image.model';
import GeneratedAudio from 'models/generated-audio.model';
import { mediaUrl } from 'libs/studio/media';
import type { IClip, IVideoProjectDocument } from 'models/video-project.model';

const serializeClip = (c: IClip, media: { images: Map<string, any>; audios: Map<string, any> }) => {
  const img = c.image ? media.images.get(String(c.image)) : undefined;
  const aud = c.audio ? media.audios.get(String(c.audio)) : undefined;
  return {
    id: String(c._id),
    name: c.name,
    label: c.label,
    kind: c.kind,
    start: c.start,
    duration: c.duration,
    mediaStart: c.mediaStart,
    gain: c.gain,
    muted: c.muted,
    scene: c.scene ? String(c.scene) : undefined,
    image: c.image ? String(c.image) : undefined,
    audio: c.audio ? String(c.audio) : undefined,
    segment: c.segment ? String(c.segment) : undefined,
    text: c.text,
    animation: c.animation,
    transitionIn: c.transitionIn,
    transitionOut: c.transitionOut,
    backdrop: c.backdrop,
    media: {
      imageUrl: img ? mediaUrl(img.file) : undefined,
      thumbnailUrl: img ? mediaUrl(img.thumbnail) : undefined,
      imageWidth: img?.width,
      imageHeight: img?.height,
      broken: img ? img.status === 'broken' : false,
      audioUrl: aud ? mediaUrl(aud.file) : undefined,
      audioDuration: aud?.duration,
      waveform: aud?.waveform,
    },
  };
};

export const serializeVideoProject = async (v: IVideoProjectDocument) => {
  const imageIds = new Set<string>();
  const audioIds = new Set<string>();
  for (const t of v.tracks)
    for (const c of t.clips) {
      if (c.image) imageIds.add(String(c.image));
      if (c.audio) audioIds.add(String(c.audio));
    }
  const [images, audios] = await Promise.all([
    ComicImage.find({ _id: { $in: [...imageIds] } }).select('file thumbnail width height status index'),
    GeneratedAudio.find({ _id: { $in: [...audioIds] } }).select('file duration waveform voiceId status'),
  ]);
  const media = {
    images: new Map(images.map((i) => [String(i._id), i])),
    audios: new Map(audios.map((a) => [String(a._id), a])),
  };
  return {
    id: String(v._id),
    project: String(v.project),
    name: v.name,
    language: v.language,
    mode: v.mode,
    settings: v.settings,
    estimatedDuration: v.estimatedDuration,
    revision: v.revision,
    renderStatus: v.renderStatus,
    outputUrl: mediaUrl(v.outputFile),
    tracks: [...v.tracks]
      .sort((a, b) => a.order - b.order)
      .map((t) => ({
        id: String(t._id),
        kind: t.kind,
        name: t.name,
        muted: t.muted,
        locked: t.locked,
        order: t.order,
        clips: [...t.clips].sort((a, b) => a.start - b.start).map((c) => serializeClip(c, media)),
      })),
    versions: v.versions.map((ver, i) => ({ index: i, at: ver.at, label: ver.label, revision: ver.revision })),
    updatedAt: v.updatedAt,
  };
};

export const serializeVideoSummary = (v: IVideoProjectDocument) => ({
  id: String(v._id),
  project: String(v.project),
  name: v.name,
  language: v.language,
  mode: v.mode,
  estimatedDuration: v.estimatedDuration,
  revision: v.revision,
  renderStatus: v.renderStatus,
  outputUrl: mediaUrl(v.outputFile),
  updatedAt: v.updatedAt,
});
