/**
 * Mock Gemini Interactions API server for offline end-to-end tests.
 * Emulates POST /interactions and POST /models/{model}:countTokens with
 * deterministic, schema-shaped answers so the whole AI pipeline
 * (panel analysis -> scene grouping -> story generation -> rewrite)
 * can be exercised without a real API key.
 *
 * Run: node tests/mocks/gemini.js   (listens on PORT 3999)
 */
const http = require('http');

const PORT = Number(process.env.MOCK_GEMINI_PORT || 3999);
const usage = { total_input_tokens: 420, total_output_tokens: 180, total_thought_tokens: 30, total_tokens: 630 };

const textOf = (input) => (input || []).filter((p) => p?.type === 'text').flatMap((p) => p.text.split('\n'));

const jsonLine = (lines, marker) => {
  const line = lines.find((l) => l.startsWith(marker));
  if (!line) return [];
  try { return JSON.parse(line.slice(marker.length)); } catch { return []; }
};

const respond = (body) => {
  const schema = body?.response_format?.schema || {};
  const required = schema.required || [];
  const lines = textOf(body.input);
  const prompt = lines.join('\n');

  // Combined single call -> { units: [...], scenes: [...], characters: [...] }
  if (required.includes('units') && required.includes('scenes') && required.includes('characters')) {
    const units = [...new Set([...prompt.matchAll(/UNIT (\d+)/g)].map((m) => Number(m[1])))];
    const unitData = units.map((unit, i) => ({
      unit,
      segments: [{
        seg: i + 1,
        startTile: 1,
        startY: 0,
        characters: ['Hero', 'Rival'],
        action: `Mock action in panel unit ${unit}`,
        emotion: 'tense',
        location: 'battlefield',
        objects: ['sword'],
        events: [`Hero faces the Rival in panel ${unit}`],
        dialogues: [{ speaker: 'Hero', text: `Line from panel ${unit}`, kind: 'speech', uncertain: false }],
        visualDescription: `Mock visual description for unit ${unit}`,
        sceneStart: i === 0 || unit % 4 === 0,
        confidence: 0.9,
      }],
    }));
    const scenes = [];
    for (const ud of unitData) {
      for (const seg of ud.segments) {
        if (!scenes.length || seg.sceneStart) {
          scenes.push({ segmentIds: [], title: `Mock scene ${scenes.length + 1}`, location: seg.location, characters: [], action: '', emotion: seg.emotion, description: '', events: [], storyContext: '', narration: `MOCK narration for scene ${scenes.length + 1}. यह दृश्य कहानी को आगे बढ़ाता है।`, uncertainties: [], confidence: 0.85 });
        }
        const cur = scenes[scenes.length - 1];
        cur.segmentIds.push(seg.seg);
        cur.description = [cur.description, seg.visualDescription].filter(Boolean).join(' ');
        cur.events.push(...seg.events);
        cur.action = [cur.action, seg.action].filter(Boolean).join(' ');
        cur.characters = [...new Set([...cur.characters, ...seg.characters])];
      }
    }
    return { units: unitData, scenes, characters: [{ name: 'Hero', aliases: [], appearance: 'mock', description: 'Mock hero' }, { name: 'Rival', aliases: [], appearance: 'mock', description: 'Mock rival' }] };
  }

  // Stage 1: per-panel/tile visual analysis -> { units: [...] }
  if (required.includes('units')) {
    const units = [...prompt.matchAll(/UNIT (\d+)/g)].map((m) => Number(m[1]));
    const unique = [...new Set(units)];
    return {
      units: unique.map((unit, i) => ({
        unit,
        segments: [{
          startTile: 1,
          startY: 0,
          characters: ['Hero', 'Rival'],
          action: `Mock action in panel unit ${unit}`,
          emotion: 'tense',
          location: 'battlefield',
          objects: ['sword'],
          events: [`Hero faces the Rival in panel ${unit}`],
          dialogues: [{ speaker: 'Hero', text: `Line from panel ${unit}`, kind: 'speech', uncertain: false }],
          visualDescription: `Mock visual description for unit ${unit}`,
          sceneStart: i === 0,
          confidence: 0.9,
        }],
      })),
    };
  }

  // Stage 2: group segments -> { scenes: [...], characters: [...] }
  if (required.includes('scenes') && required.includes('characters')) {
    const segments = jsonLine(lines, 'Segments (JSON, in reading order): ');
    const scenes = [];
    for (const seg of segments) {
      if (!scenes.length || seg.sceneStart) {
        scenes.push({ segmentIds: [], title: `Mock scene ${scenes.length + 1}`, location: seg.location || '', characters: seg.characters || [], action: '', emotion: seg.emotion || '', description: '', events: [], storyContext: '', narration: `MOCK narration for scene ${scenes.length + 1} covering segments ${seg.id}. यह दृश्य कहानी को आगे बढ़ाता है।`, uncertainties: [], confidence: 0.85 });
      }
      const cur = scenes[scenes.length - 1];
      cur.segmentIds.push(seg.id);
      cur.description = [cur.description, seg.visual].filter(Boolean).join(' ');
      cur.events.push(...(seg.events || []));
      cur.action = [cur.action, seg.action].filter(Boolean).join(' ');
      cur.characters = [...new Set([...cur.characters, ...(seg.characters || [])])];
    }
    if (!scenes.length) scenes.push({ segmentIds: [], title: 'Empty', characters: [], description: '', events: [], confidence: 0.1 });
    const names = [...new Set(segments.flatMap((s) => s.characters || []))];
    return { scenes, characters: names.map((name) => ({ name, aliases: [], appearance: 'mock', description: `Mock character ${name}` })) };
  }

  // Story generation -> { segments, chapterSummary, continuitySummary, characters }
  if (required.includes('segments')) {
    const scenes = jsonLine(lines, 'Scenes (JSON, chronological): ');
    return {
      segments: scenes.map((s, i) => ({
        sceneNumbers: [i + 1],
        title: s.title || `Scene ${i + 1}`,
        narration: `MOCK narration for scene ${i + 1}: ${s.action || s.description || 'the story continues'}. यह दृश्य कहानी को आगे बढ़ाता है।`,
        emotion: s.emotion || 'neutral',
        confidence: 0.9,
        uncertainties: [],
      })),
      chapterSummary: 'Mock chapter summary covering all scenes.',
      continuitySummary: 'Mock continuity: the Hero met the Rival and the conflict began.',
      characters: [{ name: 'Hero', aliases: [], description: 'Mock hero', pronunciation: 'Hero' }],
    };
  }

  // Rewrite single segment -> { title, narration, confidence, uncertainties }
  if (required.includes('narration')) {
    return { title: 'Mock rewritten segment', narration: 'MOCK rewritten narration text. संशोधित वर्णन।', emotion: 'dramatic', confidence: 0.8, uncertainties: [] };
  }

  return { note: 'mock unhandled interaction' };
};

