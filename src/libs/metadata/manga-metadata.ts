import config from 'config/env';
import logger from 'utils/logger';

/**
 * Public manga metadata lookup (Jikan v4 — the community MyAnimeList API;
 * free, no key). Used to seed the character registry when a comic project
 * is created so narration names stay consistent before AI analysis runs.
 */

export interface PublicCharacter {
  name: string;
  role: 'Main' | 'Supporting' | string;
  externalId: number;
  imageUrl?: string;
  url?: string;
}

export interface PublicMangaInfo {
  externalId: number;
  provider: 'jikan' | 'anilist';
  title: string;
  titleEnglish?: string;
  titleJapanese?: string;
  synopsis?: string;
  authors: string[];
  genres: string[];
  url?: string;
  coverUrl?: string;
}

const TIMEOUT = () => (config.METADATA_TIMEOUT_MS as number) || 8000;



/** Normalize a title for comparison (strip punctuation/case). */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Pick the search hit whose title best matches the query. */
const bestMatch = (query: string, hits: any[]) => {
  const q = norm(query);
  let best: any = null;
  let bestScore = -1;
  for (const h of hits) {
    const titles = [h.title, h.title_english, h.title_japanese, ...(h.titles || []).map((t: any) => t.title)].filter(Boolean);
    let score = 0;
    for (const t of titles) {
      const n = norm(t);
      if (n === q) { score = Math.max(score, 100); break; }
      if (n.startsWith(q) || q.startsWith(n)) score = Math.max(score, 70);
      else if (n.includes(q) || q.includes(n)) score = Math.max(score, 40);
    }
    score += Math.min(20, Math.log10((h.members || 1) + 1) * 6); // mild popularity tiebreak
    if (score > bestScore) { bestScore = score; best = h; }
  }
  return bestScore >= 40 ? best : null;
};




// ------------------------------------------------------------------ AniList
const ANILIST_QUERY = `query($q:String){Page(perPage:5){media(search:$q,type:MANGA,sort:POPULARITY_DESC){
  id title{romaji english native} description(asHtml:false) genres siteUrl
  coverImage{extraLarge large} staff(perPage:4){edges{node{name{full}}role}}
  characters(perPage:20,sort:ROLE){edges{role node{id name{full native} image{large} siteUrl}}}}}}`;

const anilistSearch = async (title: string): Promise<{ info: PublicMangaInfo; characters: PublicCharacter[] } | null> => {
  const res = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'ai-manga-studio/1.0' },
    body: JSON.stringify({ query: ANILIST_QUERY, variables: { q: title } }),
    signal: AbortSignal.timeout(TIMEOUT()),
  });
  if (!res.ok) throw new Error(`AniList -> ${res.status}`);
  const json = (await res.json()) as any;
  const media = json?.data?.Page?.media || [];
  const hit = bestMatch(title, media.map((m: any) => ({ mal_id: m.id, title: m.title.romaji, title_english: m.title.english, title_japanese: m.title.native, members: 1, _m: m })));
  if (!hit) return null;
  const m = hit._m;
  const info: PublicMangaInfo = {
    externalId: m.id,
    provider: 'anilist',
    title: m.title.english || m.title.romaji || m.title.native,
    titleEnglish: m.title.english,
    titleJapanese: m.title.native,
    synopsis: m.description,
    authors: (m.staff?.edges || []).filter((e: any) => /story|art|author|illustr/i.test(e.role || '')).map((e: any) => e.node.name.full),
    genres: m.genres || [],
    url: m.siteUrl,
    coverUrl: m.coverImage?.extraLarge || m.coverImage?.large,
  };
  const characters: PublicCharacter[] = (m.characters?.edges || [])
    .map((e: any) => ({
      name: e.node.name.full,
      role: e.role === 'MAIN' ? 'Main' : 'Supporting',
      externalId: e.node.id,
      imageUrl: e.node.image?.large,
      url: e.node.siteUrl,
    }))
    .filter((c: PublicCharacter) => c.name);
  return { info, characters };
};

/** Search + characters; tries Jikan first, falls back to AniList (one request). */
export const lookupManga = async (title: string): Promise<{ info: PublicMangaInfo; characters: PublicCharacter[] } | null> => {
 
  try {
    return await anilistSearch(title);
  } catch (e) {
    logger.warn(`anilist lookup failed for "${title}": ${(e as Error).message}`);
    return null;
  }
};
