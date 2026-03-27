"""
HLS Plugin — System Tray Launcher
Runs the CCTV Local Service (FastAPI) in the background with a system tray icon.
Use pythonw.exe to run this file (no console window).
"""
import os
import sys
import threading

# pythonw.exe has no console — sys.stdout/stderr are None → print() crashes.
# Redirect to devnull so print() and logging work silently.
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")

# Ensure the app directory is on sys.path so imports work
APP_DIR = os.path.dirname(os.path.abspath(__file__))
os.chdir(APP_DIR)
if APP_DIR not in sys.path:
    sys.path.insert(0, APP_DIR)

import pystray
from PIL import Image

from config import HOST, PORT

# ─── Single-instance lock via port probe ────────────────────────
import socket

def _is_already_running():
    """Check if another instance is already listening on HOST:PORT."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.settimeout(1)
        s.connect((HOST, PORT))
        s.close()
        return True
    except (ConnectionRefusedError, OSError):
        return False


def run_server():
    """Run uvicorn in a background thread."""
    import uvicorn
    uvicorn.run("main:app", host=HOST, port=PORT, log_level="warning")


def on_quit(icon, item):
    """Stop tray icon and exit."""
    icon.stop()
    os._exit(0)


def main():
    # Start the FastAPI server in a daemon thread
    server_thread = threading.Thread(target=run_server, daemon=True)
    server_thread.start()

    # Load tray icon
    icon_path = os.path.join(APP_DIR, "hls.ico")
    image = Image.open(icon_path)

    # Build tray menu
    menu = pystray.Menu(
        pystray.MenuItem(f"HLS Running...", None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Exit", on_quit),
    )

    icon = pystray.Icon("hls-plugin", image, "HLS Plugin", menu)
    icon.run()


if __name__ == "__main__":
    if _is_already_running():
        # Another instance is already running — exit silently
        sys.exit(0)
    main()