const silenceWav = () => {
  // 1 s of 24 kHz mono 16-bit WAV with a soft tone so durations are non-zero
  const rate = 24000, n = rate;
  const data = Buffer.alloc(44 + n * 2);
  data.write('RIFF', 0); data.writeUInt32LE(36 + n * 2, 4); data.write('WAVE', 8);
  data.write('fmt ', 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((i / rate) * 440 * 2 * Math.PI) * 6000), 44 + i * 2);
  return data;
};

const server = http.createServer((req, res) => {
  // Files API mock: resumable upload start + finalize
  if (req.method === 'POST' && req.url === '/upload/v1beta/files') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'x-goog-upload-url': `http://127.0.0.1:${PORT}/upload/finalize/${Date.now()}` }).end('{}');
    return;
  }
  if (req.method === 'POST' && req.url.startsWith('/upload/finalize/')) {
    const name = `files/mock-${req.url.split('/').pop()}`;
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ file: { name, uri: `https://files.mock/${name}`, state: 'ACTIVE', mime_type: 'image/jpeg' } }));
    req.resume();
    return;
  }
  if (req.method !== 'POST') { res.writeHead(404).end(); return; }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body;
    try { body = JSON.parse(raw || '{}'); } catch { res.writeHead(400).end('bad json'); return; }

    if (req.url.startsWith('/models/') && req.url.endsWith(':countTokens')) {
      const text = body?.contents?.[0]?.parts?.[0]?.text || '';
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ totalTokens: Math.ceil(text.length / 4) }));
      return;
    }
    if (req.url === '/interactions') {
      // TTS: audio response modality
      if ((body?.generation_config?.response_modalities || []).includes('AUDIO')) {
        const wav = silenceWav();
        const interaction = {
          id: `mock-tts-${Date.now()}`, status: 'completed',
          steps: [{ type: 'model_output', content: [{ type: 'audio', data: wav.toString('base64'), mime_type: 'audio/wav' }] }],
          usage: { total_input_tokens: Math.ceil((body?.input?.[0]?.text || '').length / 4), total_output_tokens: 25, total_thought_tokens: 0, total_tokens: 0 },
        };
        interaction.usage.total_tokens = interaction.usage.total_input_tokens + 25;
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(interaction));
        return;
      }
      // voice replication
      if (body?.response_format?.type === 'voice_profile') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
          id: `mock-voice-${Date.now()}`, status: 'completed',
          steps: [{ type: 'model_output', content: [{ type: 'text', text: 'voice created' }] }],
          voice_profile: { id: `cloned-${Math.random().toString(36).slice(2, 10)}` }, usage,
        }));
        return;
      }
      const out = respond(body);
      const interaction = {
        id: `mock-${Date.now()}`,
        status: 'completed',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(out) }] }],
        usage,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(interaction));
      return;
    }
    res.writeHead(404).end();
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`mock gemini listening on 127.0.0.1:${PORT}`));
