"""
Local AI service for AI Manga-to-Video Studio: TTS + panel detection.

Optional component: the main app works without it — the backend marks the
'local' provider unavailable when this service is not reachable.

Engines (all optional; whichever is installed is used):
  - piper   : CLI `piper` binary or `piper-tts` python package + .onnx voices
  - kokoro  : `kokoro` python package (82M model, downloads on first use)
  - xtts    : `TTS` (coqui) package with XTTS-v2 (GPU recommended)

Endpoints:
  GET  /status         -> { engines: [{id, available, detail}] }
  GET  /voices         -> { voices: [{id, name, engine, languages, gender}] }
  POST /tts            -> {text, voice, language, speed} -> audio/wav
  POST /detect-panels  -> raw image bytes or {image: base64, rtl} -> {panels: [{x,y,width,height}]}
  POST /ocr            -> {images: [base64]} -> {results: [{lines: [{text, confidence}]}]}
                         RapidOCR (ONNX) — speech-bubble text extraction for story generation
  POST /generate-json  -> {system, prompt, schema, images:[{data,mimeType,label}]} -> {data, usage, model}
                         Backends, in priority order:
                           1) STORY_LLM_BASE_URL set -> OpenAI-compatible cloud endpoint
                              (GitHub Models, OpenRouter :free, Pollinations, Groq,
                              Gemini OpenAI-compat — free tiers work; no CPU burn)
                           2) local vision-language model via onnxruntime-genai
                              (Phi-3.5-vision ONNX int4; LOCAL_STORY_MODEL / _DIR / _SUBDIR)

Run:  pip install -r requirements.txt && uvicorn app:app --port 8003
"""
import base64
import hashlib
import io
import json as _json
import os
import shutil
import subprocess
import tempfile
import threading
import urllib.error
import urllib.request
import wave
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

PIPER_VOICES_DIR = os.environ.get("PIPER_VOICES_DIR", os.path.join(os.path.dirname(__file__), "voices"))
DEFAULT_XTTS_REFERENCE = os.environ.get("XTTS_REFERENCE_WAV", "")

app = FastAPI(title="Studio Local AI", version="0.3.0")


class SpeakRequest(BaseModel):
    text: str
    voice: str
    language: str = "hi"
    speed: float = 1.0


# ------------------------------------------------------------------ engines
class Engine:
    id = "base"

    def available(self) -> bool:
        return False

    def detail(self) -> str:
        return "not installed"

    def voices(self) -> list[dict]:
        return []

    def speak(self, text: str, voice: str, language: str, speed: float, out_wav: str) -> None:
        raise NotImplementedError


class PiperEngine(Engine):
    id = "piper"

    def __init__(self):
        self.bin = shutil.which("piper")

    def available(self) -> bool:
        if not self.bin:
            try:
                import piper  # noqa: F401
            except ImportError:
                return False
        return True

    def detail(self) -> str:
        return f"binary at {self.bin}" if self.bin else "python package"

    def _models(self) -> list[tuple[str, str]]:
        models = []
        if os.path.isdir(PIPER_VOICES_DIR):
            for f in sorted(os.listdir(PIPER_VOICES_DIR)):
                if f.endswith(".onnx"):
                    models.append((f[:-5], os.path.join(PIPER_VOICES_DIR, f)))
        return models

    def voices(self) -> list[dict]:
        return [
            {"id": name, "name": name, "engine": self.id, "languages": [name.split("_")[0].split("-")[0]], "description": "Piper ONNX voice"}
            for name, _ in self._models()
        ]

    def speak(self, text: str, voice: str, language: str, speed: float, out_wav: str) -> None:
        models = dict(self._models())
        model = models.get(voice)
        if not model:
            raise RuntimeError(f"piper voice '{voice}' not found in {PIPER_VOICES_DIR}")
        args = [self.bin or "piper", "--model", model, "--output_file", out_wav]
        if speed and speed != 1:
            args += ["--length-scale", str(round(1.0 / speed, 3))]
        proc = subprocess.run(args, input=text.encode("utf-8"), capture_output=True, timeout=600)
        if proc.returncode != 0:
            raise RuntimeError(f"piper failed: {proc.stderr.decode()[:300]}")


