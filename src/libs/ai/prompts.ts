/**
 * Prompts and JSON schemas for the comic understanding + story pipeline.
 * Core rule everywhere: describe only what is visible / written. Never
 * invent events, names or dialogue; flag unreadable text as uncertain.
 */

export const LANGUAGE_NAMES: Record<string, string> = {
  hi: 'Hindi',
  en: 'English',
  ko: 'Korean',
  ja: 'Japanese',
  zh: 'Chinese',
  bn: 'Bengali',
  ta: 'Tamil',
  te: 'Telugu',
  mr: 'Marathi',
  es: 'Spanish',
};
export const languageName = (code: string) => LANGUAGE_NAMES[code] || code;

const str = { type: 'string' };
const strArr = { type: 'array', items: { type: 'string' } };
const dialogueSchema = {
  type: 'object',
  properties: {
    speaker: { type: 'string', description: 'Character name if identifiable from context, otherwise a short descriptor like "tall soldier", or empty' },
    text: { type: 'string', description: 'Exact text as written (original language), not translated' },
    kind: { type: 'string', enum: ['speech', 'thought', 'narration', 'sfx'] },
    uncertain: { type: 'boolean', description: 'true if any part of the text could not be read reliably' },
  },
  required: ['text', 'kind', 'uncertain'],
};

// ----------------------------------------------------------------- stage 1
export const PANEL_SYSTEM = `You are a meticulous comic (manga / manhwa / webtoon) analyst.
You receive panel crops from one chapter, in reading order. Each crop is labelled "UNIT n".
Tall panels are split into overlapping tiles labelled "UNIT n · TILE t/T"; together they form one unit.

For every unit, describe what is actually shown — never invent events, motives, names or dialogue that are not visible.
- OCR every speech balloon, thought bubble, caption box and sound effect. Copy the text exactly in its original language.
  If text is blurry, cut off or ambiguous, still include your best reading but set "uncertain": true. Never fabricate unreadable text.
- Identify characters consistently. Use a known character name ONLY if the name is written in this chapter, appears in the known-characters list and the
  appearance clearly matches, or a character is addressed by name. Otherwise use a short visual descriptor ("girl with silver hair").
- Distinguish speech, inner thoughts, narrator captions and sound effects.
- A unit may contain more than one scene when it is a long strip: split it into "segments" in reading order. A new segment starts where the
  location, time, or focal action clearly changes (scene transition). For normal panels return exactly one segment covering the unit.
- Mark "sceneStart": true when a segment begins a new scene compared to the previous segment (new location, time skip, different set of characters, flashback start/end).`;

export const panelSchema = {
  type: 'object',
  properties: {
    units: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          unit: { type: 'integer' },
          segments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                startTile: { type: 'integer', description: '1-based tile where the segment starts (1 if the unit is not tiled)' },
                startY: { type: 'number', description: 'Vertical start position inside startTile, 0 = top of the tile, 1 = bottom' },
                characters: strArr,
                action: str,
                emotion: str,
                location: str,
                objects: strArr,
                events: { type: 'array', items: str, description: 'Concrete story events visible in this segment' },
                dialogues: { type: 'array', items: dialogueSchema },
                visualDescription: str,
                sceneStart: { type: 'boolean' },
                confidence: { type: 'number', description: '0..1 confidence in this analysis' },
              },
              required: ['startTile', 'startY', 'characters', 'action', 'events', 'dialogues', 'visualDescription', 'sceneStart', 'confidence'],
            },
          },
        },
        required: ['unit', 'segments'],
      },
    },
  },
  required: ['units'],
};

