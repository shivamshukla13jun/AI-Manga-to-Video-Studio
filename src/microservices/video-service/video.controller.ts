import { Request } from 'express';
import { Types } from 'mongoose';
import { AppError } from 'middlewares/error';
import VideoProject, { IClip, IVideoProjectDocument } from 'models/video-project.model';
import { asyncHandler, assertObjectId, notFound, ok, ownerFilter } from 'libs/studio/http';
import { getProject } from 'microservices/manga-service/manga.service';
import { enqueueJob, serializeJob } from 'libs/jobs/job.service';
import { buildTimeline, snapshotVersion, timelineDuration } from './video.service';
import { serializeVideoProject, serializeVideoSummary } from './video.serializers';

const getVideo = async (req: Request, id: unknown) => {
  const v = await VideoProject.findOne({ _id: assertObjectId(id, 'video id'), ...ownerFilter(req) });
  if (!v) throw notFound('Video project');
  return v;
};

const findClip = (video: IVideoProjectDocument, trackId: string, clipId: string) => {
  const track = video.tracks.find((t) => String(t._id) === trackId);
  if (!track) throw notFound('Track');
  const idx = track.clips.findIndex((c) => String(c._id) === clipId);
  if (idx === -1) throw notFound('Clip');
  return { track, clip: track.clips[idx], idx };
};

const touch = (video: IVideoProjectDocument) => {
  video.revision += 1;
  video.estimatedDuration = timelineDuration(video.tracks);
};

// ------------------------------------------------------------------ CRUD
export const createVideo = asyncHandler(async (req, res) => {
  const project = await getProject(req, req.body.mangaProjectId);
  const video = await VideoProject.create({
    owner: req.user!._id,
    project: project._id,
    name: req.body.name,
    language: req.body.language,
    mode: req.body.mode,
    settings: req.body.settings,
    tracks: [],
  });
  await buildTimeline(video, req.body.chapterIds);
  snapshotVersion(video, 'auto-build');
  await video.save();
  ok(res, await serializeVideoProject(video), 201);
});

export const listVideos = asyncHandler(async (req, res) => {
  const filter: Record<string, unknown> = ownerFilter(req);
  if (req.query.project) filter.project = assertObjectId(req.query.project, 'project id');
  const list = await VideoProject.find(filter).sort({ updatedAt: -1 }).limit(100);
  ok(res, list.map(serializeVideoSummary));
});

export const getVideoProject = asyncHandler(async (req, res) => {
  ok(res, await serializeVideoProject(await getVideo(req, req.params.videoId)));
});

export const deleteVideo = asyncHandler(async (req, res) => {
  const video = await getVideo(req, req.params.videoId);
  await video.deleteOne();
  ok(res, { id: String(video._id) });
});

// ------------------------------------------------------------- timeline
/** Full-timeline save (editor autosave + undo/redo persist). Optimistic concurrency via baseRevision. */
export const saveTimeline = asyncHandler(async (req, res) => {
  const video = await getVideo(req, req.params.videoId);
  if (req.body.baseRevision !== video.revision) {
    throw new AppError(`Timeline changed elsewhere (server revision ${video.revision}) — reload before saving`, 409, { serverRevision: video.revision });
  }
  video.tracks = req.body.tracks.map((t: any) => ({
    _id: t.id && /^[a-f\d]{24}$/i.test(t.id) ? new Types.ObjectId(t.id) : new Types.ObjectId(),
    kind: t.kind,
    name: t.name,
    muted: t.muted,
    locked: t.locked,
    order: t.order,
    clips: t.clips.map((c: any) => ({
      _id: c.id && /^[a-f\d]{24}$/i.test(c.id) ? new Types.ObjectId(c.id) : new Types.ObjectId(),
      name: c.name,
      label: c.label,
      kind: c.kind,
      start: c.start,
      duration: c.duration,
      mediaStart: c.mediaStart,
      gain: c.gain,
      muted: c.muted,
      scene: c.scene,
      image: c.image,
      audio: c.audio,
      segment: c.segment,
      text: c.text,
      animation: c.animation,
      transitionIn: c.transitionIn,
      transitionOut: c.transitionOut,
      backdrop: c.backdrop,
    })),
  }));
  touch(video);
  if (req.body.label) snapshotVersion(video, req.body.label);
  await video.save();
  ok(res, await serializeVideoProject(video));
});

