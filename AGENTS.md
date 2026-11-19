# AGENTS.md — AI Manga-to-Video Studio

## Architecture

- **Backend** `src/`: Node.js + TypeScript + Express + Mongoose. Feature services live in `src/microservices/<name>-service/` (manga, pdf, story, voice, video, jobs, auth, files, users). Each has `route.ts` + `config.json` and is auto-registered. Zod validation via `Middleware.requestValidate`, auth via `Middleware.verifyToken`, responses through `ok(res, data)` / `AppError`.
- **Background jobs**: BullMQ. `ProcessingJob` documents track everything; `enqueueJob()` (src/libs/jobs/job.service.ts) with idempotency keys; handlers registered in `src/workers/processors/*.processor.ts` via `registerJobHandler(type, fn)` — imported by `src/workers/register.ts`. Workers run in-process when `WORKERS_IN_PROCESS=true`. Cancel via job's `cancelRequested`; use `ctx.throwIfCancelled()` between units of work and `ctx.progress()/ctx.log()`.
- **Frontend** `frontend/`: React + TS + Vite + TanStack Query + Zustand + React Router. API client `src/lib/api.ts`, queries `src/lib/queries.ts`, types `src/lib/types.ts`. Dark theme tokens: `bg-panel`, `border-line`, `text-muted` (no `border-border`/`text-muted-foreground`).
- **Metadata**: `src/libs/metadata/manga-metadata.ts` looks up public manga data (Jikan → AniList fallback) and seeds the Character registry on project create (`enrichFromPublicApi` in manga-service); `POST /api/manga/projects/:id/fetch-metadata` re-runs it.
- **Merged PDF units**: `POST /api/manga/projects/:id/merge` (`mergeChaptersToPdfUnits`, manga.service.ts) batches ready chapters so each unit's page bytes stay ≤50MB, creates a `MangaChapter{kind:'merged', sourceChapters, pdfExport}` per batch with `ComicImage` rows that share the source file refs (no duplication — never delete those files for merged chapters), and queues a `pdf-conversion` job for the merged PDF. Scene detection + story generation run on the merged unit as one chapter.
- **Storage**: CBZ bytes are deleted after successful extraction (`ComicArchive.file` becomes null; doc stays for dedup/metadata). Re-extract/restore then fails with a clear error — replace the archive instead. PDF exports are built from `ComicImage` rows (respects skipPages/deleted pages/replacements; the pdf job waits for chapters still extracting). Scenes are DB-only — no scene files under `uploads/`; `scene.thumbnailUrl` falls back to the first region's page thumbnail.
- **Client-side merge** (default ON in UploadWorkspace): `frontend/src/lib/cbz-merge.ts` repacks all selected CBZs into ≤48MB archives in the browser (JSZip STORE, honors skip-first-page); each is uploaded with `autoMerge:true` → server creates a `kind:'merged'` chapter and auto-enqueues its `pdf-conversion` after extraction. Only merged units are stored — source CBZs never reach the server. A `merged` chapter is "borrowed" (shares source files) only when `sourceChapters` is non-empty — deletion logic keys on that.
- **AI = free only — no paid API paths.** `getVisionProvider()` returns a single `local` provider (accepts legacy 'gemini' names): Python ai-service `/generate-json`, backends via `STORY_LLM_KIND` — `freegemini` → kodelyx/free-gemini-api proxy at `STORY_LLM_BASE_URL` (Gemini web-session pool; images go multipart to `{root}/chat`); `openai` → OpenAI-compatible endpoint (GitHub Models/OpenRouter :free/Groq); unset `STORY_LLM_BASE_URL` → local ONNX VLM `LOCAL_STORY_MODEL`. Scene detection = Python CV (free). TTS = local voices only (`getTtsProvider` map has `local` only; 'gemini' requests → clear error). No estimate gate on story/TTS generation; estimates are heuristic/$0 for display. Mongo enums keep 'gemini' values for old stored docs.
- **free-gemini-api proxy**: clone at `D:\ai\free-gemini-api\free-gemini-api` (nested sibling dir). It's a `gemini-api` service in this repo's `docker-compose.yml` (build context points there) → :8002 (host remapped from 8001 to avoid ai-service conflict) + ws :9226 (Chrome-extension cookie bridge). Runs a built-in **guest worker** (free tier) with no setup; install the repo's Chrome extension + sign into gemini.google.com for account pooling/reliability. Env in `.env.development`: `STORY_LLM_KIND=freegemini`, `STORY_LLM_BASE_URL=http://localhost:8002/v1`, `STORY_LLM_MODEL=hydrogen` (free+vision; alternates: `gemini-4-argon`, `gemini-3.5-flash-lite`, `gemini-auto`). `/v1/chat/completions` is text-only — `/chat` is the multimodal endpoint. `GET /v1/workers` / `/health` show pool status.
- **Panel detection**: `detectPanels` (`src/libs/studio/panels.ts`) POSTs page bytes to the Python ai-service `POST /detect-panels` (`PANEL_DETECT_URL`, defaults to `LOCAL_TTS_URL`, 30s timeout, 30s circuit-breaker on failure) and falls back to the built-in Sharp XY-cut detector when unreachable or when the response is invalid. Always used — never Gemini.
- **OCR**: `ocrImages` (same file) POSTs base64 image batch to `POST /ocr` (RapidOCR ONNX in ai-service). Opt-in per story generation via `useOcr` — extracted lines are appended to `scene.dialogues` (`uncertain: true`) and injected into the prompt as per-scene text hints. With `translate_to: hi-roman` the service also returns a romanized-Hindi translation per line via one `STORY_LLM_*` cloud call (needs the cloud backend configured; falls back to original text).
- **AI**: provider abstraction `src/libs/ai/provider.ts` (vision) + `src/libs/ai/tts.ts` (tts) — both proxy to the Python ai-service; there is no cloud SDK/client file. Prompts+schemas in `src/libs/ai/prompts.ts`. `JsonResult.model` records the real backend model (e.g. `hydrogen@freegemini`).
- **Pricing/costs**: `src/config/pricing.json` seeded at boot; `pricing.service.ts` estimates+approves; `recordUsage` links actual tokens to estimates.
- **Rendering**: `video-renderer/` is a standalone Remotion project (mirrors `frontend/src/features/video/StudioComposition.tsx` — keep them in sync). `src/libs/render/renderer.ts` bundles once per process, renders checkpointed segments, ffmpeg concat+mix+mux.