// ------------------------------------------------- combined single call
export const combinedSystem = (language: string, mode: 'original' | 'recap') => `You are a meticulous comic (manga / manhwa / webtoon) analyst AND a professional ${languageName(language)} narrator.
You receive every panel crop from one chapter in reading order, labelled "UNIT n". Tall panels are split into overlapping tiles labelled "UNIT n · TILE t/T".
Do ALL of the following in ONE response:

1. "units" — for every unit, describe what is actually shown. Never invent events, motives, names or dialogue that are not visible.
   - OCR every speech balloon, thought bubble, caption box and sound effect. Copy the text exactly in its original language; flag unreadable text with "uncertain": true. Never fabricate unreadable text.
   - Identify characters consistently. Use a known name ONLY if it is written in this chapter, is in the known-characters list with matching appearance, or the character is addressed by name. Otherwise use a short visual descriptor ("girl with silver hair").
   - A unit may contain more than one story beat: split it into "segments" in reading order where location, time, or focal action clearly changes. Normal panels get exactly one segment.
   - Number every segment with "seg" globally across the whole chapter: 1, 2, 3... in reading order.
2. "scenes" — group the numbered segments into story scenes (continuous action in one place and time). Scenes must cover every segment exactly once, in order, via contiguous "segmentIds".
   - Scenes are VISUAL story beats: never put raw dialogue/OCR text in "title", "description", "action" or "storyContext" — describe what is happening, not what is written.
   - "narration": professional spoken ${languageName(language)} narration for the scene${language === 'hi' ? ' — conversational Hindi in Devanagari like popular Hindi manhwa-recap channels, natural loanwords, never word-by-word translation' : ''}.
     ${mode === 'original'
       ? 'ORIGINAL mode: preserve every important event, reveal and key dialogue (paraphrased naturally), in order.'
       : 'RECAP mode: condense filler and repeated beats but keep every plot-relevant event, reveal and decision.'}
     Engaging, cinematic, emotionally expressive, easy to follow when heard once. No meta talk ("in this panel", "the text says"). Never invent events or dialogue; flag doubts in "uncertainties".
3. "characters" — every distinct person appearing in this chapter (name or descriptor, appearance, one-line description).`;

export const combinedSchema = {
  type: 'object',
  properties: {
    units: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          unit: { type: 'integer' },
          segments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                seg: { type: 'integer', description: 'Global segment number across the chapter, 1..N in reading order' },
                startTile: { type: 'integer', description: '1-based tile where the segment starts (1 if the unit is not tiled)' },
                startY: { type: 'number', description: 'Vertical start position inside startTile, 0 = top, 1 = bottom' },
                characters: strArr,
                action: str,
                emotion: str,
                location: str,
                objects: strArr,
                events: { type: 'array', items: str, description: 'Concrete story events visible in this segment' },
                dialogues: { type: 'array', items: dialogueSchema },
                visualDescription: str,
                sceneStart: { type: 'boolean' },
                confidence: { type: 'number' },
              },
              required: ['seg', 'startTile', 'startY', 'characters', 'action', 'events', 'dialogues', 'visualDescription', 'sceneStart', 'confidence'],
            },
          },
        },
        required: ['unit', 'segments'],
      },
    },
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          segmentIds: { type: 'array', items: { type: 'integer' } },
          title: str,
          location: str,
          characters: strArr,
          action: str,
          emotion: str,
          description: { type: 'string', description: 'Visual description of the whole scene' },
          events: strArr,
          storyContext: str,
          narration: { type: 'string', description: 'Spoken narration for this scene in the requested narration language' },
          uncertainties: strArr,
          confidence: { type: 'number' },
        },
        required: ['segmentIds', 'title', 'characters', 'description', 'events', 'narration', 'confidence'],
      },
    },
    characters: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: str, aliases: strArr, appearance: str, description: str },
        required: ['name'],
      },
    },
  },
  required: ['units', 'scenes', 'characters'],
};

// ----------------------------------------------------------------- stage 2
export const groupingSystem = (language: string, mode: 'original' | 'recap') => `You group analysed comic segments into story scenes AND write the narration for each scene in the same response.
A scene is a continuous piece of action in one place and time. Several consecutive segments usually form one scene; a single long segment may be a scene on its own.
Rules:
- Scenes must cover every segment exactly once, in the given order, using contiguous segment ids.
- Base everything strictly on the provided segment data. Do not add events that are not present.
- Keep character names consistent with the known-characters list; when the data only gives a descriptor, keep the descriptor.
- "storyContext" explains how the scene connects to the previous one using only information present in the data.
- Scenes are VISUAL story beats: never put raw dialogue/OCR text in "title", "description", "action" or "storyContext" — describe what is happening, not what is written.
- "narration": professional spoken ${languageName(language)} recap narration for the scene${language === 'hi' ? ' — conversational Hindi in Devanagari like popular Hindi manhwa-recap channels, natural loanwords, never word-by-word translation' : ''}.
  ${mode === 'original'
    ? 'ORIGINAL mode: preserve every important event, reveal and key dialogue (paraphrased naturally), in order.'
    : 'RECAP mode: condense filler and repeated beats but keep every plot-relevant event, reveal and decision.'}
  Engaging, cinematic, emotionally expressive, easy to follow when heard once. No meta talk ("in this panel", "the text says"). Never invent events or dialogue; flag doubts in "uncertainties".`;

