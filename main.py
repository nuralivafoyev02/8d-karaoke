"""
8D Karaoke — backend.

- YouTube havoladan audio yuklab oladi (yt-dlp) yoki yuklangan faylni qabul qiladi
- faster-whisper bilan so'z-darajali vaqt belgilari bilan lirika tahlil qiladi
- Audioni va lirikani frontendga xizmat qiladi (frontend Web Audio API bilan
  jonli 8D effektini qo'llaydi va karaoke ko'rinishida ko'rsatadi)
"""
from __future__ import annotations

import json
import mimetypes
import os
import shutil
import threading
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

try:
    import yt_dlp  # type: ignore
except ImportError:  # pragma: no cover
    yt_dlp = None

try:
    from faster_whisper import WhisperModel  # type: ignore
except ImportError:  # pragma: no cover
    WhisperModel = None

# ---------------------------------------------------------------- config ----
DATA_DIR = Path(os.environ.get("DATA_DIR", "data"))
AUDIO_DIR = DATA_DIR / "audio"
JOBS_FILE = DATA_DIR / "jobs.json"
FRONTEND_DIR = Path(os.environ.get("FRONTEND_DIR", "frontend"))

MODEL_NAME = os.environ.get("WHISPER_MODEL", "base")
WHISPER_DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "100"))
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024
JOB_TTL_HOURS = float(os.environ.get("JOB_TTL_HOURS", "48"))

AUDIO_EXTS = {
    ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus",
    ".flac", ".webm", ".mp4", ".m4b", ".aiff", ".aif",
}

AUDIO_DIR.mkdir(parents=True, exist_ok=True)

# ------------------------------------------------------------- job storage --
_lock = threading.Lock()
_jobs: dict[str, dict] = {}


def _load_jobs() -> None:
    global _jobs
    if JOBS_FILE.exists():
        try:
            _jobs = json.loads(JOBS_FILE.read_text("utf-8"))
        except (json.JSONDecodeError, OSError):
            _jobs = {}


def _save_jobs() -> None:
    JOBS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = JOBS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(_jobs, ensure_ascii=False, indent=2), "utf-8")
    tmp.replace(JOBS_FILE)


def get_job(job_id: str) -> dict | None:
    with _lock:
        return _jobs.get(job_id)


def update_job(job_id: str, **fields) -> None:
    with _lock:
        job = _jobs.get(job_id)
        if job is None:
            return
        job.update(fields)
        job["updated_at"] = time.time()
        _save_jobs()


def create_job(title: str, source: str, audio_name: str | None = None) -> str:
    job_id = uuid.uuid4().hex[:12]
    job = {
        "id": job_id,
        "title": title,
        "source": source,
        "status": "processing",  # processing | ready | error
        "audio": audio_name or "pending",
        "words": [],
        "language": None,
        "duration": None,
        "error": None,
        "created_at": time.time(),
        "updated_at": time.time(),
    }
    with _lock:
        _jobs[job_id] = job
        _save_jobs()
    return job_id


def _prune_old_jobs() -> None:
    """Eski job va fayllarni tozalaydi (xotirani tejash uchun)."""
    cutoff = time.time() - JOB_TTL_HOURS * 3600
    stale = [j for j in _jobs.values() if j.get("created_at", 0) < cutoff]
    with _lock:
        for job in stale:
            _jobs.pop(job["id"], None)
            (AUDIO_DIR / job["audio"]).unlink(missing_ok=True)
        if stale:
            _save_jobs()


# ------------------------------------------------------------- transcription --
_model: WhisperModel | None = None
_model_lock = threading.Lock()


def get_model() -> WhisperModel:
    global _model
    if WhisperModel is None:
        raise RuntimeError("faster-whisper o'rnatilmagan — `pip install faster-whisper`")
    if _model is None:
        with _model_lock:
            if _model is None:
                _model = WhisperModel(
                    MODEL_NAME, device=WHISPER_DEVICE, compute_type=WHISPER_COMPUTE
                )
    return _model


def transcribe_to_words(audio_path: Path) -> tuple[list[dict], str | None, float | None]:
    """Audioni tahlil qilib so'z-darajali vaqt belgilarini qaytaradi."""
    model = get_model()
    segments, info = model.transcribe(
        str(audio_path),
        word_timestamps=True,
        vad_filter=True,
        beam_size=5,
    )
    words: list[dict] = []
    for seg in segments:
        for w in seg.words:
            text = (w.word or "").strip()
            if text:
                words.append({"start": round(w.start, 3), "end": round(w.end, 3), "text": text})
    return words, info.language, info.duration


def process_job(job_id: str) -> None:
    job = get_job(job_id)
    if not job or job["audio"] == "pending":
        update_job(job_id, status="error", error="Audio fayl topilmadi")
        return
    audio_path = AUDIO_DIR / job["audio"]
    try:
        words, lang, duration = transcribe_to_words(audio_path)
        update_job(job_id, status="ready", words=words, language=lang, duration=duration)
    except Exception as exc:  # noqa: BLE001
        update_job(job_id, status="error", error=f"Tahlil xatosi: {exc}")