export const rebuild = asyncHandler(async (req, res) => {
  const video = await getVideo(req, req.params.videoId);
  snapshotVersion(video, 'before rebuild');
  await buildTimeline(video, req.body.chapterIds);
  await video.save();
  ok(res, await serializeVideoProject(video));
});

// ------------------------------------------------------------- clip ops
export const updateClip = asyncHandler(async (req, res) => {
  const video = await getVideo(req, req.params.videoId);
  const { track, clip } = findClip(video, req.params.trackId, req.params.clipId);
  if (track.locked) throw new AppError('Track is locked', 409);
  const allowed = ['name', 'label', 'start', 'duration', 'mediaStart', 'gain', 'muted', 'animation', 'transitionIn', 'transitionOut', 'text', 'image', 'scene', 'audio', 'segment', 'backdrop', 'kind'];
  for (const k of allowed) if (req.body[k] !== undefined) (clip as any)[k] = req.body[k];
  touch(video);
  await video.save();
  ok(res, await serializeVideoProject(video));
});

export const splitClip = asyncHandler(async (req, res) => {
  const video = await getVideo(req, req.params.videoId);
  const { track, clip, idx } = findClip(video, req.params.trackId, req.params.clipId);
  if (track.locked) throw new AppError('Track is locked', 409);
  const at = req.body.at;
  if (at <= clip.start || at >= clip.start + clip.duration) throw new AppError('Split point must be inside the clip', 400);
  const right: IClip = {
    ...(typeof (clip as any).toObject === 'function' ? (clip as any).toObject() : clip),
    _id: new Types.ObjectId(),
    start: at,
    duration: clip.start + clip.duration - at,
    mediaStart: clip.mediaStart + (at - clip.start),
    transitionIn: { type: 'none', duration: 0 },
  } as IClip;
  clip.duration = at - clip.start;
  clip.transitionOut = { type: 'none', duration: 0 };
  track.clips.splice(idx + 1, 0, right);
  touch(video);
  await video.save();
  ok(res, await serializeVideoProject(video));
});

/** Merge adjacent clips on one track into the earliest — image recovery / join fragments. */
export const mergeClips = asyncHandler(async (req, res) => {
  const video = await getVideo(req, req.params.videoId);
  const track = video.tracks.find((t) => String(t._id) === req.body.trackId);
  if (!track) throw notFound('Track');
  if (track.locked) throw new AppError('Track is locked', 409);
  const picked = track.clips.filter((c) => req.body.ids.includes(String(c._id))).sort((a, b) => a.start - b.start);
  if (picked.length !== req.body.ids.length) throw notFound('Clip');
  const all = [...track.clips].sort((a, b) => a.start - b.start);
  const idxs = picked.map((c) => all.findIndex((x) => String(x._id) === String(c._id)));
  if (!idxs.every((v, i) => i === 0 || v === idxs[i - 1] + 1)) throw new AppError('Only adjacent clips can be merged', 400);
  const [first, ...rest] = picked;
  first.duration = rest[rest.length - 1].start + rest[rest.length - 1].duration - first.start;
  first.transitionOut = rest[rest.length - 1].transitionOut;
  track.clips = track.clips.filter((c) => !rest.some((r) => String(r._id) === String(c._id)));
  touch(video);
  await video.save();
  ok(res, await serializeVideoProject(video));
});

