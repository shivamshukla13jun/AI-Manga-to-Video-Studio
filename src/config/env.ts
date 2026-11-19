import dotenv from "dotenv";
import fs from "fs";
import path from "path";

const NODE_ENV = (process.env.NODE_ENV || "development") as
  | "development"
  | "staging"
  | "production";

// Load environment-specific file first, then .env as a fallback.
// dotenv never overrides already-set vars, so .env.<NODE_ENV> always wins.
const envFiles = [`.env.${NODE_ENV}`, ".env"];
for (const file of envFiles) {
  const fullPath = path.resolve(process.cwd(), file);
  if (fs.existsSync(fullPath)) {
    dotenv.config({ path: fullPath });
  }
}

function env(key: string): string | undefined;
function env(key: string, fallback: string): string;
function env(key: string, fallback?: string): string | undefined {
  return process.env[key] ?? fallback;
}

export type StorageProviderName =
  | "local"
  | "s3"
  | "cloudinary"
  | "firebase";

const STORAGE_PROVIDERS: StorageProviderName[] = [
  "local",
  "s3",
  "cloudinary",
  "firebase",
];

const storageProvider = (env("STORAGE_PROVIDER", "local") ||
  "local") as StorageProviderName;
if (!STORAGE_PROVIDERS.includes(storageProvider)) {
  throw new Error(
    `Invalid STORAGE_PROVIDER "${storageProvider}". Allowed: ${STORAGE_PROVIDERS.join(
      ", "
    )}`
  );
}

const rabbitUrl =
  env("RABBITMQ_URL") ||
  `amqp://${env("RABBITMQ_USERNAME")}:${env("RABBITMQ_PASSWORD")}@${env(
    "RABBITMQ_HOST"
  )}:${env("RABBITMQ_PORT")}`;

