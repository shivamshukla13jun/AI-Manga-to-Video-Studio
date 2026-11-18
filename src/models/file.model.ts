import mongoose, { Document, Schema, Types } from 'mongoose';
import type { StorageProviderName } from 'config/env';

export interface IFileDocument extends Document {
  key: string;
  url: string;
  provider: StorageProviderName;
  originalName: string;
  mimetype: string;
  size: number;
  folder?: string;
  uploadedBy?: Types.ObjectId;
  /** sha256 hex digest — used for duplicate detection and integrity checks */
  checksum?: string;
  /** Private studio media is only reachable through signed /api/media URLs */
  isPrivate?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const fileSchema: Schema<IFileDocument> = new Schema(
  {
    key: {
      type: String,
      required: [true, 'Storage key is required'],
      index: true,
    },
    url: {
      type: String,
      required: [true, 'File URL is required'],
    },
    provider: {
      type: String,
      enum: ['local', 's3', 'cloudinary', 'firebase'],
      required: [true, 'Storage provider is required'],
    },
    originalName: {
      type: String,
      required: [true, 'Original file name is required'],
    },
    mimetype: {
      type: String,
      required: [true, 'MIME type is required'],
    },
    size: {
      type: Number,
      required: [true, 'File size is required'],
    },
    folder: {
      type: String,
    },
    uploadedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    checksum: {
      type: String,
      index: true,
    },
    isPrivate: {
      type: Boolean,
      default: false,
    },
  },
  {
    versionKey: false,
    timestamps: true,
  }
);

const File = mongoose.model<IFileDocument>('File', fileSchema);

export default File;