export const groupingSchema = {
  type: 'object',
  properties: {
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          segmentIds: { type: 'array', items: { type: 'integer' } },
          title: str,
          location: str,
          characters: strArr,
          action: str,
          emotion: str,
          description: { type: 'string', description: 'Visual description of the whole scene' },
          events: strArr,
          storyContext: str,
          narration: { type: 'string', description: 'Spoken narration for this scene in the requested narration language' },
          uncertainties: strArr,
          confidence: { type: 'number' },
        },
        required: ['segmentIds', 'title', 'characters', 'description', 'events', 'narration', 'confidence'],
      },
    },
    characters: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: str, aliases: strArr, appearance: str, description: str },
        required: ['name'],
      },
    },
  },
  required: ['scenes', 'characters'],
};

// ------------------------------------------------------------------- story
export const storySystem = (language: string, mode: 'original' | 'recap') => `You are a professional ${languageName(language)} narrator writing a YouTube manga / manhwa storytelling script.
You receive the analysed scenes of a chapter in chronological order (with OCR dialogue), the story so far and the known characters.

Write narration for the scenes:
- Language: natural, spoken ${languageName(language)}${language === 'hi' ? ' (conversational Hindi in Devanagari, the way popular Hindi manhwa-recap channels speak; keep common English loanwords where natural; never a word-by-word translation)' : ''}.
- Style: engaging, cinematic and emotionally expressive, easy to understand when heard once. Short spoken sentences.
- ${mode === 'original'
  ? 'ORIGINAL STORY MODE: preserve every important event, reveal and key line of dialogue, in the original order. Paraphrase or quote dialogue naturally ("उसने गुस्से में कहा...").'
  : 'RECAP MODE: condense — summarise filler and repetitive beats, but keep every plot-relevant event, reveal and decision, in order. Adjacent minor scenes may share one segment.'}
- Never invent events, motives, names, backstory or dialogue that is not in the scene data. If something is unclear or the OCR was marked uncertain, narrate only what is certain and list the doubt in "uncertainties".
- Distinguish dialogue from narration. Keep character names exactly as in the known-characters list (transliterate consistently into the script of the narration language).
- Do not repeat information already told in the story so far or in the previous segment. No meta talk ("in this chapter", "the panel shows").
- Every scene number must appear in exactly one segment, in order (contiguous groups only).`;

export const storySchema = {
  type: 'object',
  properties: {
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sceneNumbers: { type: 'array', items: { type: 'integer' } },
          title: str,
          narration: str,
          emotion: str,
          confidence: { type: 'number' },
          uncertainties: strArr,
        },
        required: ['sceneNumbers', 'title', 'narration', 'emotion', 'confidence', 'uncertainties'],
      },
    },
    chapterSummary: { type: 'string', description: 'Factual 3-6 sentence summary of this chapter (in English, for continuity)' },
    continuitySummary: {
      type: 'string',
      description: 'Updated story-so-far summary (English, max ~250 words) including this chapter: main characters, relationships, abilities, unresolved threads',
    },
    characters: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: str, aliases: strArr, description: str, pronunciation: { type: 'string', description: 'Spelling in the narration script' } },
        required: ['name'],
      },
    },
  },
  required: ['segments', 'chapterSummary', 'continuitySummary', 'characters'],
};

export const REWRITE_ACTIONS = ['regenerate', 'shorten', 'expand', 'tone', 'translate'] as const;
export type RewriteAction = (typeof REWRITE_ACTIONS)[number];

export const rewriteInstruction = (action: RewriteAction, opts: { tone?: string; language: string }) =>
  ({
    regenerate: 'Write the narration for these scenes again from the scene data.',
    shorten: 'Shorten the current narration to roughly 60% of its length. Keep every plot-relevant event.',
    expand: 'Expand the current narration (about 140% length) with more vivid but strictly grounded description of what is shown. Do not add events.',
    tone: `Rewrite the current narration in a "${opts.tone || 'dramatic'}" tone. Keep the same events and facts.`,
    translate: `Rewrite the current narration in natural spoken ${languageName(opts.language)}. Keep the same events and facts.`,
  })[action];

export const rewriteSchema = {
  type: 'object',
  properties: { title: str, narration: str, emotion: str, confidence: { type: 'number' }, uncertainties: strArr },
  required: ['title', 'narration', 'confidence', 'uncertainties'],
};

/** Approximate words for duration estimates; Devanagari / Latin both split on whitespace. */
export const countWords = (text: string) => (text.trim() ? text.trim().split(/\s+/u).length : 0);
