# AGENTS.md — AI Manga-to-Video Studio

## Architecture

- **Backend** `src/`: Node.js + TypeScript + Express + Mongoose. Feature services live in `src/microservices/<name>-service/` (manga, pdf, story, voice, video, jobs, auth, files, users). Each has `route.ts` + `config.json` and is auto-registered. Zod validation via `Middleware.requestValidate`, auth via `Middleware.verifyToken`, responses through `ok(res, data)` / `AppError`.
- **Background jobs**: BullMQ. `ProcessingJob` documents track everything; `enqueueJob()` (src/libs/jobs/job.service.ts) with idempotency keys; handlers registered in `src/workers/processors/*.processor.ts` via `registerJobHandler(type, fn)` — imported by `src/workers/register.ts`. Workers run in-process when `WORKERS_IN_PROCESS=true`. Cancel via job's `cancelRequested`; use `ctx.throwIfCancelled()` between units of work and `ctx.progress()/ctx.log()`.
- **Frontend** `frontend/`: React + TS + Vite + TanStack Query + Zustand + React Router. API client `src/lib/api.ts`, queries `src/lib/queries.ts`, types `src/lib/types.ts`. Dark theme tokens: `bg-panel`, `border-line`, `text-muted` (no `border-border`/`text-muted-foreground`).
- **Metadata**: `src/libs/metadata/manga-metadata.ts` looks up public manga data (Jikan → AniList fallback) and seeds the Character registry on project create (`enrichFromPublicApi` in manga-service); `POST /api/manga/projects/:id/fetch-metadata` re-runs it.
- **Merged PDF units**: `POST /api/manga/projects/:id/merge` (`mergeChaptersToPdfUnits`, manga.service.ts) batches ready chapters so each unit's page bytes stay ≤50MB, creates a `MangaChapter{kind:'merged', sourceChapters, pdfExport}` per batch with `ComicImage` rows that share the source file refs (no duplication — never delete those files for merged chapters), and queues a `pdf-conversion` job for the merged PDF. Scene detection + story generation run on the merged unit as one chapter.
- **Storage**: CBZ bytes are deleted after successful extraction (`ComicArchive.file` becomes null; doc stays for dedup/metadata). Re-extract/restore then fails with a clear error — replace the archive instead. PDF exports are built from `ComicImage` rows (respects skipPages/deleted pages/replacements; the pdf job waits for chapters still extracting). Scenes are DB-only — no scene files under `uploads/`; `scene.thumbnailUrl` falls back to the first region's page thumbnail.
- **Client-side merge** (default ON in UploadWorkspace): `frontend/src/lib/cbz-merge.ts` repacks all selected CBZs into ≤48MB archives in the browser (JSZip STORE, honors skip-first-page); each is uploaded with `autoMerge:true` → server creates a `kind:'merged'` chapter and auto-enqueues its `pdf-conversion` after extraction. Only merged units are stored — source CBZs never reach the server. A `merged` chapter is "borrowed" (shares source files) only when `sourceChapters` is non-empty — deletion logic keys on that.
- **AI provider setting**: `StudioSettings.aiProvider` (`gemini|local`, Settings page) controls story generation ONLY — scene detection always uses the Python CV service (free, no estimate). Story `local` → Python ai-service `/generate-json` (backends: `STORY_LLM_BASE_URL` set → OpenAI-compatible cloud endpoint — Gemini free tier default; also GitHub Models/OpenRouter :free/Groq — see .env.example; else local onnxruntime-genai VLM `LOCAL_STORY_MODEL`, ~4GB, CPU-heavy). Story `gemini` → Gemini story gated by cost estimates. Local story skips the paid-estimate gate.
- **Panel detection**: `detectPanels` (`src/libs/studio/panels.ts`) POSTs page bytes to the Python ai-service `POST /detect-panels` (`PANEL_DETECT_URL`, defaults to `LOCAL_TTS_URL`, 30s timeout, 30s circuit-breaker on failure) and falls back to the built-in Sharp XY-cut detector when unreachable or when the response is invalid. Always used — never Gemini.
- **AI**: provider abstraction `src/libs/ai/provider.ts` (vision) + `src/libs/ai/tts.ts` (tts); Gemini implementation via Interactions API `src/libs/ai/gemini.client.ts`. Prompts+schemas in `src/libs/ai/prompts.ts`. `createInteraction` accepts `model: string[]` — an ordered fallback chain (`GEMINI_VISION_MODELS`/`GEMINI_STORY_MODELS`/`GEMINI_TTS_MODELS` env, comma-separated best→cheapest); a model that returns 429/quota errors is cooled down 60s and the next model is tried. `InteractionResult.model` = the model that actually answered (use it for usage/cost records).
- **Pricing/costs**: `src/config/pricing.json` seeded at boot; `pricing.service.ts` estimates+approves; `recordUsage` links actual tokens to estimates.
- **Rendering**: `video-renderer/` is a standalone Remotion project (mirrors `frontend/src/features/video/StudioComposition.tsx` — keep them in sync). `src/libs/render/renderer.ts` bundles once per process, renders checkpointed segments, ffmpeg concat+mix+mux.

## Conventions

- Media is private: `storeLocalFile`/`storeBuffer` → `File` doc → `mediaUrl(fileId)` signed URL (`/api/media/:id?exp&sig`). Never expose storage paths.
- All ObjectId params validated by `assertObjectId`; ownership via `ownerFilter(req)` / `getProject(req, id)`.
- Serializers live in `*.serializers.ts` per service — never return raw mongoose docs.
- Edit protection: scenes/segments have `editedBy` locks; timeline uses optimistic `revision` checks.
- No comments unless needed; compact TypeScript; match existing module layout.

## Commands

- `npm run dev` — API+workers on :3000 (nodemon). Kill port 3000 PID before restarting if routes 404 (stale process).
- `cd frontend && npm run dev` — UI :5173 (proxies /api and /socket.io).
- `npm run ai-service` — Python local AI service :8001 (panel detection + optional TTS); `npm run ai-service:install` to install its deps.
- `npx tsc --noEmit -p .` / `cd frontend && npx tsc --noEmit` — typecheck.
- `npm run test:fixtures`, `node tests/mocks/gemini.js` — fixture + mock for e2e.
- E2E: `node --test tests/e2e/<name>.e2e.test.js` (needs API + mock Gemini :3999 + `GEMINI_API_KEY=mock-key GEMINI_API_BASE=http://127.0.0.1:3999` in `.env.development`).
- UI: `MSYS_NO_PATHCONV=1 node tests/ui/screenshots.js /<route>` → `tmp/ui/`.

## Gotchas

- Windows/Git Bash: prefix API paths with `MSYS_NO_PATHCONV=1` in curl/test scripts; use write/edit tools, not heredocs, for TS files (backslash mangling).
- Mongoose: never name a field `model` (collides with Document.model()); subdoc `_id` needs explicit Types.ObjectId when constructing.
- `.env.development` uses the real Gemini API — tests pass `GEMINI_API_KEY=mock-key GEMINI_API_BASE=http://127.0.0.1:3999` as env overrides. Scene detection is local CV (`detectPanels`, free, no AI) — one scene per panel; users merge in the scene editor. Story generation is the only AI step: scene crops upload via the Gemini Files API (`GEMINI_FILES_API`) and narration for the whole chapter comes back in one vision call.
- Remotion render needs headless Chrome: auto-downloaded once (~100MB) or set `RENDER_BROWSER_EXECUTABLE`.
