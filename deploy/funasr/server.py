"""Minimal HTTP wrapper around Fun-ASR-Nano-2512 (FunASR AutoModel).

Exposes the same one-shot shape local-agent already uses for Tencent ASR:
    POST /asr  { "audioBase64": "<base64>", "format": "pcm" }  -> { "text": "..." }

The web client sends 16 kHz mono PCM (s16le). We wrap that into a WAV container
and hand the file path to FunASR. wav/mp3/m4a/flac/ogg are passed through as-is.
"""

import base64
import io
import os
import re
import tempfile
import wave

import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel
from funasr import AutoModel

MODEL_ID = os.environ.get("ASR_MODEL", "FunAudioLLM/Fun-ASR-Nano-2512")
DEVICE = os.environ.get("ASR_DEVICE", "cuda:0")
LANGUAGE = os.environ.get("ASR_LANGUAGE", "中文")  # "中文" | "auto" | "英文" ...
PORT = int(os.environ.get("ASR_PORT", "7346"))
# If you hit "FunASRNano is not registered", point this at the cloned repo's
# model.py, e.g. ASR_REMOTE_CODE=/opt/Fun-ASR/model.py
REMOTE_CODE = os.environ.get("ASR_REMOTE_CODE")

_kwargs = dict(model=MODEL_ID, trust_remote_code=True, hub="hf", device=DEVICE)
if REMOTE_CODE:
    _kwargs["remote_code"] = REMOTE_CODE

print(f"[asr] loading {MODEL_ID} on {DEVICE} (downloads weights on first run)...", flush=True)
model = AutoModel(**_kwargs)
print("[asr] model ready", flush=True)

app = FastAPI()
_TAG = re.compile(r"<\|[^|]*\|>")  # strip SenseVoice-style rich tags if present


class AsrReq(BaseModel):
    audioBase64: str
    format: str | None = "pcm"


def _pcm_to_wav(pcm: bytes, rate: int = 16000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)  # s16le
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_ID, "device": DEVICE}


@app.post("/asr")
def asr(req: AsrReq):
    raw = base64.b64decode(req.audioBase64)
    fmt = (req.format or "pcm").lower()
    if fmt in ("wav", "mp3", "m4a", "flac", "ogg"):
        data, suffix = raw, "." + fmt
    else:  # pcm (web default) or unknown -> treat as 16k mono s16le
        data, suffix = _pcm_to_wav(raw), ".wav"

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(data)
        path = f.name
    try:
        res = model.generate(
            input=[path],
            cache={},
            batch_size=1,
            language=LANGUAGE,
            itn=True,
        )
        text = (res[0].get("text") if res else "") or ""
        return {"text": _TAG.sub("", text).strip()}
    except Exception as e:  # noqa: BLE001 — surface as JSON to the caller
        return {"error": "asr_failed", "message": str(e)}
    finally:
        os.unlink(path)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT)
