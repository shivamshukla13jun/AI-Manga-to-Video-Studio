import fs from 'fs';
import { Request } from 'express';
import { Types } from 'mongoose';
import config from 'config/env';
import { AppError } from 'middlewares/error';
import StorySegment from 'models/story-segment.model';
import GeneratedAudio from 'models/generated-audio.model';
import VoiceProfile from 'models/voice-profile.model';
import StudioSettings from 'models/studio-settings.model';
import { asyncHandler, assertObjectId, notFound, ok, ownerFilter } from 'libs/studio/http';
import { enqueueJob, serializeJob } from 'libs/jobs/job.service';
import { approveEstimate, serializeEstimate } from 'libs/pricing/estimator';
import { getSettings, refreshExchangeRate, serializePrice, listPrices } from 'libs/pricing/pricing.service';
import { getTtsProvider, TtsVoice } from 'libs/ai/tts';
import { storeLocalFile, deleteFileById, mediaUrl } from 'libs/studio/media';
import { diskUpload, uploadedFile } from 'libs/studio/diskUpload';
import { audioDuration } from 'libs/studio/audio';
import { countWords } from 'libs/ai/prompts';
import { getProject } from 'microservices/manga-service/manga.service';
import { serializeAudio, serializeVoiceProfile } from './voice.serializers';
import { estimateTts } from './voice.estimates';

// ------------------------------------------------------------------ voices
export const voiceStatus = asyncHandler(async (req, res) => {
  const providers = ['gemini', 'local'] as const;
  const out: Record<string, any> = {};
  for (const p of providers) out[p] = { ...(await getTtsProvider(p).status()), configured: getTtsProvider(p).configured };
  ok(res, { providers: out, localTtsUrl: config.LOCAL_TTS_URL });
});

/** Provider voices + the user's saved profiles in one list. */
export const listVoices = asyncHandler(async (req, res) => {
  const want = String(req.query.provider || 'all');
  const voices: TtsVoice[] = [];
  const errors: Record<string, string> = {};
  for (const name of ['gemini', 'local'] as const) {
    if (want !== 'all' && want !== name) continue;
    try {
      voices.push(...(await getTtsProvider(name).listVoices()));
    } catch (e: any) {
      errors[name] = e.message;
    }
  }
  const profiles = await VoiceProfile.find({ ...ownerFilter(req), status: { $ne: 'failed' } }).sort({ createdAt: -1 });
  ok(res, { providerVoices: voices, profiles: profiles.map(serializeVoiceProfile), errors });
});

export const previewVoice = asyncHandler(async (req, res) => {
  const { provider: providerName, voiceId, text, language, speed } = req.body;
  const provider = getTtsProvider(providerName);
  const r = await provider.speak({ text, voiceId, language, speed });
  res.set({ 'Content-Type': r.mimeType, 'Cache-Control': 'no-store' });
  res.send(r.audio);
});

// ---------------------------------------------------------------- profiles
export const createProfile = asyncHandler(async (req, res) => {
  const profile = await VoiceProfile.create({ ...req.body, owner: req.user!._id });
  ok(res, serializeVoiceProfile(profile), 201);
});

export const updateProfile = asyncHandler(async (req, res) => {
  const p = await VoiceProfile.findOneAndUpdate({ _id: assertObjectId(req.params.profileId), ...ownerFilter(req) }, { $set: req.body }, { new: true });
  if (!p) throw notFound('Voice profile');
  ok(res, serializeVoiceProfile(p));
});

export const deleteProfile = asyncHandler(async (req, res) => {
  const p = await VoiceProfile.findOne({ _id: assertObjectId(req.params.profileId), ...ownerFilter(req) });
  if (!p) throw notFound('Voice profile');
  await deleteFileById(p.referenceAudio);
  await deleteFileById(p.consentAudio);
  await p.deleteOne();
  ok(res, { id: String(p._id) });
});

export const audioUpload = diskUpload(
  [
    { name: 'reference', maxCount: 1 },
    { name: 'consent', maxCount: 1 },
  ],
  { types: ['audio'], maxSize: 50 * 1024 * 1024 }
);

/**
 * Attach reference + consent samples and request voice replication.
 * Consent must be an audio statement by the speaker + a written note naming
 * the consent; replication is only attempted with both on record.
 */
