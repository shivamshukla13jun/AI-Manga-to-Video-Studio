import path from 'path';
import fs from 'fs';
import { Types } from 'mongoose';
import config from 'config/env';
import VideoProject from 'models/video-project.model';
import ComicImage from 'models/comic-image.model';
import GeneratedAudio from 'models/generated-audio.model';
import { registerJobHandler, JobContext, NonRetryableError } from 'libs/jobs/runner';
import { concatSegments, muxWithAudio, renderSegments, RenderProps } from 'libs/render/renderer';
import { mediaUrl, storeLocalFile } from 'libs/studio/media';
import { makeTempDir, removeDir } from 'libs/studio/paths';
import { emitToUser } from 'libs/realtime/events';

const BASE = () => config.RENDER_MEDIA_BASE_URL as string;

/**
 * video-rendering job: builds Remotion input props from the persisted timeline,
 * renders video-only segments with headless Chrome (checkpointed on disk so a
 * retry resumes completed segments), concats them, then mixes the narration /
 * music / sfx audio tracks with ffmpeg and muxes to a faststart MP4.
 */
registerJobHandler('video-rendering', async (ctx: JobContext<{ videoId: string }>) => {
  const video = await VideoProject.findById(ctx.payload.videoId);
  if (!video) throw new NonRetryableError('Video project not found');
  video.renderStatus = 'rendering';
  await video.save();
  await emitToUser(video.owner, 'video:update', { id: String(video._id), renderStatus: 'rendering' }, video.project);

  // ---- build render props: resolve clip media to signed URLs ---------------
  const imageIds = new Set<string>();
  const audioIds = new Set<string>();
  for (const t of video.tracks)
    for (const c of t.clips) {
      if (c.image) imageIds.add(String(c.image));
      if (c.audio) audioIds.add(String(c.audio));
    }
  const [images, audios] = await Promise.all([
    ComicImage.find({ _id: { $in: [...imageIds] } }),
    GeneratedAudio.find({ _id: { $in: [...audioIds] } }),
  ]);
  const imgMap = new Map(images.map((i) => [String(i._id), i]));
  const audMap = new Map(audios.map((a) => [String(a._id), a]));

  const props: RenderProps = {
    settings: video.settings as RenderProps['settings'],
    tracks: video.tracks.map((t) => ({
      id: String(t._id),
      kind: t.kind,
      muted: t.muted,
      order: t.order,
      clips: t.clips.map((c) => ({
        id: String(c._id),
        kind: c.kind,
        start: c.start,
        duration: c.duration,
        mediaStart: c.mediaStart,
        gain: c.gain,
        muted: c.muted,
        text: c.text,
        backdrop: c.backdrop,
        animation: c.animation as any,
        transitionIn: c.transitionIn,
        transitionOut: c.transitionOut,
        media: {
          imageUrl: c.image ? mediaUrl(imgMap.get(String(c.image))?.file as Types.ObjectId, BASE()) || undefined : undefined,
          audioUrl: c.audio ? mediaUrl(audMap.get(String(c.audio))?.file as Types.ObjectId, BASE()) || undefined : undefined,
        },
      })),
    })),
  };

  const duration = Math.max(1, ...video.tracks.flatMap((t) => t.clips.map((c) => c.start + c.duration)));
  const segDir = path.resolve(config.RENDER_CHECKPOINT_DIR as string, `${video._id}-r${video.revision}`);
  const tmp = await makeTempDir('render');
  ctx.throwIfCancelled();

  try {
    await ctx.progress(4, 'bundling');
    const segments = await renderSegments(
      props,
      segDir,
      async (f, stage) => ctx.progress(4 + f * 66, stage),
      ctx.throwIfCancelled
    );
    await ctx.log(`rendered ${segments.length} segment(s)`);
    ctx.throwIfCancelled();

    await ctx.progress(72, 'concatenating');
    const silentVideo = path.join(tmp, 'video.mp4');
    await concatSegments(segments, silentVideo);
    ctx.throwIfCancelled();

    await ctx.progress(84, 'mixing audio');
    const audioClips = video.tracks
      .filter((t) => !t.muted && ['narration', 'music', 'sfx'].includes(t.kind))
      .flatMap((t) => t.clips)
      .filter((c) => !c.muted && c.audio)
      .map((c) => ({
        url: mediaUrl(audMap.get(String(c.audio))?.file as Types.ObjectId, BASE())!,
        start: c.start,
        mediaStart: c.mediaStart,
        duration: c.duration,
        gain: c.gain,
      }))
      .filter((c) => c.url);
    const finalFile = path.join(tmp, 'final.mp4');
    await muxWithAudio(silentVideo, audioClips, finalFile, duration);
    ctx.throwIfCancelled();

    await ctx.progress(94, 'storing');
    const stored = await storeLocalFile(finalFile, {
      owner: video.owner,
      folder: `studio/projects/${video.project}/renders`,
      originalName: `${video.name.replace(/[^\w-]+/g, '_')}-r${video.revision}.mp4`,
      mimetype: 'video/mp4',
    });
    video.outputFile = stored._id as Types.ObjectId;
    video.renderStatus = 'done';
    await video.save();
    await emitToUser(video.owner, 'video:update', { id: String(video._id), renderStatus: 'done', outputUrl: mediaUrl(stored._id) }, video.project);
    await ctx.progress(100, 'done');
    return { fileId: String(stored._id), bytes: fs.statSync(finalFile).size, duration };
  } catch (e) {
    video.renderStatus = 'failed';
    await video.save();
    await emitToUser(video.owner, 'video:update', { id: String(video._id), renderStatus: 'failed' }, video.project);
    throw e;
  } finally {
    await removeDir(tmp);
  }
});
