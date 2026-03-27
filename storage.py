"""
CCTV Local Service — Session/download storage & cleanup
"""
import os
import shutil
import time
import threading
from config import STREAMS_DIR, SESSION_TTL_SECONDS


def ensure_dirs():
    os.makedirs(STREAMS_DIR, exist_ok=True)


def get_session_dir(session_key: str) -> str:
    safe = "".join(c for c in session_key if c.isalnum() or c in "_-")
    return os.path.join(STREAMS_DIR, safe)


def create_session_dir(session_key: str) -> str:
    path = get_session_dir(session_key)
    os.makedirs(path, exist_ok=True)
    return path


def remove_session_dir(session_key: str):
    path = get_session_dir(session_key)
    if os.path.isdir(path):
        shutil.rmtree(path, ignore_errors=True)


def _cleanup_old_dirs(base_dir: str, ttl_seconds: int):
    """Remove directories older than ttl_seconds."""
    if not os.path.isdir(base_dir):
        return
    now = time.time()
    for name in os.listdir(base_dir):
        full = os.path.join(base_dir, name)
        if not os.path.isdir(full):
            continue
        try:
            mtime = os.path.getmtime(full)
            if now - mtime > ttl_seconds:
                shutil.rmtree(full, ignore_errors=True)
        except Exception:
            pass


def cleanup_expired():
    """Remove expired sessions."""
    _cleanup_old_dirs(STREAMS_DIR, SESSION_TTL_SECONDS)


_cleanup_timer = None


def start_periodic_cleanup(interval_seconds: int = 300):
    """Start a background thread that cleans up every N seconds."""
    global _cleanup_timer

    def _run():
        global _cleanup_timer
        cleanup_expired()
        _cleanup_timer = threading.Timer(interval_seconds, _run)
        _cleanup_timer.daemon = True
        _cleanup_timer.start()

    _run()


def stop_periodic_cleanup():
    global _cleanup_timer
    if _cleanup_timer:
        _cleanup_timer.cancel()
        _cleanup_timer = None