export const replicateVoice = asyncHandler(async (req, res) => {
  const p = await VoiceProfile.findOne({ _id: assertObjectId(req.params.profileId), ...ownerFilter(req) });
  if (!p) throw notFound('Voice profile');
  const provider = getTtsProvider(p.provider);
  if (!provider.replicateVoice) {
    throw new AppError(`The ${p.provider} provider does not support voice replication — use a prebuilt voice or a local engine`, 422);
  }
  const reference = uploadedFile(req, 'reference');
  const consent = uploadedFile(req, 'consent');
  if (!reference || !consent) throw new AppError('Both "reference" and "consent" audio files are required', 400);
  if (!req.body.consentNote || String(req.body.consentNote).trim().length < 10) {
    throw new AppError('Provide a consentNote describing who consented and how (e.g. "spoken consent recorded by the voice owner")', 400);
  }
  const refFile = await storeLocalFile(reference.path, { owner: req.user!._id, folder: `studio/voices/${req.user!._id}`, originalName: reference.originalname, mimetype: reference.mimetype });
  const conFile = await storeLocalFile(consent.path, { owner: req.user!._id, folder: `studio/voices/${req.user!._id}`, originalName: consent.originalname, mimetype: consent.mimetype });
  p.status = 'pending';
  p.consentConfirmed = true;
  p.consentNote = String(req.body.consentNote).trim();
  await deleteFileById(p.referenceAudio);
  await deleteFileById(p.consentAudio);
  p.referenceAudio = refFile._id as Types.ObjectId;
  p.consentAudio = conFile._id as Types.ObjectId;
  try {
    const { voiceId } = await provider.replicateVoice({ name: p.name, referenceWav: await fs.promises.readFile(reference.path), consentWav: await fs.promises.readFile(consent.path), language: p.language });
    p.voiceId = voiceId;
    p.kind = 'custom';
    p.status = 'ready';
    p.statusError = undefined;
  } catch (e: any) {
    p.status = 'failed';
    p.statusError = e.message;
  }
  await p.save();
  if (p.status === 'failed') throw new AppError(p.statusError!, 422);
  ok(res, serializeVoiceProfile(p));
});

// ------------------------------------------------------------ estimation
export const estimateAudio = asyncHandler(async (req, res) => {
  const project = await getProject(req, req.body.projectId);
  const { segmentIds, provider, voiceId, speed } = req.body;
  const est = await estimateTts(project.owner, project._id as Types.ObjectId, { segmentIds, provider, voiceId, speed });
  ok(res, await serializeEstimate(est), 201);
});

// -------------------------------------------------------------- generation
export const generateAudio = asyncHandler(async (req, res) => {
  const project = await getProject(req, req.body.projectId);
  const { segmentIds, provider, voiceId, speed, estimateId } = req.body;
  const segments = await StorySegment.find({ _id: { $in: segmentIds }, project: project._id });
  if (segments.length !== segmentIds.length) throw new AppError('Some narration segments were not found in this project', 400);
  if (provider === 'gemini') {
    await approveEstimate(project.owner, estimateId, 'tts', { segmentIds, provider, voiceId, speed });
  }
  const docs = await GeneratedAudio.insertMany(
    segments.map((seg) => ({
      owner: project.owner,
      project: project._id,
      chapter: seg.chapter,
      chapterNumber: seg.chapterNumber,
      segment: seg._id,
      purpose: 'narration',
      text: seg.narration,
      characters: seg.narration.length,
      words: seg.wordCount || countWords(seg.narration),
      language: seg.language,
      provider,
      voiceId,
      speed,
      status: 'queued',
    }))
  );
  const job = await enqueueJob({
    type: 'tts-generation',
    owner: project.owner,
    project: project._id as Types.ObjectId,
    title: `Generate ${docs.length} narration clip(s) — ${provider} ${voiceId}`,
    payload: { audioIds: docs.map((d) => String(d._id)), estimateId },
    target: { kind: 'project', id: project._id as Types.ObjectId },
    idempotencyKey: `tts:${project._id}:${segmentIds.sort().join(',')}:${provider}:${voiceId}`,
  });
  await GeneratedAudio.updateMany({ _id: { $in: docs.map((d) => d._id) } }, { $set: { job: job._id } });
  ok(res, { job: serializeJob(job), audio: docs.map((d) => serializeAudio(d)) }, 202);
});

