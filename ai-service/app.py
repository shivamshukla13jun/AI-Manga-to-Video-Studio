"""
Local TTS inference service for AI Manga-to-Video Studio.

Optional component: the main app works without it — the backend marks the
'local' provider unavailable when this service is not reachable.

Engines (all optional; whichever is installed is used):
  - piper   : CLI `piper` binary or `piper-tts` python package + .onnx voices
  - kokoro  : `kokoro` python package (82M model, downloads on first use)
  - xtts    : `TTS` (coqui) package with XTTS-v2 (GPU recommended)

Endpoints:
  GET  /status   -> { engines: [{id, available, detail}] }
  GET  /voices   -> { voices: [{id, name, engine, languages, gender}] }
  POST /tts      -> {text, voice, language, speed} -> audio/wav

Run:  pip install -r requirements.txt && uvicorn app:app --port 8001
"""
import io
import os
import shutil
import subprocess
import tempfile
import wave
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

PIPER_VOICES_DIR = os.environ.get("PIPER_VOICES_DIR", os.path.join(os.path.dirname(__file__), "voices"))
DEFAULT_XTTS_REFERENCE = os.environ.get("XTTS_REFERENCE_WAV", "")

app = FastAPI(title="Studio Local TTS", version="0.1.0")


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


# ----------------------------------------------------------------- routes
@app.get("/status")
def status():
    engines = [{"id": e.id, "available": e.available(), "detail": e.detail() if e.available() else "not installed"} for e in ENGINES]
    return {"ok": True, "engines": engines, "voicesDir": PIPER_VOICES_DIR}


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

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("LOCAL_TTS_PORT", "8001")))
