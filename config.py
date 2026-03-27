"""
CCTV Local Service — Configuration
"""
import os

APP_DIR = os.path.dirname(os.path.abspath(__file__))

# FFmpeg binary
FFMPEG_PATH = os.path.join(APP_DIR, "ffmpeg", "ffmpeg.exe")
if not os.path.isfile(FFMPEG_PATH):
    FFMPEG_PATH = os.path.join(APP_DIR, "ffmpeg.exe")

# Server
HOST = os.getenv("CCTV_HOST", "127.0.0.1")
PORT = int(os.getenv("CCTV_PORT", "9000"))

# Directories
STREAMS_DIR = os.path.join(APP_DIR, "streams")

# Limits
MAX_CONCURRENT_STREAMS = int(os.getenv("CCTV_MAX_STREAMS", "2"))

# HLS settings
HLS_SEGMENT_SECONDS = 1
HLS_LIST_SIZE = 0  # 0 = keep all segments (enables full timeline seek)

# Cleanup
SESSION_TTL_SECONDS = 30 * 60  # 30 min

# CORS origins
CORS_ORIGINS = [
    "http://localhost:3000",
    "http://localhost:5000",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5000",
    "https://fraud-cjexpress.vercel.app",
]
