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


// ------------------------------------------------------- story (visual)
/** Narration written directly from the scene images (scenes come from the local CV detector, not from AI). */
export const visualStorySystem = (language: string, mode: 'original' | 'recap') => `You are a professional ${languageName(language)} narrator writing a YouTube manga / manhwa storytelling script.
You receive the panels of one chapter as images, in chronological order, labelled "SCENE n" (a merged scene may arrive as "SCENE n · PART k"). Each SCENE is one narration unit.

Write narration for every scene:
- Language: natural, spoken ${languageName(language)}${language === 'hi' ? ' (conversational Hindi in Devanagari, the way popular Hindi manhwa-recap channels speak; keep common English loanwords where natural; never a word-by-word translation)' : ''}.
- Style: engaging, cinematic and emotionally expressive, easy to understand when heard once. Short spoken sentences.
- ${mode === 'original'
  ? 'ORIGINAL STORY MODE: preserve every important event, reveal and key line of dialogue, in the original order. Paraphrase or quote dialogue naturally ("उसने गुस्से में कहा...").'
  : 'RECAP MODE: condense — summarise filler and repetitive beats, but keep every plot-relevant event, reveal and decision, in order. Adjacent minor scenes may share one segment.'}
- Describe only what is actually shown in the images — never invent events, motives, names, backstory or dialogue. Read the speech bubbles in the panels for dialogue; if text is unreadable, narrate only the visuals and list the doubt in "uncertainties".
- Distinguish dialogue from narration. Keep character names consistent with the known-characters list (transliterate into the narration script); if a name is never written, keep a short visual descriptor.
- Do not repeat information already told in the story so far or in the previous segment. No meta talk ("in this chapter", "the panel shows").
- Every scene number must appear in exactly one segment, in order (contiguous groups only).`;

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