class KokoroEngine(Engine):
    id = "kokoro"
    _pipelines: dict = {}

    def available(self) -> bool:
        try:
            import kokoro  # noqa: F401
        except ImportError:
            return False
        return True

    def detail(self) -> str:
        return "kokoro python package"

    def voices(self) -> list[dict]:
        if not self.available():
            return []
        # a small built-in set; kokoro ships many voices (af_*, bf_*, hf_*, jf_*, zf_*)
        return [
            {"id": "hf_alpha", "name": "hf_alpha (Hindi female)", "engine": self.id, "languages": ["hi"]},
            {"id": "hf_beta", "name": "hf_beta (Hindi male)", "engine": self.id, "languages": ["hi"]},
            {"id": "af_heart", "name": "af_heart (English female)", "engine": self.id, "languages": ["en"]},
            {"id": "am_michael", "name": "am_michael (English male)", "engine": self.id, "languages": ["en"]},
        ]

    def speak(self, text: str, voice: str, language: str, speed: float, out_wav: str) -> None:
        import numpy as np
        import soundfile as sf
        from kokoro import KPipeline

        lang_code = "h" if language.startswith("hi") else "a"
        pipeline = self._pipelines.get(lang_code) or KPipeline(lang_code=lang_code)
        self._pipelines[lang_code] = pipeline
        chunks = [a for _g, _p, a in pipeline(text, voice=voice, speed=speed or 1.0)]
        if not chunks:
            raise RuntimeError("kokoro produced no audio")
        sf.write(out_wav, np.concatenate(chunks), 24000)


class XttsEngine(Engine):
    id = "xtts"
    _tts = None

    def available(self) -> bool:
        try:
            import TTS  # noqa: F401
        except ImportError:
            return False
        return True

    def detail(self) -> str:
        return "coqui TTS package"

    def _load(self):
        if self._tts is None:
            from TTS.api import TTS

            self._tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2")
        return self._tts

    def voices(self) -> list[dict]:
        if not self.available():
            return []
        return [{"id": "xtts_v2", "name": "XTTS-v2 (voice clone — needs reference wav)", "engine": self.id, "languages": ["hi", "en", "multilingual"], "custom": True}]

    def speak(self, text: str, voice: str, language: str, speed: float, out_wav: str) -> None:
        if not DEFAULT_XTTS_REFERENCE or not os.path.exists(DEFAULT_XTTS_REFERENCE):
            raise RuntimeError("XTTS needs XTTS_REFERENCE_WAV pointing at a consented reference clip")
        tts = self._load()
        tts.tts_to_file(text=text, speaker_wav=DEFAULT_XTTS_REFERENCE, language="hi" if language.startswith("hi") else "en", file_path=out_wav, speed=speed or 1.0)


ENGINES: list[Engine] = [PiperEngine(), KokoroEngine(), XttsEngine()]