/** Regenerate one clip (optionally with a different voice/speed). */
export const regenerateAudio = asyncHandler(async (req, res) => {
  const doc = await GeneratedAudio.findOne({ _id: assertObjectId(req.params.audioId), ...ownerFilter(req) });
  if (!doc) throw notFound('Audio clip');
  if (req.body.voiceId) doc.voiceId = req.body.voiceId;
  if (req.body.speed) doc.speed = req.body.speed;
  if (req.body.text) {
    doc.text = req.body.text;
    doc.characters = req.body.text.length;
    doc.words = countWords(req.body.text);
  }
  if (doc.provider === 'gemini') {
    await approveEstimate(doc.owner, req.body.estimateId, 'tts', { segmentIds: [String(doc.segment)], provider: doc.provider, voiceId: doc.voiceId, speed: doc.speed });
  }
  doc.status = 'queued';
  doc.error = undefined;
  await doc.save();
  const job = await enqueueJob({
    type: 'tts-generation',
    owner: doc.owner,
    project: doc.project,
    title: `Regenerate clip — ${doc.voiceId}`,
    payload: { audioIds: [String(doc._id)], estimateId: req.body.estimateId },
    target: { kind: 'project', id: doc.project },
    idempotencyKey: `tts:${doc._id}`,
  });
  ok(res, { job: serializeJob(job), audio: serializeAudio(doc) }, 202);
});

export const listAudio = asyncHandler(async (req, res) => {
  const project = await getProject(req, req.query.project);
  const filter: Record<string, unknown> = { project: project._id };
  if (req.query.chapter) filter.chapter = req.query.chapter;
  if (req.query.segment) filter.segment = req.query.segment;
  if (req.query.purpose) filter.purpose = req.query.purpose;
  if (req.query.status) filter.status = req.query.status;
  const docs = await GeneratedAudio.find(filter).sort({ chapterNumber: 1, createdAt: 1 }).limit(2000);
  ok(res, docs.map(serializeAudio));
});

export const deleteAudio = asyncHandler(async (req, res) => {
  const doc = await GeneratedAudio.findOne({ _id: assertObjectId(req.params.audioId), ...ownerFilter(req) });
  if (!doc) throw notFound('Audio clip');
  await deleteFileById(doc.file);
  await doc.deleteOne();
  ok(res, { id: String(doc._id) });
});

// ---------------------------------------------------------------- settings
export const getStudioSettings = asyncHandler(async (req, res) => {
  const s = await getSettings(req.user!._id);
  ok(res, {
    budgetLimitUSD: s.budgetLimitUSD,
    confirmAboveUSD: s.confirmAboveUSD,
    displayCurrency: s.displayCurrency,
    usdToInr: s.usdToInr,
    usdToInrUpdatedAt: s.usdToInrUpdatedAt,
    usdToInrSource: s.usdToInrSource,
    pricingTier: s.pricingTier,
    defaultTtsProvider: s.defaultTtsProvider,
    defaultVoiceProfile: s.defaultVoiceProfile ? String(s.defaultVoiceProfile) : undefined,
    aiProvider: s.aiProvider,
    narrationLanguage: s.narrationLanguage,
    narrationMode: s.narrationMode,
    wordsPerMinute: s.wordsPerMinute,
  });
});

export const updateStudioSettings = asyncHandler(async (req, res) => {
  const update: Record<string, unknown> = {};
  for (const k of ['budgetLimitUSD', 'confirmAboveUSD', 'displayCurrency', 'pricingTier', 'defaultTtsProvider', 'defaultVoiceProfile', 'aiProvider', 'narrationLanguage', 'narrationMode', 'wordsPerMinute']) {
    if (req.body[k] !== undefined) update[k] = req.body[k];
  }
  const s = await StudioSettings.findOneAndUpdate({ owner: req.user!._id }, { $set: update }, { new: true, upsert: true });
  ok(res, { settings: s });
});

export const refreshFx = asyncHandler(async (req, res) => {
  const rate = await refreshExchangeRate(req.user!._id);
  ok(res, { usdToInr: rate });
});

export const pricingTable = asyncHandler(async (req, res) => {
  const prices = await listPrices();
  ok(res, prices.map(serializePrice));
});
