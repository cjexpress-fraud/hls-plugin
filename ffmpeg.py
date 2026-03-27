"""
CCTV Local Service — FFmpeg process manager
Spawns/kills ffmpeg processes for HLS streaming and MP4 streaming download.
"""
import os
import re
import subprocess
import threading
import time
import uuid
from datetime import datetime
from typing import Optional, Generator

from config import (
    FFMPEG_PATH, HLS_SEGMENT_SECONDS, HLS_LIST_SIZE,
    MAX_CONCURRENT_STREAMS,
)
from storage import (
    create_session_dir, remove_session_dir, get_session_dir,
)


_CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


class StreamSession:
    __slots__ = ("session_key", "process", "hls_dir", "created_at")

    def __init__(self, session_key: str, process: subprocess.Popen, hls_dir: str):
        self.session_key = session_key
        self.process = process
        self.hls_dir = hls_dir
        self.created_at = time.time()


# ─── process registry ───────────────────────────────────────────

_streams: dict[str, StreamSession] = {}
_lock = threading.Lock()


def _mask_credentials(url: str) -> str:
    """Replace user:pass in RTSP URL for safe logging."""
    return re.sub(r'(rtsp://)[^@]+@', r'\1***:***@', url)


def _validate_ffmpeg():
    if not os.path.isfile(FFMPEG_PATH):
        raise FileNotFoundError(f"ffmpeg not found at {FFMPEG_PATH}")


def _friendly_error(stderr_text: str) -> str:
    """Parse ffmpeg stderr and return a short, user-friendly Thai error message."""
    s = (stderr_text or '').lower()
    if '401' in s or 'unauthorized' in s or 'authorization failed' in s:
        return 'กล้องปฏิเสธ Username/Password — กรุณาตรวจสอบค่า CCTV ใหม่'
    if '403' in s or 'forbidden' in s:
        return 'กล้องปฏิเสธการเข้าถึง (Forbidden) — ตรวจสอบสิทธิ์ user'
    if 'connection refused' in s:
        return 'เชื่อมต่อกล้องไม่ได้ — ตรวจสอบ IP/Port ว่าถูกต้องและกล้องเปิดอยู่'
    if 'connection timed out' in s or 'timed out' in s:
        return 'เชื่อมต่อกล้องไม่ได้ (หมดเวลา) — กล้องอาจปิดอยู่หรือเครือข่ายมีปัญหา'
    if 'no route to host' in s or 'network is unreachable' in s:
        return 'เข้าถึงกล้องไม่ได้ — ตรวจสอบเครือข่าย VPN หรือ IP ของกล้อง'
    if 'name or service not known' in s or 'could not resolve' in s:
        return 'หา IP กล้องไม่เจอ — ตรวจสอบชื่อ host ว่าถูกต้อง'
    if 'invalid data found' in s or 'invalid argument' in s:
        return 'ข้อมูลจากกล้องผิดรูปแบบ — ลองเปลี่ยน channel หรือตรวจรุ่นกล้อง'
    if 'does not contain any stream' in s or 'no such stream' in s:
        return 'ไม่พบ stream ในกล้อง — ตรวจสอบ channel ว่าถูกต้อง'
    if 'server returned 4' in s:
        return 'กล้องปฏิเสธคำขอ — ตรวจสอบ Username/Password และสิทธิ์การเข้าถึง'
    if 'server returned 5' in s:
        return 'กล้องมีข้อผิดพลาดภายใน — ลองใหม่อีกครั้งหรือรีสตาร์ทกล้อง'
    if 'end of file' in s or 'eof' in s:
        return 'ไม่พบ VDO ในช่วงเวลาที่เลือก — กล้องอาจไม่ได้บันทึกไว้'
    return 'ไม่พบ VDO ในช่วงเวลาที่เลือก'


# ─── HLS stream ─────────────────────────────────────────────────

def _redact_url(url: str) -> str:
    """Hide credentials in RTSP URL for logging."""
    return re.sub(r'://[^@]+@', '://*****@', url)