# ------------------------------------------------------------- yt-dlp -------
def _yt_opts(dest: Path) -> dict:
    """yt-dlp sozlamalari: bir nechta player client + ixtiyoriy cookies."""
    opts: dict = {
        "format": "bestaudio/best",
        "outtmpl": str(dest.with_suffix("")) + ".%(ext)s",
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "noprogress": True,
        "socket_timeout": 30,
        "retries": 3,
        # YouTube 403 xatosiga qarshi: clientlar navbatma-navbat sinab ko'riladi.
        # "android"/"ios"/"tv" clientlari ko'pincha bot-blokirovkadan o'tadi.
        "extractor_args": {
            "youtube": {
                "player_client": [
                    "android", "ios", "tv", "web_safari", "web_embedded", "web",
                ]
            }
        },
    }
    # ffmpeg bo'lsa — universal m4a (AAC) ga aylantiramiz (barcha brauzerlar o'qiydi)
    if shutil.which("ffmpeg"):
        opts["postprocessors"] = [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "m4a",
            "preferredquality": "192",
        }]

    # 403 xatosini hal qilish: brauzer cookies fayli (Netscape formatdagi cookies.txt)
    cookies_file = os.environ.get("YT_COOKIES_FILE", "").strip()
    if cookies_file and Path(cookies_file).exists():
        opts["cookiefile"] = cookies_file

    # Yoki brauzerdan to'g'ridan-to'g'ri cookies olish (lokal ishga tushirishda)
    browser = os.environ.get("YT_BROWSER", "").strip().lower()
    if browser:
        opts["cookiesfrombrowser"] = (browser,)

    return opts


def download_youtube_audio(url: str, dest: Path) -> tuple[Path, str]:
    """YouTube havoladan audioni yuklab oladi; (fayl_yoli, sarlavha) qaytaradi."""
    if yt_dlp is None:
        raise HTTPException(500, "yt-dlp o'rnatilmagan — `pip install yt-dlp`")

    with yt_dlp.YoutubeDL(_yt_opts(dest)) as ydl:
        try:
            info = ydl.extract_info(url, download=True)
        except Exception as exc:  # noqa: BLE001
            msg = str(exc)
            if "403" in msg:
                msg += (
                    " — YouTube so'rovni blokladi. Yechimlar: "
                    "1) `pip install -U yt-dlp` bilan yangilang; "
                    "2) YT_COOKIES_FILE orqali cookies.txt bering "
                    "(brauzerda 'Get cookies.txt LOCALLY' kengaytmasi bilan olinadi); "
                    "3) YT_BROWSER=chrome (yoki firefox/safari) sozlang."
                )
            raise HTTPException(400, f"YouTube'dan yuklab bo'lmadi: {msg}") from exc

    candidates = sorted(dest.parent.glob(dest.stem + ".*"))
    for c in candidates:
        if c.suffix == ".m4a":
            return c, str(info.get("title") or "YouTube audio")
    if candidates:
        return candidates[0], str(info.get("title") or "YouTube audio")
    raise HTTPException(400, "Audio fayl topilmadi")


# ------------------------------------------------------------------- app -----
app = FastAPI(title="8D Karaoke", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup() -> None:
    _load_jobs()
    # Qayta ishga tushirishdan keyin tugallanmagan joblarni xato deb belgilaymiz
    for job in list(_jobs.values()):
        if job.get("status") == "processing":
            job["status"] = "error"
            job["error"] = "Server qayta ishga tushirildi — qaytadan urinib ko'ring"
    _save_jobs()
    _prune_old_jobs()


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "model": MODEL_NAME, "ffmpeg": bool(shutil.which("ffmpeg"))}


class YouTubeRequest(BaseModel):
    url: str


@app.post("/api/youtube")
def youtube_endpoint(req: YouTubeRequest) -> dict:
    url = req.url.strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "Havola noto'g'ri formatda")
    job_id = create_job("YouTube audio", "youtube")

    def work() -> None:
        try:
            dest = AUDIO_DIR / job_id
            audio_path, title = download_youtube_audio(url, dest)
            update_job(job_id, title=title, audio=audio_path.name)
            process_job(job_id)
        except HTTPException as exc:
            update_job(job_id, status="error", error=str(exc.detail))
        except Exception as exc:  # noqa: BLE001
            update_job(job_id, status="error", error=f"Xatolik: {exc}")

    threading.Thread(target=work, daemon=True).start()
    return get_job(job_id) or {}


@app.post("/api/upload")
async def upload_endpoint(file: UploadFile = File(...)) -> dict:
    filename = file.filename or "audio.mp3"
    ext = Path(filename).suffix.lower()
    if ext not in AUDIO_EXTS:
        raise HTTPException(400, f"Qo'llab-quvvatlanmaydigan format: '{ext}'")

    job_id = create_job(Path(filename).stem, "upload")
    dest = AUDIO_DIR / f"{job_id}{ext}"

    size = 0
    try:
        with dest.open("wb") as out:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, f"Fayl juda katta (maks {MAX_UPLOAD_MB} MB)")
                out.write(chunk)
    except HTTPException:
        dest.unlink(missing_ok=True)
        with _lock:
            _jobs.pop(job_id, None)
        _save_jobs()
        raise

    update_job(job_id, audio=dest.name)
    threading.Thread(target=process_job, args=(job_id,), daemon=True).start()
    return get_job(job_id) or {}


@app.get("/api/jobs/{job_id}")
def job_endpoint(job_id: str) -> dict:
    job = get_job(job_id)
    if not job:
        raise HTTPException(404, "Job topilmadi")
    return job


@app.get("/api/audio/{job_id}")
def audio_endpoint(job_id: str) -> FileResponse:
    job = get_job(job_id)
    if not job or job["audio"] == "pending":
        raise HTTPException(404, "Audio topilmadi")
    path = AUDIO_DIR / job["audio"]
    if not path.exists():
        raise HTTPException(404, "Audio fayl yo'q")
    media = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return FileResponse(path, media_type=media)


# Frontend static fayllar (API yo'llari yuqorida ro'yxatdan o'tgan — ular ustun)
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