# ------------------------------------------------------------ panel detect
def _detect_panels(img_bytes: bytes, rtl: bool = False) -> list[dict]:
    """Manga/manhwa panel detection with OpenCV: content mask → external
    contours → filter → reading-order sort. Normalized 0..1 boxes."""
    import cv2
    import numpy as np

    arr = np.frombuffer(img_bytes, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        return []
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # Background colour estimated from the page border (works for white/black margins)
    bw = max(4, min(h, w) // 100)
    border = np.concatenate([gray[:bw].ravel(), gray[-bw:].ravel(), gray[:, :bw].ravel(), gray[:, -bw:].ravel()])
    bg = float(np.median(border))
    mask = (np.abs(gray.astype(np.int16) - bg) > 30).astype(np.uint8) * 255

    # Close small holes inside panels — kernel stays well below typical gutter width
    k = max(3, int(min(h, w) * 0.012))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (k, k)))

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    min_area = 0.012 * w * h
    for c in contours:
        x, y, cw, ch = cv2.boundingRect(c)
        if cw * ch < min_area:
            continue
        # Shrink contour noise: keep the true edge by requiring decent fill inside the box
        boxes.append((x, y, cw, ch))

    if not boxes:
        return [{"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0}]

    # Reading order: group into rows by vertical overlap, order rows top→bottom,
    # inside a row order left→right (RTL reverses)
    boxes.sort(key=lambda b: (b[1], b[0]))
    rows: list[list] = []
    for b in sorted(boxes, key=lambda b: b[1]):
        cy = b[1] + b[3] / 2
        placed = False
        for row in rows:
            r = row[0]
            if abs(cy - (r[1] + r[3] / 2)) < max(b[3], r[3]) * 0.6:
                row.append(b)
                placed = True
                break
        if not placed:
            rows.append([b])
    out = []
    for row in rows:
        row.sort(key=lambda b: b[0], reverse=rtl)
        out.extend(row)
    return [
        {"x": round(x / w, 6), "y": round(y / h, 6), "width": round(cw / w, 6), "height": round(ch / h, 6)}
        for x, y, cw, ch in out
    ]


class PanelsRequest(BaseModel):
    image: str  # base64
    rtl: bool = False


# ------------------------------------------------------------- local story model
# Vision-language model running fully inside this service via onnxruntime-genai.
# Default: microsoft/Phi-3.5-vision-instruct-onnx (CPU int4, ~4GB, auto-downloaded
# from HuggingFace on first use). No Ollama, no GPU, no cloud calls.
# ------------------------------------------------------- optional cloud backend
# Free OpenAI-compatible endpoint — set STORY_LLM_BASE_URL to use it instead of
# the local ONNX model. Examples (all free tiers):
#   GitHub Models : https://models.github.ai/inference   + PAT, model openai/gpt-4o-mini
#   OpenRouter    : https://openrouter.ai/api/v1         + free key, model <vendor>/<model>:free
#   Pollinations  : https://text.pollinations.ai/openai  no key, model openai
#   Groq          : https://api.groq.com/openai/v1       + free key, vision model
#   Gemini        : https://generativelanguage.googleapis.com/v1beta/openai + AI Studio key
STORY_LLM_BASE_URL = os.environ.get("STORY_LLM_BASE_URL", "").rstrip("/")
STORY_LLM_API_KEY = os.environ.get("STORY_LLM_API_KEY", "")
STORY_LLM_MODEL = os.environ.get("STORY_LLM_MODEL", "openai/gpt-4o-mini")
STORY_LLM_MAX_IMAGES = int(os.environ.get("STORY_LLM_MAX_IMAGES", "0") or "0")  # 0 = all images
# 'openai' = OpenAI-compatible /chat/completions; 'freegemini' = kodelyx/free-gemini-api
# proxy (Gemini web session pool) — images via multipart POST {root}/chat
STORY_LLM_KIND = os.environ.get("STORY_LLM_KIND", "openai")

LOCAL_STORY_MODEL = os.environ.get("LOCAL_STORY_MODEL", "microsoft/Phi-3.5-vision-instruct-onnx")
LOCAL_STORY_MODEL_DIR = os.environ.get("LOCAL_STORY_MODEL_DIR", "")
LOCAL_STORY_SUBDIR = os.environ.get("LOCAL_STORY_SUBDIR", "cpu_and_mobile/cpu-int4-rtn-block-32-acc-level-4")
MAX_INLINE_IMAGES = 3  # ≤ N images → one multimodal call; more → caption-then-compose

_S: dict = {"model": None, "processor": None, "tokenizer": None, "stream": None, "failed": None}
_CAPTIONS: dict = {}
_GEN_LOCK = threading.Lock()


def _story_model_dir() -> str:
    if LOCAL_STORY_MODEL_DIR:
        if not os.path.isdir(LOCAL_STORY_MODEL_DIR):
            raise RuntimeError(f"LOCAL_STORY_MODEL_DIR '{LOCAL_STORY_MODEL_DIR}' does not exist")
        return LOCAL_STORY_MODEL_DIR
    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        raise RuntimeError("huggingface-hub not installed — run `npm run ai-service:install`")
    try:
        base = snapshot_download(LOCAL_STORY_MODEL, allow_patterns=[f"{LOCAL_STORY_SUBDIR}/*"])
    except Exception as e:
        raise RuntimeError(f"could not download story model '{LOCAL_STORY_MODEL}': {e}")
    d = os.path.join(base, LOCAL_STORY_SUBDIR)
    if not os.path.isdir(d):
        d = base
    if not os.path.exists(os.path.join(d, "genai_config.json")):
        raise RuntimeError(f"'{LOCAL_STORY_MODEL}' has no genai_config.json in '{d}' — set LOCAL_STORY_MODEL_DIR or LOCAL_STORY_SUBDIR")
    return d


def _load_story_model():
    if _S["model"] is not None:
        return
    if _S["failed"] is not None:
        raise RuntimeError(_S["failed"])
    try:
        try:
            import onnxruntime_genai as og
        except ImportError:
            raise RuntimeError("onnxruntime-genai not installed — run `npm run ai-service:install`")
        d = _story_model_dir()
        _S["model"] = og.Model(d)
        _S["processor"] = _S["model"].create_multimodal_processor()
        _S["tokenizer"] = og.Tokenizer(_S["model"])
        _S["stream"] = _S["processor"].create_stream()
    except RuntimeError as e:
        _S["failed"] = str(e)
        raise
    except Exception as e:
        _S["failed"] = f"failed to load local story model: {e}"
        raise RuntimeError(_S["failed"])


def _generate(prompt: str, image_bytes: list[bytes] | None = None, max_tokens: int = 4096, temperature: float = 0.3) -> str:
    """One completion. Serialised behind a lock — the int4 model is CPU-bound."""
    _load_story_model()
    import onnxruntime_genai as og

    with _GEN_LOCK:
        in_len = len(_S["tokenizer"].encode(prompt)) + (len(image_bytes) if image_bytes else 0) * 2048
        params = og.GeneratorParams(_S["model"])
        params.set_search_options(
            max_length=in_len + max_tokens,
            do_sample=True,
            temperature=temperature,
            top_p=0.9,
        )
        gen = og.Generator(_S["model"], params)
        if image_bytes:
            gen.set_inputs(_S["processor"](prompt, images=og.Images.open_bytes(*image_bytes)))
        else:
            gen.append_tokens(_S["tokenizer"].encode(prompt))
        out: list[str] = []
        while not gen.is_done():
            gen.generate_next_token()
            out.append(_S["stream"].decode(gen.get_next_tokens()[0]))
        return "".join(out).strip()


_CAPTION_Q = (
    "Describe this comic/manga panel in 2-4 concise sentences: visible characters, their action, "
    "emotion and setting. Never invent dialogue or text that is not clearly readable."
)


def _caption_image(img_bytes: bytes) -> str:
    key = hashlib.sha256(img_bytes).hexdigest()
    if key in _CAPTIONS:
        return _CAPTIONS[key]
    cap = _generate(
        f"<|user|>\n<|image_1|>\n{_CAPTION_Q}<|end|>\n<|assistant|>\n",
        image_bytes=[img_bytes],
        max_tokens=512,
        temperature=0.2,
    )
    _CAPTIONS[key] = cap
    return cap


def _extract_json(text: str) -> dict:
    t = text.strip()
    if t.startswith("```"):
        t = t.split("```")[1]
        if t.lstrip().startswith("json"):
            t = t.lstrip()[4:]
    try:
        return _json.loads(t)
    except Exception:
        start, end = t.find("{"), t.rfind("}")
        if start >= 0 and end > start:
            return _json.loads(t[start : end + 1])
    raise RuntimeError(f"local model returned non-JSON output: {text[:200]}")


def _cloud_chat(body: dict) -> dict:
    url = f"{STORY_LLM_BASE_URL}/chat/completions"
    req = urllib.request.Request(
        url,
        data=_json.dumps(body).encode(),
        headers={
            "Content-Type": "application/json",
            **({"Authorization": f"Bearer {STORY_LLM_API_KEY}"} if STORY_LLM_API_KEY else {}),
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=None) as r:
            return _json.loads(r.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:400]
        retryable = e.code == 429 or e.code >= 500
        raise RuntimeError(f"cloud story endpoint {e.code}{' (rate-limited/down — retryable)' if retryable else ''}: {detail}")
    except Exception as e:
        raise RuntimeError(f"cloud story endpoint unreachable at {url}: {e}")


def _cloud_generate_json(system: str, prompt: str, schema: dict, images: list[dict]) -> dict:
    """One OpenAI-compatible chat-completion call with every scene image inlined —
    a whole chapter costs a single free-tier request."""
    content: list[dict] = []
    if prompt:
        content.append({"type": "text", "text": prompt})
    decoded = (images or [])[: STORY_LLM_MAX_IMAGES or len(images or [])]
    for img in decoded:
        if img.get("label"):
            content.append({"type": "text", "text": img["label"]})
        if img.get("data"):
            content.append({"type": "image_url", "image_url": {"url": f"data:{img.get('mimeType') or 'image/png'};base64,{img['data']}"}})
    if schema:
        content.append({"type": "text", "text": f"Respond ONLY with one JSON object matching this schema (no markdown fences, no commentary):\n{_json.dumps(schema)}"})

    messages = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": content}]
    base = {"model": STORY_LLM_MODEL, "messages": messages, "temperature": 0.3, "max_tokens": 8192}
    try:
        resp = _cloud_chat({**base, "response_format": {"type": "json_object"}})
    except RuntimeError as e:
        if " 400" not in str(e):
            raise
        resp = _cloud_chat(base)  # provider rejected response_format — plain call

    text = (resp.get("choices") or [{}])[0].get("message", {}).get("content") or ""
    usage = resp.get("usage") or {}
    return {
        "data": _extract_json(text),
        "model": resp.get("model") or STORY_LLM_MODEL,
        "usage": {
            "inputTokens": usage.get("prompt_tokens", 0),
            "outputTokens": usage.get("completion_tokens", max(1, len(text) // 4)),
        },
    }


def _proxy_generate_json(system: str, prompt: str, schema: dict, images: list[dict]) -> dict:
    """kodelyx/free-gemini-api proxy — Gemini web session pool, no API key.
    Images go as multipart 'images' files; filenames carry the SCENE labels."""
    import requests

    root = STORY_LLM_BASE_URL[: -len("/v1")] if STORY_LLM_BASE_URL.endswith("/v1") else STORY_LLM_BASE_URL
    text = "\n\n".join(p for p in [
        system,
        prompt,
        f"Respond ONLY with one JSON object matching this schema (no markdown fences, no commentary):\n{_json.dumps(schema)}" if schema else "",
    ] if p)
    decoded = (images or [])[: STORY_LLM_MAX_IMAGES or len(images or [])]
    files = [
        ("images", (
            (img.get("label") or f"scene_{i}").replace(" ", "_").replace("·", "-") + ".jpg",
            base64.b64decode(img["data"]),
            img.get("mimeType") or "image/jpeg",
        ))
        for i, img in enumerate(decoded)
    ]
    try:
        resp = requests.post(
            f"{root}/chat",
            data={"prompt": text, "model": STORY_LLM_MODEL, "new_chat": "true", "stream": "false"},
            files=files or None,
            timeout=None,
        )
    except Exception as e:
        raise RuntimeError(f"free-gemini-api proxy unreachable at {root}: {e}")
    if resp.status_code != 200:
        detail = resp.text[:400]
        raise RuntimeError(f"free-gemini-api proxy {resp.status_code}{' (rate-limited/down — retryable)' if resp.status_code == 429 or resp.status_code >= 500 else ''}: {detail}")
    try:
        j = resp.json()
    except Exception:
        raise RuntimeError(f"free-gemini-api proxy returned non-JSON: {resp.text[:200]}")
    if j.get("error"):
        raise RuntimeError(f"free-gemini-api proxy error: {j['error']}")
    raw = j.get("text") or ""
    if not raw:
        raise RuntimeError("free-gemini-api proxy returned empty text — is a Gemini account connected via the Chrome extension?")
    return {
        "data": _extract_json(raw),
        "model": f"{STORY_LLM_MODEL}@freegemini",
        "usage": {"inputTokens": 0, "outputTokens": max(1, len(raw) // 4)},
    }


def _local_generate_json(system: str, prompt: str, schema: dict, images: list[dict]) -> dict:
    """Grounded story JSON. Cloud endpoint when STORY_LLM_BASE_URL is set;
    else fully in-process: ≤ MAX_INLINE_IMAGES → single multimodal call, more →
    caption each scene first then a text-only compose call (captions cached)."""
    if STORY_LLM_BASE_URL:
        if STORY_LLM_KIND == "freegemini":
            return _proxy_generate_json(system, prompt, schema, images)
        return _cloud_generate_json(system, prompt, schema, images)
    decoded = []
    for img in images or []:
        data = base64.b64decode(img.get("data", "")) if img.get("data") else b""
        decoded.append((img.get("label") or f"IMAGE {len(decoded) + 1}", data))
    schema_hint = f"\n\nRespond ONLY with one JSON object matching this schema (no markdown fences, no commentary):\n{_json.dumps(schema)}" if schema else ""
    sys_tag = f"<|system|>\n{system}<|end|>\n" if system else ""

    if decoded and len(decoded) <= MAX_INLINE_IMAGES:
        image_tokens = "".join(f"<|image_{i + 1}|>\n" for i in range(len(decoded)))
        full = f"{sys_tag}<|user|>\n{image_tokens}{prompt}{schema_hint}<|end|>\n<|assistant|>\n"
        raw = _generate(full, image_bytes=[d for _l, d in decoded], max_tokens=8192)
    else:
        listing = ""
        if decoded:
            lines = []
            for label, data in decoded:
                caption = _caption_image(data) if data else "(image unavailable)"
                lines.append(f"{label}: {caption}")
            listing = (
                "\n\nVisual description of every attached scene image, produced by analysing the images "
                "directly — treat each as ground truth for what is visibly drawn (labels match the references above):\n"
                + "\n".join(lines)
            )
        full = f"{sys_tag}<|user|>\n{prompt}{listing}{schema_hint}<|end|>\n<|assistant|>\n"
        raw = _generate(full, max_tokens=8192)

    data = _extract_json(raw)
    model_name = os.path.basename(LOCAL_STORY_MODEL.rstrip("/"))
    in_tok = len(_S["tokenizer"].encode(full)) if _S.get("tokenizer") else 0
    return {
        "data": data,
        "model": f"{model_name}@local",
        "usage": {"inputTokens": in_tok, "outputTokens": max(1, len(raw) // 4)},
    }


class GenerateJsonRequest(BaseModel):
    system: str = ""
    prompt: str
    json_schema: Optional[dict] = Field(default=None, alias="schema")
    images: list[dict] = []

    class Config:
        populate_by_name = True


@app.post("/generate-json")
def generate_json(req: GenerateJsonRequest):
    try:
        return _local_generate_json(req.system, req.prompt, req.json_schema, req.images)
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    except Exception as e:
        raise HTTPException(500, f"local generation failed: {e}")


_OCR = {"engine": "unloaded", "failed": None}


def _ocr_engine():
    """Lazy-load RapidOCR (ONNX). Downloads small det/rec/cls models on first use."""
    if _OCR["engine"] == "unloaded" and not _OCR["failed"]:
        try:
            from rapidocr_onnxruntime import RapidOCR

            _OCR["engine"] = RapidOCR()
        except Exception as e:
            _OCR["failed"] = str(e)
            _OCR["engine"] = None
    if _OCR["engine"] is None:
        raise RuntimeError(f"OCR unavailable: {_OCR['failed'] or 'rapidocr-onnxruntime not installed'}")
    return _OCR["engine"]


class OcrRequest(BaseModel):
    images: list[str]  # base64-encoded image bytes
    translate_to: Optional[str] = None  # e.g. "hi-roman" → Hindi in Latin script


def _translate_lines(texts: list[str], target: str) -> tuple[list[str], bool]:
    """One cloud call translating the whole OCR batch. Falls back to originals."""
    if not texts or not STORY_LLM_BASE_URL:
        return texts, False
    roman = " written in LATIN script (romanized, e.g. 'aaj kya hua', NOT Devanagari)" if "roman" in target else ""
    lang = "Hindi" if target.startswith("hi") else target
    prompt = (
        f"Translate each manga dialogue line into {lang}{roman}. Keep names and sound-effects readable. "
        f'Return ONLY JSON {{"translations": [...]}} — same order and count as input.\n{_json.dumps(texts, ensure_ascii=False)}'
    )
    try:
        resp = _cloud_chat({"model": STORY_LLM_MODEL, "messages": [{"role": "user", "content": prompt}], "temperature": 0.2, "max_tokens": 2048})
        text = (resp.get("choices") or [{}])[0].get("message", {}).get("content") or ""
        arr = _extract_json(text).get("translations") or []
        out = [str(t) for t in arr]
        if len(out) != len(texts):
            return texts, False
        return out, True
    except Exception:
        return texts, False


@app.post("/ocr")
def ocr(req: OcrRequest):
    """Extract text lines from scene crops — dialogue for story grounding.
    translate_to adds a romanized translation per line via one cloud call."""
    try:
        engine = _ocr_engine()
        import numpy as np
        from PIL import Image

        results = []
        for b64 in req.images:
            img = np.array(Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB"))
            det, _ = engine(img)
            lines = [{"text": t, "confidence": round(float(c), 3)} for _, t, c in (det or [])]
            results.append({"lines": lines})
        translated = False
        if req.translate_to:
            flat = [l["text"] for r in results for l in r["lines"]]
            out, translated = _translate_lines(flat, req.translate_to)
            i = 0
            for r in results:
                for l in r["lines"]:
                    l["translated"] = out[i]
                    i += 1
        return {"results": results, "translated": translated}
    except RuntimeError as e:
        raise HTTPException(503, str(e))
    except Exception as e:
        raise HTTPException(500, f"OCR failed: {e}")


@app.post("/detect-panels")
async def detect_panels(request: Request):
    """Accepts JSON {image: base64, rtl} or raw image bytes (octet-stream)."""
    try:
        ct = request.headers.get("content-type", "")
        if "application/json" in ct:
            body = await request.json()
            img_bytes = base64.b64decode(body.get("image", ""))
            rtl = bool(body.get("rtl"))
        else:
            img_bytes = await request.body()
            rtl = request.query_params.get("rtl") == "true"
        panels = _detect_panels(img_bytes, rtl)
        return {"panels": panels, "count": len(panels)}
    except ImportError:
        raise HTTPException(503, "opencv-python-headless not installed in ai-service")
    except Exception as e:
        raise HTTPException(400, f"panel detection failed: {e}")


# ----------------------------------------------------------------- routes
def _story_model_status() -> str:
    if STORY_LLM_BASE_URL:
        kind = "free-gemini-api proxy" if STORY_LLM_KIND == "freegemini" else "cloud endpoint"
        return f"{kind} {STORY_LLM_BASE_URL} (model {STORY_LLM_MODEL})"
    try:
        import onnxruntime_genai  # noqa: F401
    except ImportError:
        return "onnxruntime-genai not installed — run `npm run ai-service:install`"
    if _S["model"] is not None:
        return "loaded and ready"
    if _S["failed"]:
        return _S["failed"]
    if LOCAL_STORY_MODEL_DIR:
        return "configured dir" if os.path.isdir(LOCAL_STORY_MODEL_DIR) else f"missing dir {LOCAL_STORY_MODEL_DIR}"
    try:
        from huggingface_hub import snapshot_download

        base = snapshot_download(LOCAL_STORY_MODEL, allow_patterns=[f"{LOCAL_STORY_SUBDIR}/*"], local_files_only=True)
        sub = os.path.join(base, LOCAL_STORY_SUBDIR)
        if os.path.exists(os.path.join(sub, "genai_config.json")) or os.path.exists(os.path.join(base, "genai_config.json")):
            return "downloaded — loads on first generation"
    except Exception:
        pass
    return "not downloaded yet — ~4GB pulled from HuggingFace on first story generation"


@app.get("/status")
def status():
    engines = [{"id": e.id, "available": e.available(), "detail": e.detail() if e.available() else "not installed"} for e in ENGINES]
    return {
        "ok": True,
        "engines": engines,
        "voicesDir": PIPER_VOICES_DIR,
        "llm": {"model": STORY_LLM_MODEL if STORY_LLM_BASE_URL else LOCAL_STORY_MODEL, "detail": _story_model_status()},
    }


@app.get("/voices")
def voices():
    out = []
    for e in ENGINES:
        if e.available():
            out.extend(e.voices())
    return {"voices": out}


@app.post("/tts")
def tts(req: SpeakRequest):
    if not req.text.strip():
        raise HTTPException(400, "empty text")
    engine = next((e for e in ENGINES if e.available() and any(v["id"] == req.voice for v in e.voices())), None)
    if not engine:
        raise HTTPException(404, f"voice '{req.voice}' not found — install an engine/voice or check /voices")
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "out.wav")
        try:
            engine.speak(req.text, req.voice, req.language, req.speed, out)
        except Exception as e:  # engine errors are client-visible
            raise HTTPException(502, f"{engine.id} TTS failed: {e}")
        with open(out, "rb") as f:
            data = f.read()
    return Response(content=data, media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("LOCAL_TTS_PORT", "8003")))