def start_stream(session_key: str, rtsp_url: str, offset_seconds: float = 0) -> str:
    """Start ffmpeg RTSP→HLS and return the HLS URL path."""
    print(f"[ffmpeg] start_stream session={session_key} url={_redact_url(rtsp_url)}")
    _validate_ffmpeg()

    with _lock:
        if session_key in _streams:
            _kill_session_unlocked(session_key)
        if len(_streams) >= MAX_CONCURRENT_STREAMS:
            raise RuntimeError(f"เกิน stream limit ({MAX_CONCURRENT_STREAMS})")

    hls_dir = create_session_dir(session_key)
    m3u8_path = os.path.join(hls_dir, "stream.m3u8")
    seg_pattern = os.path.join(hls_dir, "seg_%06d.ts")

    args = [FFMPEG_PATH, "-y"]

    # RTSP transport
    args += ["-rtsp_transport", "tcp"]

    # Seek offset
    if offset_seconds > 0:
        args += ["-ss", str(int(offset_seconds))]

    # Low-latency flags
    args += ["-fflags", "+genpts+discardcorrupt", "-flags", "low_delay"]

    args += ["-i", rtsp_url]

    # Output: HLS re-encode to 16:9 — event mode keeps all segments for seekable timeline
    args += [
        "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-an",
        "-f", "hls",
        "-hls_time", str(HLS_SEGMENT_SECONDS),
        "-hls_list_size", str(HLS_LIST_SIZE),
        "-hls_flags", "append_list+independent_segments",
        "-hls_playlist_type", "event",
        "-hls_segment_filename", seg_pattern,
        m3u8_path,
    ]

    proc = subprocess.Popen(
        args,
        cwd=hls_dir,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        creationflags=_CREATE_NO_WINDOW,
    )

    # Read stderr in background thread to prevent pipe buffer deadlock
    stderr_chunks = []
    def _drain_stderr():
        try:
            for line in proc.stderr:
                stderr_chunks.append(line)
        except Exception:
            pass
    stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
    stderr_thread.start()

    session = StreamSession(session_key, proc, hls_dir)
    with _lock:
        _streams[session_key] = session

    # Wait for m3u8 to appear (max 20s — NVR historical playback + HEVC decode can be slow)
    deadline = time.time() + 20.0
    while time.time() < deadline:
        if proc.poll() is not None:
            stderr_thread.join(timeout=2)
            stderr_out = b"".join(stderr_chunks).decode(errors="replace").strip()
            print(f"[ffmpeg] EXITED for {session_key} — stderr:\n{stderr_out[-2000:] if stderr_out else '(empty)'}")
            with _lock:
                _streams.pop(session_key, None)
            remove_session_dir(session_key)
            raise RuntimeError(_friendly_error(stderr_out))
        try:
            if os.path.isfile(m3u8_path) and os.path.getsize(m3u8_path) > 0:
                return f"/streams/{session_key}/stream.m3u8"
        except Exception:
            pass
        time.sleep(0.2)

    # Timeout — kill
    stderr_thread.join(timeout=1)
    timeout_stderr = b"".join(stderr_chunks).decode(errors="replace").strip()
    print(f"[ffmpeg] TIMEOUT for {session_key} — stderr:\n{timeout_stderr[-2000:] if timeout_stderr else '(empty)'}")
    stop_stream(session_key)
    raise RuntimeError(_friendly_error(timeout_stderr) if timeout_stderr else "กล้องไม่ตอบสนองภายในเวลาที่กำหนด — กล้องอาจปิดอยู่หรือไม่มี VDO ในช่วงเวลานี้")


def stop_stream(session_key: str):
    """Kill stream and clean up."""
    with _lock:
        _kill_session_unlocked(session_key)
    remove_session_dir(session_key)


def _kill_session_unlocked(session_key: str):
    session = _streams.pop(session_key, None)
    if session and session.process:
        try:
            session.process.terminate()
            session.process.wait(timeout=3)
        except Exception:
            try:
                session.process.kill()
            except Exception:
                pass


# ─── cleanup ─────────────────────────────────────────────────────

def active_stream_count() -> int:
    with _lock:
        return len(_streams)


def kill_all():
    """Kill all ffmpeg processes (for shutdown)."""
    with _lock:
        for key in list(_streams.keys()):
            _kill_session_unlocked(key)


# ─── Streaming download (direct to browser) ─────────────────────

_stream_tokens: dict = {}  # token -> { rtspUrl, filename, created }
_TOKEN_TTL = 120  # 2 minutes


def prepare_stream_download(rtsp_url: str, filename: str) -> str:
    """Register a streaming download token. Returns token."""
    _validate_ffmpeg()
    token = uuid.uuid4().hex[:16]
    _stream_tokens[token] = {
        "rtspUrl": rtsp_url,
        "filename": filename,
        "created": time.time(),
    }
    # Cleanup old tokens
    now = time.time()
    expired = [k for k, v in _stream_tokens.items() if now - v["created"] > _TOKEN_TTL]
    for k in expired:
        _stream_tokens.pop(k, None)
    return token


def consume_stream_token(token: str) -> Optional[dict]:
    """Pop and return token data (one-time use)."""
    return _stream_tokens.pop(token, None)


def stream_download_generator(rtsp_url: str) -> Generator[bytes, None, None]:
    """Spawn ffmpeg and yield MP4 chunks directly (fragmented MP4 for streaming)."""
    args = [
        FFMPEG_PATH, "-y",
        "-rtsp_transport", "tcp",
        "-i", rtsp_url,
        "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-an",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        "-f", "mp4",
        "pipe:1",
    ]
    proc = subprocess.Popen(
        args,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        creationflags=_CREATE_NO_WINDOW,
    )
    try:
        while True:
            chunk = proc.stdout.read(64 * 1024)  # 64KB chunks
            if not chunk:
                break
            yield chunk
    finally:
        if proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