export const deleteClip = asyncHandler(async (req, res) => {
  const video = await getVideo(req, req.params.videoId);
  const { track } = findClip(video, req.params.trackId, req.params.clipId);
  if (track.locked) throw new AppError('Track is locked', 409);
  track.clips = track.clips.filter((c) => String(c._id) !== req.params.clipId);
  touch(video);
  await video.save();
  ok(res, await serializeVideoProject(video));
});

export const addClip = asyncHandler(async (req, res) => {
  const video = await getVideo(req, req.params.videoId);
  const track = video.tracks.find((t) => String(t._id) === req.body.trackId);
  if (!track) throw notFound('Track');
  if (track.locked) throw new AppError('Track is locked', 409);
  track.clips.push({ ...req.body.clip, _id: new Types.ObjectId() } as IClip);
  touch(video);
  await video.save();
  ok(res, await serializeVideoProject(video));
});

// ------------------------------------------------------------ track ops
export const addTrack = asyncHandler(async (req, res) => {
  const video = await getVideo(req, req.params.videoId);
  video.tracks.push({ _id: new Types.ObjectId(), kind: req.body.kind, name: req.body.name, muted: false, locked: false, order: video.tracks.length, clips: [] });
  touch(video);
  await video.save();
  ok(res, await serializeVideoProject(video));
});

export const updateTrack = asyncHandler(async (req, res) => {
  const video = await getVideo(req, req.params.videoId);
  const track = video.tracks.find((t) => String(t._id) === req.params.trackId);
  if (!track) throw notFound('Track');
  Object.assign(track, req.body);
  touch(video);
  await video.save();
  ok(res, await serializeVideoProject(video));
});

export const deleteTrack = asyncHandler(async (req, res) => {
  const video = await getVideo(req, req.params.videoId);
  const track = video.tracks.find((t) => String(t._id) === req.params.trackId);
  if (!track) throw notFound('Track');
  if (track.kind === 'image' || track.kind === 'narration') throw new AppError('Scene and narration tracks cannot be deleted — mute them instead', 400);
  video.tracks = video.tracks.filter((t) => String(t._id) !== String(track._id));
  touch(video);
  await video.save();
  ok(res, await serializeVideoProject(video));
});

// -------------------------------------------------------------- render
/** Queue a full render: segments are checkpointed on disk so retries resume. */
export const renderVideo = asyncHandler(async (req, res) => {
  const video = await getVideo(req, req.params.videoId);
  if (!video.tracks.some((t) => t.clips.length)) throw new AppError('Timeline is empty — nothing to render', 400);
  if (video.renderStatus === 'rendering' || video.renderStatus === 'queued') {
    throw new AppError('A render is already in progress for this timeline', 409);
  }
  video.renderStatus = 'queued';
  await video.save();
  const job = await enqueueJob({
    type: 'video-rendering',
    owner: video.owner,
    project: video.project,
    title: `Render ${video.name} (${video.settings.width}x${video.settings.height}@${video.settings.fps})`,
    payload: { videoId: String(video._id) },
    target: { kind: 'video', id: video._id as Types.ObjectId },
    idempotencyKey: `render:${video._id}:r${video.revision}`,
  });
  ok(res, { job: serializeJob(job) }, 202);
});

// ------------------------------------------------------------ versions
export const createVersion = asyncHandler(async (req, res) => {
  const video = await getVideo(req, req.params.videoId);
  snapshotVersion(video, req.body.label);
  await video.save();
  ok(res, { versions: video.versions.map((v, i) => ({ index: i, at: v.at, label: v.label, revision: v.revision })) });
});

export const restoreVersion = asyncHandler(async (req, res) => {
  const video = await getVideo(req, req.params.videoId);
  const ver = video.versions[req.body.index];
  if (!ver) throw new AppError('Version not found', 400);
  snapshotVersion(video, `before restore of "${ver.label}"`);
  video.tracks = ver.tracks;
  touch(video);
  await video.save();
  ok(res, await serializeVideoProject(video));
});
