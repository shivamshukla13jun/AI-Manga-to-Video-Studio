#!/usr/bin/env node
// Drops all comic-library data: project-scoped Mongo collections +
// uploads/studio/projects media. Keeps users, tokens, voice profiles,
// studio settings and pricing. Usage: node scripts/clear-library.js
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', `.env.${process.env.NODE_ENV || 'development'}`) });
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const COLLECTIONS = [
  'mangaprojects', 'mangachapters', 'chaptergroups', 'comicarchives', 'comicimages',
  'detectedscenes', 'storysegments', 'characters', 'videoprojects', 'generatedaudios',
  'pdfexports', 'costestimates', 'usagerecords', 'processingjobs', 'uploadsessions',
];

const run = async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI not set');
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));
  for (const name of COLLECTIONS) {
    if (!existing.has(name)) continue;
    const r = await db.collection(name).deleteMany({});
    console.log(`${name}: ${r.deletedCount}`);
  }
  const files = await db.collection('files').deleteMany({ folder: { $regex: '^studio/projects' } });
  console.log(`files (studio/projects/*): ${files.deletedCount}`);
  await mongoose.disconnect();

  const dir = path.join(__dirname, '..', process.env.UPLOAD_BASE_DIR || 'uploads', process.env.STUDIO_STORAGE_FOLDER || 'studio', 'projects');
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`removed ${dir}`);
  }
  const scratch = path.join(__dirname, '..', 'tmp', 'studio');
  if (fs.existsSync(scratch)) {
    fs.rmSync(scratch, { recursive: true, force: true });
    console.log(`removed ${scratch}`);
  }
};

run().then(() => console.log('Library cleared')).catch((e) => { console.error(e); process.exit(1); });
