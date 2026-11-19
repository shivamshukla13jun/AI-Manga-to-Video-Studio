# Optional local AI service for AI Manga-to-Video Studio.
# Provides OpenCV panel detection (/detect-panels, always available),
# a local vision-language story model (/generate-json — Phi-3.5-vision ONNX
# auto-downloads ~4GB on first use; or mount it and set LOCAL_STORY_MODEL_DIR),
# and optional local TTS engines — install engines at build time by
# uncommenting the optional lines in requirements.txt, or mount ./voices
# with Piper .onnx models.
FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .

EXPOSE 8003
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8003/status')" || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8003"]
