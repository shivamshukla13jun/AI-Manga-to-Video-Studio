import mongoose, { Document, Schema, Types } from 'mongoose';

export type TrackKind = 'background' | 'image' | 'narration' | 'music' | 'sfx' | 'subtitle' | 'overlay';
export type ClipKind = 'image' | 'audio' | 'video' | 'text';
export type AnimationType = 'none' | 'zoom-in' | 'zoom-out' | 'pan-left' | 'pan-right' | 'pan-up' | 'pan-down' | 'ken-burns' | 'custom';
export type TransitionType = 'none' | 'fade' | 'crossfade' | 'slide-left' | 'slide-right' | 'zoom' | 'wipe';

export interface IKeyframe {
  /** seconds relative to clip start */
  at: number;
  scale: number;
  x: number;
  y: number;
  opacity?: number;
  easing?: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';
}

export interface IClip {
  _id: Types.ObjectId;
  name?: string;
  kind: ClipKind;
  /** timeline position, seconds */
  start: number;
  duration: number;
  /** trim: offset into the source media (audio/video) */
  mediaStart: number;
  gain: number;
  muted: boolean;
  /** linked source — never copied, only referenced */
  scene?: Types.ObjectId;
  image?: Types.ObjectId;
  audio?: Types.ObjectId;
  segment?: Types.ObjectId;
  text?: string;
  animation: { type: AnimationType; keyframes: IKeyframe[] };
  transitionIn: { type: TransitionType; duration: number };
  transitionOut: { type: TransitionType; duration: number };
  /** blurred-copy background derived from the same image (video bg fill) */
  backdrop: boolean;
  label?: string;
}

export interface ITrack {
  _id: Types.ObjectId;
  kind: TrackKind;
  name: string;
  muted: boolean;
  locked: boolean;
  order: number;
  clips: IClip[];
}

export interface IVideoSettings {
  width: number;
  height: number;
  fps: number;
  layout: 'blur-fill' | 'fit' | 'fill' | 'original';
  bgBlur: number;
  bgDim: number;
  targetDurationSec?: number;
}

export interface IVideoProjectDocument extends Document {
  owner: Types.ObjectId;
  project: Types.ObjectId;
  name: string;
  language: string;
  mode: 'original' | 'recap';
  settings: IVideoSettings;
  tracks: ITrack[];
  /** last render duration estimate */
  estimatedDuration: number;
  revision: number;
  versions: { at: Date; label: string; revision: number; tracks: ITrack[] }[];
  renderStatus: 'idle' | 'queued' | 'rendering' | 'done' | 'failed';
  outputFile?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const keyframeSchema = new Schema<IKeyframe>(
  {
    at: { type: Number, required: true, min: 0 },
    scale: { type: Number, default: 1, min: 0.05, max: 20 },
    x: { type: Number, default: 0 },
    y: { type: Number, default: 0 },
    opacity: { type: Number, min: 0, max: 1 },
    easing: { type: String, enum: ['linear', 'ease-in', 'ease-out', 'ease-in-out'], default: 'linear' },
  },
  { _id: false }
);

const clipSchema = new Schema<IClip>(
  {
    name: String,
    kind: { type: String, enum: ['image', 'audio', 'video', 'text'], required: true },
    start: { type: Number, required: true, min: 0 },
    duration: { type: Number, required: true, min: 0.05 },
    mediaStart: { type: Number, default: 0, min: 0 },
    gain: { type: Number, default: 1, min: 0, max: 4 },
    muted: { type: Boolean, default: false },
    scene: { type: Schema.Types.ObjectId, ref: 'DetectedScene' },
    image: { type: Schema.Types.ObjectId, ref: 'ComicImage' },
    audio: { type: Schema.Types.ObjectId, ref: 'GeneratedAudio' },
    segment: { type: Schema.Types.ObjectId, ref: 'StorySegment' },
    text: String,
    animation: {
      type: { type: String, enum: ['none', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down', 'ken-burns', 'custom'], default: 'ken-burns' },
      keyframes: { type: [keyframeSchema], default: [] },
    },
    transitionIn: { type: { type: String, enum: ['none', 'fade', 'crossfade', 'slide-left', 'slide-right', 'zoom', 'wipe'], default: 'none' }, duration: { type: Number, default: 0, min: 0, max: 5 } },
    transitionOut: { type: { type: String, enum: ['none', 'fade', 'crossfade', 'slide-left', 'slide-right', 'zoom', 'wipe'], default: 'none' }, duration: { type: Number, default: 0, min: 0, max: 5 } },
    backdrop: { type: Boolean, default: false },
    label: String,
  },
  { _id: true }
);

const trackSchema = new Schema<ITrack>(
  {
    kind: { type: String, enum: ['background', 'image', 'narration', 'music', 'sfx', 'subtitle', 'overlay'], required: true },
    name: { type: String, required: true },
    muted: { type: Boolean, default: false },
    locked: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    clips: { type: [clipSchema], default: [] },
  },
  { _id: true }
);

const schema = new Schema<IVideoProjectDocument>(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    project: { type: Schema.Types.ObjectId, ref: 'MangaProject', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    language: { type: String, default: 'hi' },
    mode: { type: String, enum: ['original', 'recap'], default: 'recap' },
    settings: {
      width: { type: Number, default: 1920 },
      height: { type: Number, default: 1080 },
      fps: { type: Number, default: 30 },
      layout: { type: String, enum: ['blur-fill', 'fit', 'fill', 'original'], default: 'blur-fill' },
      bgBlur: { type: Number, default: 40 },
      bgDim: { type: Number, default: 0.55 },
      targetDurationSec: Number,
    },
    tracks: { type: [trackSchema], default: [] },
    estimatedDuration: { type: Number, default: 0 },
    revision: { type: Number, default: 0 },
    versions: [
      {
        at: { type: Date, default: Date.now },
        label: String,
        revision: Number,
        tracks: { type: [trackSchema], default: [] },
      },
    ],
    renderStatus: { type: String, enum: ['idle', 'queued', 'rendering', 'done', 'failed'], default: 'idle' },
    outputFile: { type: Schema.Types.ObjectId, ref: 'File' },
  },
  { timestamps: true }
);

schema.index({ owner: 1, project: 1, updatedAt: -1 });

export default mongoose.model<IVideoProjectDocument>('VideoProject', schema);