## Conventions

- Media is private: `storeLocalFile`/`storeBuffer` → `File` doc → `mediaUrl(fileId)` signed URL (`/api/media/:id?exp&sig`). Never expose storage paths.
- All ObjectId params validated by `assertObjectId`; ownership via `ownerFilter(req)` / `getProject(req, id)`.
- Serializers live in `*.serializers.ts` per service — never return raw mongoose docs.
- Edit protection: scenes/segments have `editedBy` locks; timeline uses optimistic `revision` checks.
- No comments unless needed; compact TypeScript; match existing module layout.

## Commands

- `npm run dev:all` — one-command stack: docker compose (redis/rabbitmq) + free-gemini-api proxy + ai-service :8001 + API :3000 + frontend :5173. Flags: `-- --no-ui`, `-- --no-ai`. Ctrl+C stops local processes; docker containers keep running.
- `npm run dev` — API+workers on :3000 (nodemon). Kill port 3000 PID before restarting if routes 404 (stale process).
- `cd frontend && npm run dev` — UI :5173 (proxies /api and /socket.io).
- `npm run ai-service` — Python local AI service :8001 (panel detection + optional TTS); `npm run ai-service:install` to install its deps.
- `docker compose up -d` — redis + rabbitmq + free-gemini-api proxy :8002 (built from the sibling clone; guest worker works immediately, Chrome extension optional for pooling).
- `npx tsc --noEmit -p .` / `cd frontend && npx tsc --noEmit` — typecheck.
- `npm run test:fixtures` — CBZ fixtures for e2e.

- UI: `MSYS_NO_PATHCONV=1 node tests/ui/screenshots.js /<route>` → `tmp/ui/`.

## Gotchas

- Windows/Git Bash: prefix API paths with `MSYS_NO_PATHCONV=1` in curl/test scripts; use write/edit tools, not heredocs, for TS files (backslash mangling).
- Mongoose: never name a field `model` (collides with Document.model()); subdoc `_id` needs explicit Types.ObjectId when constructing.
- Scene detection is local CV (`detectPanels`, free, no AI) — one scene per panel; users merge in the scene editor. Story generation is the only AI step: scene crops are sent inline (base64) to ai-service `/generate-json` → free-gemini-api `/chat`, one vision call per chapter; narration maps back via `SCENE N` labels.
- Remotion render needs headless Chrome: auto-downloaded once (~100MB) or set `RENDER_BROWSER_EXECUTABLE`.
