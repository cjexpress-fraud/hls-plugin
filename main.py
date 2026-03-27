"""
CCTV Local Service — FastAPI application
Converts RTSP streams to HLS for browser playback and handles MP4 downloads.
"""
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

from config import HOST, PORT, CORS_ORIGINS, STREAMS_DIR
from models import (
    PlaybackStartRequest, PlaybackStartResponse,
    PlaybackSeekRequest, PlaybackSeekResponse,
    PlaybackStopRequest, PlaybackStopResponse,
    DownloadPrepareRequest, DownloadPrepareResponse,
    HealthResponse, ErrorResponse,
)
from storage import ensure_dirs, cleanup_expired, start_periodic_cleanup, stop_periodic_cleanup
import ffmpeg


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown lifecycle."""
    ensure_dirs()
    cleanup_expired()
    start_periodic_cleanup(300)
    yield
    # Shutdown
    stop_periodic_cleanup()
    ffmpeg.kill_all()
    cleanup_expired()


app = FastAPI(title="CCTV Local Service", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)


# ─── HLS static files ──────────────────────────────────────────

ensure_dirs()  # ensure streams dir exists at import time for mount
app.mount("/streams", StaticFiles(directory=STREAMS_DIR), name="streams")


# ─── Playback endpoints ────────────────────────────────────────

@app.post("/playback/start", response_model=PlaybackStartResponse)
async def playback_start(req: PlaybackStartRequest):
    try:
        hls_path = ffmpeg.start_stream(req.sessionKey, req.rtspUrl)
        hls_url = f"http://{HOST}:{PORT}{hls_path}"
        return PlaybackStartResponse(sessionKey=req.sessionKey, hlsUrl=hls_url)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/playback/seek", response_model=PlaybackSeekResponse)
async def playback_seek(req: PlaybackSeekRequest):
    try:
        ffmpeg.stop_stream(req.sessionKey)
        hls_path = ffmpeg.start_stream(req.sessionKey, req.rtspUrl, req.offsetSeconds)
        hls_url = f"http://{HOST}:{PORT}{hls_path}"
        return PlaybackSeekResponse(sessionKey=req.sessionKey, hlsUrl=hls_url)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/playback/stop", response_model=PlaybackStopResponse)
async def playback_stop(req: PlaybackStopRequest):
    ffmpeg.stop_stream(req.sessionKey)
    return PlaybackStopResponse()


# ─── Streaming download (direct to browser) ────────────────────

@app.post("/download/prepare", response_model=DownloadPrepareResponse)
async def download_prepare(req: DownloadPrepareRequest):
    """Register streaming download token. Returns token + stream URL."""
    try:
        token = ffmpeg.prepare_stream_download(req.rtspUrl, req.filename or "CCTV.mp4")
        stream_url = f"http://{HOST}:{PORT}/download/stream/{token}"
        return DownloadPrepareResponse(token=token, streamUrl=stream_url)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))


@app.get("/download/stream/{token}")
async def download_stream(token: str):
    """Stream ffmpeg MP4 directly to browser (one-time use token)."""
    info = ffmpeg.consume_stream_token(token)
    if not info:
        raise HTTPException(status_code=404, detail="Token expired or invalid")

    filename = info.get("filename", "CCTV.mp4")
    # RFC 5987 for non-ASCII filenames
    safe_ascii = filename.encode("ascii", errors="ignore").decode()
    headers = {
        "Content-Disposition": f"attachment; filename=\"{safe_ascii}\"; filename*=UTF-8''{filename}",
    }
    return StreamingResponse(
        ffmpeg.stream_download_generator(info["rtspUrl"]),
        media_type="video/mp4",
        headers=headers,
    )


# ─── Health ─────────────────────────────────────────────────────

@app.get("/health", response_model=HealthResponse)
async def health():
    return HealthResponse(
        activeStreams=ffmpeg.active_stream_count(),
    )


# ─── Entry point ────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=HOST, port=PORT, log_level="info")
