import path from 'path';
import fs from 'fs';
import { Types } from 'mongoose';
import GeneratedAudio from 'models/generated-audio.model';
import { registerJobHandler, JobContext, NonRetryableError } from 'libs/jobs/runner';
import { getTtsProvider } from 'libs/ai/tts';
import { recordUsage } from 'libs/ai/provider';
import { storeBuffer } from 'libs/studio/media';
import { audioDuration, waveformPeaks } from 'libs/studio/audio';
import { makeTempDir, removeDir } from 'libs/studio/paths';
import { emitToUser } from 'libs/realtime/events';
import { serializeAudio } from 'microservices/voice-service/voice.serializers';

/**
 * Generates narration audio for a batch of GeneratedAudio rows that were
 * pre-created in 'queued' state. Each clip is independent — failures are
 * recorded per-clip and don't abort the batch; cancellation stops between clips.
 */
const synthesize = async (ctx: JobContext, audioId: string) => {
  const doc = await GeneratedAudio.findById(audioId);
  if (!doc) return 'missing';
  if (doc.status === 'ready' && doc.file) return 'already-done';
  const provider = getTtsProvider(doc.provider);
  doc.status = 'processing';
  doc.error = undefined;
  await doc.save();
  await emitToUser(doc.owner, 'audio:update', serializeAudio(doc), doc.project);

  const tmp = await makeTempDir('tts');
  try {
    const r = await provider.speak({ text: doc.text, voiceId: doc.voiceId, language: doc.language, speed: doc.speed, signal: ctx.signal, onLog: (m, l) => ctx.log(m, l) });
    const ext = r.mimeType.includes('mpeg') || r.mimeType.includes('mp3') ? '.mp3' : r.mimeType.includes('ogg') ? '.ogg' : '.wav';
    const rawPath = path.join(tmp, `narration${ext}`);
    await fs.promises.writeFile(rawPath, r.audio);

    const [duration, wave] = await Promise.all([audioDuration(rawPath), waveformPeaks(rawPath)]);
    const file = await storeBuffer(r.audio, {
      owner: doc.owner,
      folder: `studio/projects/${doc.project}/audio`,
      originalName: `ch${doc.chapterNumber ?? 0}-seg-${String(doc.segment).slice(-6)}-v${doc.version + 1}${ext}`,
      mimetype: r.mimeType,
      tempDir: tmp,
    });
    if (r.usage.inputTokens || r.usage.outputTokens) {
      await recordUsage({ owner: doc.owner, project: doc.project, job: ctx.job._id as any, provider: r.provider, model: r.model, kind: 'tts', usage: r.usage, audioSeconds: duration });
    }
    doc.history.push({ at: new Date(), voiceId: doc.voiceId, file: file._id as Types.ObjectId, duration });
    doc.history = doc.history.slice(-20);
    doc.file = file._id as Types.ObjectId;
    doc.duration = duration;
    doc.waveform = wave;
    doc.inputTokens = r.usage.inputTokens;
    doc.outputTokens = r.usage.outputTokens;
    doc.modelId = r.model;
    doc.status = 'ready';
    doc.version += 1;
    await doc.save();
    await emitToUser(doc.owner, 'audio:update', serializeAudio(doc), doc.project);
    return 'done';
  } catch (e: any) {
    doc.status = 'failed';
    doc.error = e.message || 'TTS failed';
    await doc.save();
    await emitToUser(doc.owner, 'audio:update', serializeAudio(doc), doc.project);
    if (e instanceof NonRetryableError) throw e; // abort the batch on config/auth errors
    await ctx.log(`Audio ${audioId}: ${e.message}`, 'warn');
    return 'failed';
  } finally {
    await removeDir(tmp);
  }
};

registerJobHandler<any>('tts-generation', async (ctx) => {
  const ids: string[] = ctx.payload.audioIds || (ctx.payload.audioId ? [ctx.payload.audioId] : []);
  if (!ids.length) throw new NonRetryableError('No audio clips requested');
  const results = { done: 0, failed: 0, skipped: 0 };
  for (let i = 0; i < ids.length; i++) {
    ctx.throwIfCancelled();
    await ctx.progress((100 * i) / ids.length, `Synthesizing clip ${i + 1}/${ids.length}`);
    const r = await synthesize(ctx, ids[i]);
    if (r === 'done' || r === 'already-done') results.done += 1;
    else if (r === 'failed') results.failed += 1;
    else results.skipped += 1;
  }
  await ctx.progress(100, 'Audio generation finished');
  return results;
});
