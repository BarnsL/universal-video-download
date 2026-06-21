#!/usr/bin/env python3
"""uvd-helper: localhost daemon for Universal Video Download.

Receives download requests from the Tampermonkey userscript and runs
yt-dlp on the user's behalf. Talks HTTP+JSON over 127.0.0.1 only.

Auth model:
  - Random 64-hex-char token generated on first run, stored in config.json.
  - Every authed request must send `X-UVD-Token: <token>`.
  - Token check is constant-time (`secrets.compare_digest`).
  - Origin header must match a whitelist (the same supported sites the
    userscript declares). Browsers send Origin automatically on fetch().
  - Server binds 127.0.0.1 ONLY; other machines can't reach it.

Setup paths (per OS):
  Windows: %LOCALAPPDATA%\\uvd-helper\\config.json
  macOS:   ~/Library/Application Support/uvd-helper/config.json
  Linux:   $XDG_CONFIG_HOME/uvd-helper/config.json (or ~/.config/uvd-helper/)

Dependencies: stdlib only. Requires yt-dlp + ffmpeg on PATH.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import subprocess
import sys
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

VERSION = "1.0.0"
DEFAULT_PORT = 34899
MAX_LOG_LINES = 400
MAX_JOBS_KEPT = 50

# Mirrors the @match-supported sites from the userscript, plus localhost
# (so the userscript dev page can hit the helper during testing).
ALLOWED_ORIGIN_RE = re.compile(
    r"^https?://("
    r"(www\.|m\.|music\.)?youtube\.com|youtu\.be|"
    r"(www\.|player\.)?vimeo\.com|"
    r"(www\.)?dailymotion\.com|"
    r"(www\.|clips\.|m\.)?twitch\.tv|"
    r"(www\.|mobile\.)?twitter\.com|x\.com|"
    r"(www\.|old\.|new\.)?reddit\.com|redd\.it|"
    r"(www\.|m\.)?facebook\.com|fb\.watch|"
    r"(www\.)?instagram\.com|"
    r"(www\.|vm\.)?tiktok\.com|"
    r"localhost(:\d+)?|127\.0\.0\.1(:\d+)?"
    r")$"
)


def config_dir() -> Path:
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return base / "uvd-helper"


def pick_writable_download_dir() -> str:
    """Find the first writable candidate for the default download dir.

    On Windows, Path.home() / "Downloads" is often a Junction redirected
    to a moved drive; if the target is gone the join fails with
    `WinError 3 (path not found)` even though the junction itself reports
    is_dir()=True via `Get-Item`. The walk-and-test loop here picks the
    first candidate whose `makedirs` actually succeeds, so the helper
    never gets stuck pointing at a phantom path.
    """
    candidates = [
        Path.home() / "Downloads" / "uvd",
        Path.home() / "Videos" / "uvd",
        Path.home() / "uvd-downloads",
    ]
    for c in candidates:
        try:
            os.makedirs(str(c), exist_ok=True)
            if c.is_dir():
                return str(c)
        except OSError:
            continue
    # Truly nothing writable in the home tree — fall back to the temp
    # dir, which always exists. Worth surfacing in /health so the UI can
    # flag it.
    import tempfile
    fallback = Path(tempfile.gettempdir()) / "uvd"
    os.makedirs(str(fallback), exist_ok=True)
    return str(fallback)


def load_or_init_config() -> dict:
    cfg_dir = config_dir()
    cfg_dir.mkdir(parents=True, exist_ok=True)
    cfg_file = cfg_dir / "config.json"
    if cfg_file.exists():
        try:
            cfg = json.loads(cfg_file.read_text(encoding="utf-8"))
            # Backfill missing keys when older configs exist.
            cfg.setdefault("token", secrets.token_hex(32))
            cfg.setdefault("port", DEFAULT_PORT)
            # If a previous config recorded a path that no longer works
            # (e.g. broken Downloads junction), re-pick. Don't trash a
            # user-edited valid path.
            existing = cfg.get("downloadDir")
            if not existing:
                cfg["downloadDir"] = pick_writable_download_dir()
            else:
                try:
                    os.makedirs(existing, exist_ok=True)
                    if not Path(existing).is_dir():
                        cfg["downloadDir"] = pick_writable_download_dir()
                except OSError:
                    cfg["downloadDir"] = pick_writable_download_dir()
            cfg_file.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
            return cfg
        except Exception as e:
            print(f"warn: config unreadable ({e}); regenerating", file=sys.stderr)
    cfg = {
        "token": secrets.token_hex(32),
        "port": DEFAULT_PORT,
        "downloadDir": pick_writable_download_dir(),
    }
    cfg_file.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    # Lock down on POSIX so other users can't read the token.
    try:
        if sys.platform != "win32":
            os.chmod(cfg_file, 0o600)
    except OSError:
        pass
    return cfg


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


# yt-dlp --newline emits lines like:
#   [download]   23.4% of  100.00MiB at  5.00MiB/s ETA 00:15
#   [download]   23.4% of ~100.00MiB at  Unknown B/s ETA Unknown
PROGRESS_RE = re.compile(
    r"\[download\]\s+([\d.]+)%"
    r"(?:\s+of\s+~?([\d.]+\s*\w+))?"
    r"(?:\s+at\s+([^\s].*?)(?=\s+ETA|\s*$))?"
    r"(?:\s+ETA\s+(\S+))?"
)
DEST_RE = re.compile(r"\[download\] Destination:\s*(.+)")
MERGE_RE = re.compile(r'\[Merger\] Merging formats into\s*"(.+)"')
ALREADY_RE = re.compile(r"\[download\] (.+) has already been downloaded")
SIZE_RE = re.compile(r"([\d.]+)\s*(\w+)")


def parse_size(s: str | None) -> int:
    if not s:
        return 0
    m = SIZE_RE.match(s.strip())
    if not m:
        return 0
    n = float(m.group(1))
    unit = m.group(2).upper()
    mult = {
        "B": 1, "KB": 1024, "KIB": 1024,
        "MB": 1024 ** 2, "MIB": 1024 ** 2,
        "GB": 1024 ** 3, "GIB": 1024 ** 3,
        "TB": 1024 ** 4, "TIB": 1024 ** 4,
    }.get(unit, 1)
    return int(n * mult)


def sanitize_filename(name: str) -> str:
    safe = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(". ")
    return safe or "download"


class Job:
    """One yt-dlp invocation. Lives in `JOBS`."""

    __slots__ = (
        "id", "payload", "status", "progress", "bytes_downloaded",
        "bytes_total", "eta", "speed", "output_path", "error",
        "started_at", "finished_at", "log_lines", "process", "thread",
    )

    def __init__(self, payload: dict):
        self.id: str = uuid.uuid4().hex[:12]
        self.payload: dict = payload
        self.status: str = "queued"  # queued | running | done | error | cancelled
        self.progress: float = 0.0
        self.bytes_downloaded: int = 0
        self.bytes_total: int = 0
        self.eta: str | None = None
        self.speed: str | None = None
        self.output_path: str | None = None
        self.error: str | None = None
        self.started_at: str | None = None
        self.finished_at: str | None = None
        self.log_lines: list[str] = []
        self.process: subprocess.Popen | None = None
        self.thread: threading.Thread | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "status": self.status,
            "progress": self.progress,
            "bytesDownloaded": self.bytes_downloaded,
            "bytesTotal": self.bytes_total,
            "eta": self.eta,
            "speed": self.speed,
            "outputPath": self.output_path,
            "error": self.error,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "filename": self.payload.get("filename"),
            "url": self.payload.get("url"),
            "type": self.payload.get("type"),
        }


JOBS: dict[str, Job] = {}
JOBS_LOCK = threading.Lock()
CONFIG = load_or_init_config()
DOWNLOAD_DIR = Path(CONFIG["downloadDir"])


def ensure_dir(p: Path) -> None:
    """mkdir(parents=True, exist_ok=True), but tolerant of junctions /
    reparse points on Windows. Some user home folders (Downloads, Documents
    on OneDrive-managed accounts) are Junction targets; pathlib 3.12's
    `parents=True` walk can trip on them by hitting an OSError whose
    `is_dir()` re-check trusts the junction differently than os.mkdir does.
    Falling back to a direct os.makedirs + is_dir() check works around it.
    """
    try:
        p.mkdir(parents=True, exist_ok=True)
        return
    except OSError:
        pass
    try:
        os.makedirs(str(p), exist_ok=True)
    except OSError:
        pass
    if not p.is_dir():
        raise OSError(f"could not create or access {p}")


ensure_dir(DOWNLOAD_DIR)


def evict_old_jobs() -> None:
    """Keep memory bounded — drop finished jobs past MAX_JOBS_KEPT."""
    with JOBS_LOCK:
        if len(JOBS) <= MAX_JOBS_KEPT:
            return
        finished = sorted(
            (j for j in JOBS.values() if j.status in {"done", "error", "cancelled"}),
            key=lambda j: j.finished_at or "",
        )
        for j in finished[: len(JOBS) - MAX_JOBS_KEPT]:
            JOBS.pop(j.id, None)


def build_ytdlp_argv(payload: dict) -> tuple[list[str], str]:
    """Translate a download payload into yt-dlp argv + output template.

    payload keys (all optional except url):
      url       — required, http(s):// only
      itag      — yt-dlp format id; if absent, helper picks `best`
      type      — "video" | "video-only" | "audio" | "subtitle" | "progressive"
      filename  — sanitized to disk-safe; .%(ext)s appended by yt-dlp
      ext       — extension hint (unused except for filename suffix)
      lang      — subtitle language code (default "en")
    """
    url: str = payload["url"]
    itag: str = (payload.get("itag") or "").strip()
    typ: str = payload.get("type") or "video"
    raw_name = payload.get("filename") or "download"
    safe_name = sanitize_filename(raw_name)
    output_template = str(DOWNLOAD_DIR / f"{safe_name}.%(ext)s")

    argv = ["yt-dlp", "--newline", "--no-color", "--no-warnings",
            "--no-playlist", "--no-mtime"]

    if typ == "subtitle":
        lang = payload.get("lang") or "en"
        argv += ["--skip-download", "--write-subs", "--sub-langs", lang,
                 "--convert-subs", "srt"]
    elif typ == "video-only":
        fmt = f"{itag}+bestaudio" if itag else "bestvideo+bestaudio"
        argv += ["-f", fmt, "--merge-output-format", "mp4"]
    elif typ == "audio":
        fmt = itag or "bestaudio"
        argv += ["-f", fmt]
    else:  # "video" / "progressive" / unknown
        fmt = itag or "best"
        argv += ["-f", fmt]

    argv += ["-o", output_template, "--", url]
    return argv, output_template


def run_job(job: Job) -> None:
    job.status = "running"
    job.started_at = now_iso()
    try:
        argv, _ = build_ytdlp_argv(job.payload)
    except Exception as e:
        job.status = "error"
        job.error = f"bad payload: {e}"
        job.finished_at = now_iso()
        return

    creationflags = 0
    if sys.platform == "win32":
        # Hide the conhost flash for the spawned yt-dlp.
        creationflags = subprocess.CREATE_NO_WINDOW  # type: ignore[attr-defined]

    try:
        job.process = subprocess.Popen(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=creationflags,
        )
    except FileNotFoundError:
        job.status = "error"
        job.error = (
            "yt-dlp not found on PATH. Install with: winget install yt-dlp.yt-dlp"
        )
        job.finished_at = now_iso()
        return
    except Exception as e:
        job.status = "error"
        job.error = f"spawn failed: {e}"
        job.finished_at = now_iso()
        return

    output_path: str | None = None
    assert job.process.stdout is not None
    for line in job.process.stdout:
        line = line.rstrip("\r\n")
        if not line:
            continue
        job.log_lines.append(line)
        if len(job.log_lines) > MAX_LOG_LINES:
            del job.log_lines[: len(job.log_lines) - MAX_LOG_LINES]

        # Find the final on-disk path. yt-dlp emits Destination: on the
        # raw download; Merger emits the post-merge path; "already been
        # downloaded" covers re-runs.
        for rx in (DEST_RE, MERGE_RE, ALREADY_RE):
            m = rx.match(line)
            if m:
                output_path = m.group(1).strip()
                break

        pm = PROGRESS_RE.match(line)
        if pm:
            try:
                job.progress = float(pm.group(1))
            except ValueError:
                pass
            if pm.group(2):
                job.bytes_total = parse_size(pm.group(2)) or job.bytes_total
            if pm.group(3):
                job.speed = pm.group(3).strip()
            if pm.group(4):
                job.eta = pm.group(4).strip()
            if job.bytes_total:
                job.bytes_downloaded = int(job.bytes_total * job.progress / 100)

    rc = job.process.wait()
    job.finished_at = now_iso()
    if job.status == "cancelled":
        return  # leave fields as-is
    if rc == 0:
        job.status = "done"
        job.progress = 100.0
        job.output_path = output_path or str(DOWNLOAD_DIR)
    else:
        job.status = "error"
        # Surface the last few lines so the UI can show something useful.
        tail = "\n".join(job.log_lines[-6:]) if job.log_lines else ""
        job.error = tail or f"yt-dlp exited with code {rc}"
    evict_old_jobs()


class Handler(BaseHTTPRequestHandler):
    server_version = f"uvd-helper/{VERSION}"
    sys_version = ""

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        # Default Python logger spams stderr per request. Keep quiet.
        pass

    # --- helpers ----------------------------------------------------------

    def _cors_headers(self) -> dict[str, str]:
        origin = self.headers.get("Origin", "")
        # Echo the request origin if it's allowed, else "null" (browsers
        # will reject; intentional).
        allow_origin = origin if (origin and ALLOWED_ORIGIN_RE.match(origin)) else "null"
        return {
            "Access-Control-Allow-Origin": allow_origin,
            "Access-Control-Allow-Headers": "Content-Type, X-UVD-Token",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Vary": "Origin",
        }

    def _send_json(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        for k, v in self._cors_headers().items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _check_auth(self) -> bool:
        origin = self.headers.get("Origin", "")
        # Browsers always send Origin on cross-origin requests. If absent,
        # accept only when the caller is non-browser (e.g. curl smoke
        # tests). For real userscript traffic, origin will be the page URL.
        if origin and not ALLOWED_ORIGIN_RE.match(origin):
            self._send_json(403, {"error": "origin not allowed", "origin": origin})
            return False
        token = self.headers.get("X-UVD-Token", "")
        if not secrets.compare_digest(token, CONFIG["token"]):
            self._send_json(401, {"error": "bad or missing token"})
            return False
        return True

    # --- routing ----------------------------------------------------------

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        for k, v in self._cors_headers().items():
            self.send_header(k, v)
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path

        if path == "/health":
            # Intentionally unauthenticated so the userscript can detect
            # helper presence before it has a token. We do NOT return the
            # token here. We DO confirm tools are usable.
            tools = self._probe_tools()
            self._send_json(200, {
                "status": "ok",
                "version": VERSION,
                "downloadDir": str(DOWNLOAD_DIR),
                "tools": tools,
            })
            return

        if not self._check_auth():
            return

        if path == "/jobs":
            with JOBS_LOCK:
                snapshot = [j.to_dict() for j in JOBS.values()]
            self._send_json(200, {"jobs": snapshot})
            return

        parts = [p for p in path.split("/") if p]
        if len(parts) >= 2 and parts[0] == "jobs":
            jid = parts[1]
            with JOBS_LOCK:
                job = JOBS.get(jid)
            if not job:
                self._send_json(404, {"error": "no such job"})
                return
            if len(parts) == 2:
                self._send_json(200, job.to_dict())
                return
            if len(parts) == 3 and parts[2] == "log":
                self._send_json(200, {"log": job.log_lines[-200:]})
                return
            if len(parts) == 3 and parts[2] == "cancel":
                if job.process and job.process.poll() is None:
                    job.status = "cancelled"
                    try:
                        job.process.terminate()
                    except OSError:
                        pass
                self._send_json(200, job.to_dict())
                return

        self._send_json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if not self._check_auth():
            return
        path = urlparse(self.path).path

        if path == "/download":
            length = int(self.headers.get("Content-Length", 0) or 0)
            if length <= 0 or length > 16384:
                self._send_json(400, {"error": "bad content-length"})
                return
            try:
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
            except Exception as e:
                self._send_json(400, {"error": f"bad json: {e}"})
                return

            url = (payload.get("url") or "").strip()
            if not url:
                self._send_json(400, {"error": "url required"})
                return
            if not re.match(r"^https?://", url, re.IGNORECASE):
                self._send_json(400, {"error": "url must be http or https"})
                return

            job = Job(payload)
            with JOBS_LOCK:
                JOBS[job.id] = job
            job.thread = threading.Thread(target=run_job, args=(job,), daemon=True)
            job.thread.start()
            self._send_json(202, job.to_dict())
            return

        if path == "/open-download-dir":
            # Convenience: open the download directory in the OS file
            # browser. Useful for the "Reveal" button in the UI.
            try:
                if sys.platform == "win32":
                    os.startfile(str(DOWNLOAD_DIR))  # type: ignore[attr-defined]
                elif sys.platform == "darwin":
                    subprocess.Popen(["open", str(DOWNLOAD_DIR)])
                else:
                    subprocess.Popen(["xdg-open", str(DOWNLOAD_DIR)])
                self._send_json(200, {"opened": str(DOWNLOAD_DIR)})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            return

        self._send_json(404, {"error": "not found"})

    # --- introspection ----------------------------------------------------

    def _probe_tools(self) -> dict:
        out: dict[str, str | None] = {"yt-dlp": None, "ffmpeg": None}
        creationflags = (
            subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0  # type: ignore[attr-defined]
        )
        for tool in out:
            try:
                r = subprocess.run(
                    [tool, "--version"],
                    capture_output=True, text=True, timeout=4,
                    creationflags=creationflags,
                )
                if r.returncode == 0:
                    out[tool] = r.stdout.strip().splitlines()[0] if r.stdout else "ok"
            except Exception:
                pass
        return out


def main() -> int:
    if "--print-token" in sys.argv:
        print(CONFIG["token"])
        return 0
    if "--print-config" in sys.argv:
        print(json.dumps({**CONFIG, "configFile": str(config_dir() / "config.json")},
                         indent=2))
        return 0

    port = int(CONFIG.get("port", DEFAULT_PORT))
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError as e:
        print(f"failed to bind 127.0.0.1:{port}: {e}", file=sys.stderr)
        return 1
    print(f"uvd-helper v{VERSION} listening on http://127.0.0.1:{port}")
    print(f"  config:    {config_dir() / 'config.json'}")
    print(f"  downloads: {DOWNLOAD_DIR}")
    print("  token:     (use --print-token to retrieve; paste into the userscript settings)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
        server.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
