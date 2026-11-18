import { Types } from 'mongoose';
import config from 'config/env';
import logger from 'utils/logger';
import Character from 'models/character.model';
import { IMangaProjectDocument } from 'models/manga-project.model';
import { lookupManga } from 'libs/metadata/manga-metadata';
import { storeBuffer } from 'libs/studio/media';
import { makeTempDir, removeDir } from 'libs/studio/paths';

export interface EnrichResult {
  matched: boolean;
  provider?: string;
  externalId?: number;
  charactersImported: number;
  coverImported: boolean;
  title?: string;
}

/**
 * Look the project title up in public manga metadata (Jikan/MyAnimeList) and:
 *  - upsert the returned cast into the Character registry (source 'api'),
 *  - fill description/tags when the user left them empty,
 *  - download and store the cover image when the project has none,
 *  - record the match on project.metadata.
 * Best-effort: network/API failures log a warning and resolve matched:false.
 */
export const enrichFromPublicApi = async (project: IMangaProjectDocument): Promise<EnrichResult> => {
  const none: EnrichResult = { matched: false, charactersImported: 0, coverImported: false };
  if (!config.MANGA_METADATA_ENABLED) return none;
  const found = await lookupManga(project.title);
  if (!found) return none;
  const { info, characters } = found;

  project.metadata = { provider: info.provider, externalId: info.externalId, title: info.title, url: info.url, fetchedAt: new Date() };
  if (!project.description && info.synopsis) project.description = info.synopsis.slice(0, 5000);
  if (!project.tags.length && info.genres.length) project.tags = info.genres.slice(0, 8);

  // ---- characters: upsert by (project, name) — never overwrite user/ai edits
  let imported = 0;
  for (const c of characters) {
    const res = await Character.updateOne(
      { project: project._id, name: c.name },
      {
        $setOnInsert: {
          owner: project.owner,
          project: project._id,
          name: c.name,
          role: c.role,
          source: 'api',
          external: { provider: info.provider, id: c.externalId, url: c.url, imageUrl: c.imageUrl },
        },
      },
      { upsert: true, collation: { locale: 'en', strength: 2 } }
    ).catch((e) => {
      logger.warn(`character upsert failed for "${c.name}": ${e.message}`);
      return null;
    });
    if (res?.upsertedCount) imported += 1;
  }

  // ---- cover: only when the project has none yet
  let coverImported = false;
  if (!project.cover && info.coverUrl) {
    const tmp = await makeTempDir('cover');
    try {
      const img = await fetch(info.coverUrl, { signal: AbortSignal.timeout((config.METADATA_TIMEOUT_MS as number) || 8000) });
      if (img.ok) {
        const buf = Buffer.from(await img.arrayBuffer());
        const file = await storeBuffer(buf, {
          owner: project.owner,
          folder: `studio/projects/${project._id}`,
          originalName: `cover-${info.externalId}.jpg`,
          mimetype: img.headers.get('content-type') || 'image/jpeg',
          tempDir: tmp,
        });
        project.cover = file._id as Types.ObjectId;
        coverImported = true;
      }
    } catch (e) {
      logger.warn(`cover download failed for ${project.title}: ${(e as Error).message}`);
    } finally {
      await removeDir(tmp);
    }
  }

  await project.save();
  return {
    matched: true,
    provider: info.provider,
    externalId: info.externalId,
    charactersImported: imported,
    coverImported,
    title: info.title,
  };
};
