# AGENTS.md — AI Manga-to-Video Studio

## Architecture

- **Backend** `src/`: Node.js + TypeScript + Express + Mongoose. Feature services live in `src/microservices/<name>-service/` (manga, pdf, story, voice, video, jobs, auth, files, users). Each has `route.ts` + `config.json` and is auto-registered. Zod validation via `Middleware.requestValidate`, auth via `Middleware.verifyToken`, responses through `ok(res, data)` / `AppError`.
- **Background jobs**: BullMQ. `ProcessingJob` documents track everything; `enqueueJob()` (src/libs/jobs/job.service.ts) with idempotency keys; handlers registered in `src/workers/processors/*.processor.ts` via `registerJobHandler(type, fn)` — imported by `src/workers/register.ts`. Workers run in-process when `WORKERS_IN_PROCESS=true`. Cancel via job's `cancelRequested`; use `ctx.throwIfCancelled()` between units of work and `ctx.progress()/ctx.log()`.
- **Frontend** `frontend/`: React + TS + Vite + TanStack Query + Zustand + React Router. API client `src/lib/api.ts`, queries `src/lib/queries.ts`, types `src/lib/types.ts`. Dark theme tokens: `bg-panel`, `border-line`, `text-muted` (no `border-border`/`text-muted-foreground`).
- **Metadata**: `src/libs/metadata/manga-metadata.ts` looks up public manga data (Jikan → AniList fallback) and seeds the Character registry on project create (`enrichFromPublicApi` in manga-service); `POST /api/manga/projects/:id/fetch-metadata` re-runs it.
- **AI**: provider abstraction `src/libs/ai/provider.ts` (vision) + `src/libs/ai/tts.ts` (tts); Gemini implementation via Interactions API `src/libs/ai/gemini.client.ts`. Prompts+schemas in `src/libs/ai/prompts.ts`.
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
- `npx tsc --noEmit -p .` / `cd frontend && npx tsc --noEmit` — typecheck.
- `npm run test:fixtures`, `node tests/mocks/gemini.js` — fixture + mock for e2e.
- E2E: `node --test tests/e2e/<name>.e2e.test.js` (needs API + mock Gemini :3999 + `GEMINI_API_KEY=mock-key GEMINI_API_BASE=http://127.0.0.1:3999` in `.env.development`).
- UI: `MSYS_NO_PATHCONV=1 node tests/ui/screenshots.js /<route>` → `tmp/ui/`.

## Gotchas

- Windows/Git Bash: prefix API paths with `MSYS_NO_PATHCONV=1` in curl/test scripts; use write/edit tools, not heredocs, for TS files (backslash mangling).
- Mongoose: never name a field `model` (collides with Document.model()); subdoc `_id` needs explicit Types.ObjectId when constructing.
- `.env.development` uses the real Gemini API — tests pass `GEMINI_API_KEY=mock-key GEMINI_API_BASE=http://127.0.0.1:3999` as env overrides. Scene detection uploads panel images via the Gemini Files API (`GEMINI_FILES_API`) and merges analysis+scenes+narration into one call when a chapter has ≤ `GEMINI_MAX_IMAGES_PER_CALL` images.
- Remotion render needs headless Chrome: auto-downloaded once (~100MB) or set `RENDER_BROWSER_EXECUTABLE`.