const config = {
  NODE_ENV,
  isProduction: NODE_ENV === "production",
  isStaging: NODE_ENV === "staging",

  PORT: Number(env("PORT")),
  BASE_URL: env("BASE_URL"),
  MONGO_URI: env("MONGO_URI"),
  FRONTEND_URL: env("FRONTEND_URL"),

  JWT_SECRET: env("JWT_SECRET"),
  REFRESH_TOKEN_SECRET: env("REFRESH_TOKEN_SECRET"),
  JWT_EXPIRE: env("JWT_EXPIRE", "1h"),

  BCRYPT_ROUNDS: Number(env("BCRYPT_ROUNDS", "12")),

  EMAIL_HOST: env("EMAIL_HOST"),
  EMAIL_PORT: env("EMAIL_PORT"),
  EMAIL_USER: env("EMAIL_USER"),
  EMAIL_PASSWORD: env("EMAIL_PASSWORD"),

  REDIS_HOST: env("REDIS_HOST"),
  REDIS_PORT: env("REDIS_PORT"),
  REDIS_PASSWORD: env("REDIS_PASSWORD"),
  REDIS_USERNAME: env("REDIS_USERNAME"),

  RABBITMQ_URL: rabbitUrl,
  RABBITMQ_HOST: env("RABBITMQ_HOST"),
  RABBITMQ_PORT: env("RABBITMQ_PORT"),
  RABBITMQ_USERNAME: env("RABBITMQ_USERNAME"),
  RABBITMQ_PASSWORD: env("RABBITMQ_PASSWORD"),

  // File upload / storage
  UPLOAD_BASE_DIR: env("UPLOAD_BASE_DIR", "uploads"),
  UPLOAD_MAX_SIZE: Number(env("UPLOAD_MAX_SIZE", "10485760")),
  ALLOWED_FILE_TYPES: (env("ALLOWED_FILE_TYPES", "") || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean),
  STORAGE_PROVIDER: storageProvider,

  AWS_REGION: env("AWS_REGION"),
  AWS_ACCESS_KEY_ID: env("AWS_ACCESS_KEY_ID"),
  AWS_SECRET_ACCESS_KEY: env("AWS_SECRET_ACCESS_KEY"),
  AWS_S3_BUCKET: env("AWS_S3_BUCKET"),
  AWS_S3_ENDPOINT: env("AWS_S3_ENDPOINT"),
  AWS_PUBLIC_URL: env("AWS_PUBLIC_URL"),
  CLOUDINARY_CLOUD_NAME: env("CLOUDINARY_CLOUD_NAME"),
  CLOUDINARY_API_KEY: env("CLOUDINARY_API_KEY"),
  CLOUDINARY_API_SECRET: env("CLOUDINARY_API_SECRET"),
  CLOUDINARY_FOLDER: env("CLOUDINARY_FOLDER"),

  FIREBASE_STORAGE_BUCKET: env("FIREBASE_STORAGE_BUCKET"),

  TWILIO_SID: env("TWILIO_SID"),
  TWILIO_AUTH_TOKEN: env("TWILIO_AUTH_TOKEN"),
  TWILIO_PHONE_NUMBER: env("TWILIO_PHONE_NUMBER"),

  CORS_ORIGIN: (env("CORS_ORIGIN", "") || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  CORS_CREDENTIALS: env("CORS_CREDENTIALS") !== "false",

  LOG_LEVEL: env("LOG_LEVEL", NODE_ENV === "production" ? "info" : "debug"),
  LOG_FILE: env("LOG_FILE", "logs/combined.log"),

  // Hybrid payload encryption (RSA-OAEP wrapped AES-256-GCM session keys).
  // When enabled, requests that send the `isencrypted: true` header get
  // their body decrypted and JSON responses returned as { iv, data }.
  ENCRYPTION_ENABLED: env("ENCRYPTION_ENABLED") === "true",
  ENCRYPTION_PRIVATE_KEY_PATH: env(
    "ENCRYPTION_PRIVATE_KEY_PATH",
    "keys/private.pem"
  ),
  ENCRYPTION_PUBLIC_KEY_PATH: env(
    "ENCRYPTION_PUBLIC_KEY_PATH",
    "keys/public.pem"
  ),
  ENCRYPTION_MAX_AGE_MS: Number(env("ENCRYPTION_MAX_AGE_MS", "300000")),

  // Auto-generated Swagger docs at /api-docs
  SWAGGER_ENABLED: env("SWAGGER_ENABLED") !== "false",
  SWAGGER_TITLE: env("SWAGGER_TITLE", "API Documentation"),

  // Run seeders automatically on server boot
  SEED_ON_BOOT: env("SEED_ON_BOOT") === "true",
  SEED_SUPERADMIN_EMAIL: env("SEED_SUPERADMIN_EMAIL"),
  SEED_SUPERADMIN_PASSWORD: env("SEED_SUPERADMIN_PASSWORD"),
  SEED_ADMIN_EMAIL: env("SEED_ADMIN_EMAIL"),
  SEED_ADMIN_PASSWORD: env("SEED_ADMIN_PASSWORD"),

  // Firebase service-account JSON (kept out of git)
  FIREBASE_SERVICE_ACCOUNT_PATH: env("FIREBASE_SERVICE_ACCOUNT_PATH"),

  // ---------------------------------------------------------------------------
  // AI Manga-to-Video Studio
  // ---------------------------------------------------------------------------
  // Scratch space for chunked uploads, extraction and rendering
  STUDIO_TEMP_DIR: env("STUDIO_TEMP_DIR", "tmp/studio"),
  // Storage folder prefix for all studio media (never served publicly)
  STUDIO_STORAGE_FOLDER: env("STUDIO_STORAGE_FOLDER", "studio"),
  // HMAC secret for short-lived signed media URLs (<img>/<audio> can't send bearer tokens)
  MEDIA_URL_SECRET: env("MEDIA_URL_SECRET") || env("JWT_SECRET"),
  MEDIA_URL_TTL_SECONDS: Number(env("MEDIA_URL_TTL_SECONDS", "21600")),

  // Uploads / archive safety
  CBZ_MAX_FILE_SIZE: Number(env("CBZ_MAX_FILE_SIZE", String(2 * 1024 ** 3))),
  UPLOAD_CHUNK_SIZE: Number(env("UPLOAD_CHUNK_SIZE", String(8 * 1024 ** 2))),
  UPLOAD_SESSION_TTL_HOURS: Number(env("UPLOAD_SESSION_TTL_HOURS", "48")),
  CBZ_MAX_ENTRIES: Number(env("CBZ_MAX_ENTRIES", "5000")),
  CBZ_MAX_UNCOMPRESSED_SIZE: Number(env("CBZ_MAX_UNCOMPRESSED_SIZE", String(6 * 1024 ** 3))),
  CBZ_MAX_ENTRY_SIZE: Number(env("CBZ_MAX_ENTRY_SIZE", String(200 * 1024 ** 2))),
  CBZ_MAX_COMPRESSION_RATIO: Number(env("CBZ_MAX_COMPRESSION_RATIO", "200")),
  IMAGE_MAX_PIXELS: Number(env("IMAGE_MAX_PIXELS", "250000000")),
  VOICE_SAMPLE_MAX_SIZE: Number(env("VOICE_SAMPLE_MAX_SIZE", String(25 * 1024 ** 2))),

  // Background workers — run inside the API process (dev) or via `npm run worker`
  WORKERS_IN_PROCESS: env("WORKERS_IN_PROCESS", "true") === "true",
  JOB_CONCURRENCY_EXTRACTION: Number(env("JOB_CONCURRENCY_EXTRACTION", "2")),
  JOB_CONCURRENCY_PDF: Number(env("JOB_CONCURRENCY_PDF", "1")),
  JOB_CONCURRENCY_IMAGE: Number(env("JOB_CONCURRENCY_IMAGE", "2")),
  JOB_CONCURRENCY_AI: Number(env("JOB_CONCURRENCY_AI", "2")),
  JOB_CONCURRENCY_TTS: Number(env("JOB_CONCURRENCY_TTS", "1")),
  JOB_CONCURRENCY_RENDER: Number(env("JOB_CONCURRENCY_RENDER", "1")),

  // AI calls run through the local ai-service / free-gemini-api proxy — no paid API
  AI_TILE_HEIGHT: Number(env("AI_TILE_HEIGHT", "2400")),
  AI_TILE_OVERLAP: Number(env("AI_TILE_OVERLAP", "300")),
  LOCAL_HTTP_TIMEOUT_MS: Number(env("LOCAL_HTTP_TIMEOUT_MS", "180000")),

  // Optional local inference service (ai-service/) — TTS, panel CV and local VLM story generation
  LOCAL_TTS_URL: env("LOCAL_TTS_URL", "http://127.0.0.1:8003"),
  PANEL_DETECT_URL: env("PANEL_DETECT_URL", env("LOCAL_TTS_URL", "http://127.0.0.1:8003")),
  LOCAL_STORY_MODEL: env("LOCAL_STORY_MODEL", "microsoft/Phi-3.5-vision-instruct-onnx"),
  // Shared with the Python ai-service — 'freegemini' routes all vision/story calls
  // through the free-gemini-api proxy (ai-service /generate-json → proxy /chat)
  STORY_LLM_KIND: env("STORY_LLM_KIND", "openai"),
  STORY_LLM_BASE_URL: env("STORY_LLM_BASE_URL", ""),
  STORY_LLM_MODEL: env("STORY_LLM_MODEL", ""),
  // ms; 0 = wait forever for the LLM backend (proxy latency is unpredictable)
  STORY_LLM_TIMEOUT_MS: Number(env("STORY_LLM_TIMEOUT_MS", "0")),

  // Media tooling
  FFMPEG_PATH: env("FFMPEG_PATH", "ffmpeg"),
  FFPROBE_PATH: env("FFPROBE_PATH", "ffprobe"),
  RENDERER_DIR: env("RENDERER_DIR", "video-renderer"),
  RENDER_SEGMENT_SECONDS: Number(env("RENDER_SEGMENT_SECONDS", "30")),
  // URL headless Chrome uses to fetch media while rendering
  RENDER_MEDIA_BASE_URL: env("RENDER_MEDIA_BASE_URL") || env("BASE_URL"),
  // Headless Chrome for Remotion (falls back to Remotion's managed browser)
  RENDER_BROWSER_EXECUTABLE: env("RENDER_BROWSER_EXECUTABLE"),
  // Rendered segment checkpoints persist here so failed renders can resume
  RENDER_CHECKPOINT_DIR: env("RENDER_CHECKPOINT_DIR", "tmp/render-checkpoints"),
  FX_API_BASE: env("FX_API_BASE", "https://open.er-api.com/v6/latest/USD"),

  // Public manga metadata (Jikan / MyAnimeList) used to seed characters on create
  MANGA_METADATA_ENABLED: env("MANGA_METADATA_ENABLED", "true") === "true",
  JIKAN_API_BASE: env("JIKAN_API_BASE", "https://api.jikan.moe/v4"),
  METADATA_TIMEOUT_MS: Number(env("METADATA_TIMEOUT_MS", "8000")),
};

// Only truly required values are validated here. Provider-specific
// credentials are validated lazily by the selected storage provider.
const requiredFields: (keyof typeof config)[] = [
  "PORT",
  "MONGO_URI",
  "JWT_SECRET",
  "REFRESH_TOKEN_SECRET",
  "FRONTEND_URL",
  "BASE_URL",
];

for (const field of requiredFields) {
  const value = config[field];
  if (value === undefined || value === null || value === "" || (typeof value === "number" && Number.isNaN(value))) {
    throw new Error(
      `Missing required environment configuration: ${field} (NODE_ENV=${NODE_ENV})`
    );
  }
}

if (config.ENCRYPTION_ENABLED && !config.ENCRYPTION_MAX_AGE_MS) {
  throw new Error("ENCRYPTION_MAX_AGE_MS must be a positive number");
}

export { NODE_ENV };
export default config;
