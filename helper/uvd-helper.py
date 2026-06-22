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

import html
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

VERSION = "1.1.1"


_real_print = print  # capture before any further indirection

def safe_print(*args, **kwargs) -> None:
    """`print` swallowing OSError so pythonw.exe (which connects stdout/
    stderr to NUL) can't crash us with EBADF on a flush. Stdout messages
    are informational only — losing them is fine."""
    try:
        _real_print(*args, **kwargs)
    except OSError:
        pass


def augment_path_windows() -> None:
    """winget-installed binaries (yt-dlp, ffmpeg, etc.) live under
    `%LOCALAPPDATA%\\Microsoft\\WinGet\\Packages\\<id>\\...` and are normally
    surfaced via shims in `%LOCALAPPDATA%\\Microsoft\\WinGet\\Links`. Those
    PATH additions only land in PROCESSES STARTED AFTER the install.
    The helper is started by a long-lived parent (PowerShell session,
    Startup .vbs, etc.) that may have stale PATH at the moment.

    To make the helper resilient, we walk the WinGet locations
    ourselves at startup and prepend any directory that contains an
    executable we care about. Same idea for ffmpeg's bin dir under
    `%ProgramFiles%`."""
    if sys.platform != "win32":
        return
    additions: list[str] = []
    local = Path(os.environ.get("LOCALAPPDATA", ""))
    if local.is_dir():
        links = local / "Microsoft" / "WinGet" / "Links"
        if links.is_dir():
            additions.append(str(links))
        packages = local / "Microsoft" / "WinGet" / "Packages"
        if packages.is_dir():
            for sub in packages.iterdir():
                if not sub.is_dir():
                    continue
                # Most winget packages put their exes at the package
                # root; some nest under bin/. Both are cheap to add.
                if any((sub / e).exists() for e in ("yt-dlp.exe", "ffmpeg.exe")):
                    additions.append(str(sub))
                bin_ = sub / "bin"
                if bin_.is_dir() and any(b.suffix.lower() == ".exe" for b in bin_.iterdir()):
                    additions.append(str(bin_))
    # Common ffmpeg shipped via choco / manual unzip locations.
    for cand in (
        Path(os.environ.get("ProgramFiles", "C:\\Program Files")) / "ffmpeg" / "bin",
        Path("D:/Programs/ffmpeg-8.1.1/ffmpeg-8.1.1-full_build/bin"),
    ):
        if cand.is_dir():
            additions.append(str(cand))
    if additions:
        os.environ["PATH"] = os.pathsep.join(additions + [os.environ.get("PATH", "")])


augment_path_windows()
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


CONFIG_DEFAULTS = {
    "port": DEFAULT_PORT,
    # Queue & retry knobs (v1.1.0).
    # maxConcurrent caps total active downloads; maxConcurrentPerHost
    # prevents hammering a single site (mostly YouTube anti-bot).
    # maxRetries + retryBackoffSeconds drive exponential backoff on
    # transient yt-dlp failures. minFreeDiskMB skips spawning a job if
    # the download volume is below that threshold so we don't fill the
    # disk and leave a corrupted partial file.
    "maxConcurrent": 2,
    "maxConcurrentPerHost": 2,
    "maxRetries": 3,
    "retryBackoffSeconds": 30,
    "minFreeDiskMB": 200,
}


def load_or_init_config() -> dict:
    cfg_dir = config_dir()
    cfg_dir.mkdir(parents=True, exist_ok=True)
    cfg_file = cfg_dir / "config.json"
    if cfg_file.exists():
        try:
            cfg = json.loads(cfg_file.read_text(encoding="utf-8"))
            # Backfill missing keys when older configs exist.
            cfg.setdefault("token", secrets.token_hex(32))
            for k, v in CONFIG_DEFAULTS.items():
                cfg.setdefault(k, v)
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
            safe_print(f"warn: config unreadable ({e}); regenerating", file=sys.stderr)
    cfg = {
        "token": secrets.token_hex(32),
        "downloadDir": pick_writable_download_dir(),
        **CONFIG_DEFAULTS,
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
    """One yt-dlp invocation. Lives in `JOBS`.

    v1.1.0 fields support queueing/retry:
      - priority: higher runs first (default 0)
      - created_at: tie-breaker for FIFO within the same priority
      - retry_count: number of times this job has been retried so far
      - retry_at: epoch seconds; queue dispatcher skips this job until
        time.time() >= retry_at (used for exponential backoff)
      - host: extracted from payload['url'], used by per-host concurrency
      - cancel_requested: set to True by the cancel endpoint; the worker
        polls it and terminates yt-dlp + skips remaining retries
    """

    __slots__ = (
        "id", "payload", "status", "progress", "bytes_downloaded",
        "bytes_total", "eta", "speed", "output_path", "error",
        "started_at", "finished_at", "log_lines", "process", "thread",
        # v1.1.0 additions
        "priority", "created_at", "retry_count", "retry_at",
        "host", "cancel_requested",
    )

    def __init__(self, payload: dict, jid: str | None = None):
        self.id: str = jid or uuid.uuid4().hex[:12]
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
        # v1.1.0
        self.priority: int = int(payload.get("priority") or 0)
        self.created_at: float = time.time()
        self.retry_count: int = 0
        self.retry_at: float = 0.0
        self.host: str = _extract_host(payload.get("url") or "")
        self.cancel_requested: bool = False

    def to_dict(self) -> dict:
        """Snapshot for the wire. Stable shape — the userscript reads this."""
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
            "priority": self.priority,
            "createdAt": self.created_at,
            "retryCount": self.retry_count,
            "retryAt": self.retry_at,
            "host": self.host,
        }

    def to_persist(self) -> dict:
        """Persistent snapshot — includes payload so we can re-run on
        next helper start. Log lines + transient subprocess handle are
        omitted on purpose (logs are huge and don't matter after a
        restart; the Popen can't be serialised at all)."""
        return {**self.to_dict(), "payload": self.payload}

    @classmethod
    def from_persist(cls, d: dict) -> "Job":
        j = cls(d.get("payload") or {}, jid=d.get("id"))
        j.status = d.get("status") or "queued"
        # Anything that was "running" when the helper died gets
        # requeued — yt-dlp's --no-overwrites + --continue make this
        # safe most of the time, but we err on the side of re-running
        # from scratch.
        if j.status == "running":
            j.status = "queued"
        j.progress = float(d.get("progress") or 0)
        j.bytes_downloaded = int(d.get("bytesDownloaded") or 0)
        j.bytes_total = int(d.get("bytesTotal") or 0)
        j.eta = d.get("eta")
        j.speed = d.get("speed")
        j.output_path = d.get("outputPath")
        j.error = d.get("error")
        j.started_at = d.get("startedAt")
        j.finished_at = d.get("finishedAt")
        j.priority = int(d.get("priority") or 0)
        j.created_at = float(d.get("createdAt") or time.time())
        j.retry_count = int(d.get("retryCount") or 0)
        j.retry_at = float(d.get("retryAt") or 0)
        j.host = d.get("host") or _extract_host(j.payload.get("url") or "")
        return j


def _extract_host(url: str) -> str:
    try:
        n = urlparse(url).netloc.lower()
        # Group all youtube.com / youtu.be variants under one bucket.
        if n.endswith("youtube.com") or n == "youtu.be":
            return "youtube"
        if n.endswith("vimeo.com"):
            return "vimeo"
        return n or "unknown"
    except Exception:
        return "unknown"


JOBS: dict[str, Job] = {}
JOBS_LOCK = threading.Lock()
JOBS_CV = threading.Condition(JOBS_LOCK)
QUEUE_PAUSED = False
CONFIG = load_or_init_config()
DOWNLOAD_DIR = Path(CONFIG["downloadDir"])

JOBS_FILE = config_dir() / "jobs.json"


def persist_jobs() -> None:
    """Atomically write the current JOBS snapshot to disk so that an
    abrupt helper exit (reboot, OOM, taskkill) doesn't lose the queue.
    Atomic-ish: write to .tmp, then os.replace onto the real file.

    Called after every status transition. Cheap — the queue is bounded
    to MAX_JOBS_KEPT entries."""
    try:
        with JOBS_LOCK:
            snapshot = [j.to_persist() for j in JOBS.values()]
        tmp = JOBS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(snapshot, indent=2), encoding="utf-8")
        os.replace(tmp, JOBS_FILE)
    except OSError:
        # Disk full / permission issue / config dir gone. Persistence
        # is best-effort; in-memory queue keeps working.
        pass


def restore_jobs() -> None:
    """Re-populate JOBS from jobs.json at startup."""
    if not JOBS_FILE.exists():
        return
    try:
        raw = json.loads(JOBS_FILE.read_text(encoding="utf-8"))
    except Exception as e:
        safe_print(f"warn: jobs.json unreadable ({e})", file=sys.stderr)
        return
    if not isinstance(raw, list):
        return
    with JOBS_LOCK:
        for d in raw:
            try:
                j = Job.from_persist(d)
                JOBS[j.id] = j
            except Exception:
                continue


def _probe_tools_once() -> dict:
    """One-time probe of yt-dlp + ffmpeg --version. Results are baked
    into the module-level cache that /health reads. We don't re-probe at
    runtime because (a) the tools don't appear or disappear mid-session
    in any normal flow, (b) each subprocess.run takes 2-3s on Windows
    just for Python startup, and probing per /health blew past the
    userscript's 2.5s timeout and made the helper look dead."""
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


# v1.1.1 — probe in a background thread so the helper binds its port
# immediately instead of waiting up to 8s for two subprocess.run calls
# at module-import time. On Windows, `yt-dlp.exe --version` can take
# 25+ seconds the first time it runs after install (SmartScreen scan +
# Python startup), and the synchronous probe was making the userscript's
# detectHelper() time out before the helper even bound 127.0.0.1:34899.
#
# /health reads _tools_cache; if the probe hasn't finished yet the
# dict just shows {None, None} for a couple seconds, then fills in.
_tools_cache: dict = {"yt-dlp": None, "ffmpeg": None}
def _probe_tools_async() -> None:
    global _tools_cache
    result = _probe_tools_once()
    _tools_cache = result
threading.Thread(target=_probe_tools_async, daemon=True).start()


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


def _spawn_ytdlp_and_track(job: Job) -> int:
    """Single yt-dlp invocation. Returns the process exit code. Updates
    job progress/bytes/speed/eta/output_path/log_lines as output streams.

    Separate from the retry loop so the loop can decide whether to
    re-spawn based on the exit code alone."""
    try:
        argv, _ = build_ytdlp_argv(job.payload)
    except Exception as e:
        job.log_lines.append(f"[uvd-helper] bad payload: {e}")
        return 2

    creationflags = 0
    if sys.platform == "win32":
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
        job.log_lines.append(
            "[uvd-helper] yt-dlp not found on PATH. "
            "Install with: winget install yt-dlp.yt-dlp"
        )
        return 127
    except Exception as e:
        job.log_lines.append(f"[uvd-helper] spawn failed: {e}")
        return 1

    output_path: str | None = None
    assert job.process.stdout is not None
    for line in job.process.stdout:
        if job.cancel_requested:
            try:
                job.process.terminate()
            except OSError:
                pass
        line = line.rstrip("\r\n")
        if not line:
            continue
        job.log_lines.append(line)
        if len(job.log_lines) > MAX_LOG_LINES:
            del job.log_lines[: len(job.log_lines) - MAX_LOG_LINES]

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
    if output_path:
        job.output_path = output_path
    return rc


# yt-dlp exit codes that are clearly fatal (no point retrying): 127
# means "command not found" (PATH issue we report once); 2 means bad
# argv / bad payload — same flag will fail every time. Anything else
# we treat as potentially-transient (rate limit, signature change,
# socket reset, etc.) and retry with backoff.
NON_RETRYABLE_EXIT_CODES = {2, 127}


def run_job_worker(job: Job) -> None:
    """Run a job, retrying on transient failures up to maxRetries.

    Called in its own thread by the queue dispatcher. Owns the
    transition of job.status from 'running' -> 'done' | 'error' |
    'cancelled', or back to 'queued' (with a retry_at in the future)
    when a retry is scheduled."""
    job.status = "running"
    job.started_at = job.started_at or now_iso()
    persist_jobs()

    while True:
        rc = _spawn_ytdlp_and_track(job)

        if job.cancel_requested:
            with JOBS_CV:
                job.status = "cancelled"
                job.finished_at = now_iso()
                JOBS_CV.notify_all()
            persist_jobs()
            return

        if rc == 0:
            with JOBS_CV:
                job.status = "done"
                job.progress = 100.0
                job.finished_at = now_iso()
                if not job.output_path:
                    job.output_path = str(DOWNLOAD_DIR)
                JOBS_CV.notify_all()
            persist_jobs()
            evict_old_jobs()
            return

        # Non-retryable failure modes — surface and stop.
        if rc in NON_RETRYABLE_EXIT_CODES or job.retry_count >= int(CONFIG["maxRetries"]):
            with JOBS_CV:
                job.status = "error"
                tail = "\n".join(job.log_lines[-6:]) if job.log_lines else ""
                job.error = tail or f"yt-dlp exited with code {rc}"
                job.finished_at = now_iso()
                JOBS_CV.notify_all()
            persist_jobs()
            evict_old_jobs()
            return

        # Retry with exponential backoff. Going back to 'queued' so the
        # dispatcher reclaims the slot and can run another job while we
        # wait — we just bump retry_at into the future and the
        # dispatcher's pick_next_job() will skip us until then.
        job.retry_count += 1
        backoff = int(CONFIG["retryBackoffSeconds"]) * (2 ** (job.retry_count - 1))
        with JOBS_CV:
            job.status = "queued"
            job.retry_at = time.time() + backoff
            job.log_lines.append(
                f"[uvd-helper] yt-dlp exited {rc}; retry "
                f"{job.retry_count}/{CONFIG['maxRetries']} in {backoff}s"
            )
            JOBS_CV.notify_all()
        persist_jobs()
        return  # dispatcher will re-pick us at retry_at


def pick_next_job_locked() -> Job | None:
    """Pick the next eligible queued job. JOBS_LOCK MUST be held.

    Eligibility:
      - status == 'queued' and not held back by retry_at
      - host hasn't already hit maxConcurrentPerHost
      - enough free disk for a sensible download (heuristic)
    Order:
      - higher priority first
      - earlier created_at first (FIFO within priority)"""
    if QUEUE_PAUSED:
        return None
    now = time.time()
    queued = sorted(
        (j for j in JOBS.values()
         if j.status == "queued" and j.retry_at <= now),
        key=lambda j: (-j.priority, j.created_at),
    )
    if not queued:
        return None
    host_counts: dict[str, int] = {}
    for j in JOBS.values():
        if j.status == "running":
            host_counts[j.host] = host_counts.get(j.host, 0) + 1
    per_host_cap = int(CONFIG["maxConcurrentPerHost"])
    min_free = int(CONFIG["minFreeDiskMB"]) * 1024 * 1024
    for j in queued:
        if host_counts.get(j.host, 0) >= per_host_cap:
            continue
        try:
            if shutil.disk_usage(DOWNLOAD_DIR).free < min_free:
                # Don't start new jobs when disk is nearly full.
                # Existing running jobs are left alone — yt-dlp will
                # error out if it really runs out of space.
                return None
        except OSError:
            pass
        return j
    return None


def queue_dispatcher_loop() -> None:
    """Single dispatcher thread. Wakes on JOBS_CV, claims an eligible
    job, spawns a worker thread, repeats. Idle when nothing's
    eligible."""
    while True:
        with JOBS_CV:
            while True:
                running = sum(1 for j in JOBS.values() if j.status == "running")
                if running >= int(CONFIG["maxConcurrent"]):
                    JOBS_CV.wait(timeout=5)
                    continue
                cand = pick_next_job_locked()
                if cand is None:
                    # Wake on cv.notify_all() or every 5s so retry_at
                    # comebacks aren't missed indefinitely.
                    JOBS_CV.wait(timeout=5)
                    continue
                # Reserve the slot before releasing the lock so two
                # dispatcher rounds can't claim the same job.
                cand.status = "running"
                cand.started_at = cand.started_at or now_iso()
                break
        # Out of the lock — spawn worker.
        t = threading.Thread(target=run_job_worker, args=(cand,), daemon=True)
        cand.thread = t
        t.start()


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
    persist_jobs()


class Handler(BaseHTTPRequestHandler):
    # Stay on HTTP/1.0 (the stdlib default). We tried protocol_version
    # = "HTTP/1.1" in v1.0.3 — Python's BaseHTTPRequestHandler with
    # HTTP/1.1 keeps the handler thread alive waiting for more
    # requests on the same socket. Combined with ThreadingHTTPServer
    # that means short-lived clients (browser XHR, curl one-shots)
    # tie up worker threads waiting for a follow-up that never
    # comes; eventually accept() can't keep up and new clients sit
    # in the listen backlog without ever being served. HTTP/1.0
    # means one request -> one response -> close, which is exactly
    # what this daemon needs. Browsers downgrade to 1.0 silently
    # and small fetch/XHR payloads work fine.
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
        headers = {
            "Access-Control-Allow-Origin": allow_origin,
            "Access-Control-Allow-Headers": "Content-Type, X-UVD-Token",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Vary": "Origin",
        }
        # Chromium 130+ "Private Network Access": when a public-origin
        # page (https://youtube.com) fetches a private-network address
        # (127.0.0.1), the browser sends `Access-Control-Request-Private-
        # Network: true` on the preflight. We must echo
        # `Access-Control-Allow-Private-Network: true` or the connection
        # is blocked before the actual request ever runs. Echoing only
        # when the request asks keeps the response surface clean.
        if self.headers.get("Access-Control-Request-Private-Network", "").lower() == "true":
            headers["Access-Control-Allow-Private-Network"] = "true"
        return headers

    def _send_json(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode("utf-8")
        # Wrap the entire send. On Windows, clients that close the
        # socket mid-response surface as ConnectionAbortedError
        # (WinError 10053) — distinct from BrokenPipeError on POSIX and
        # from ConnectionResetError. Treat all three as "client gave up,
        # nothing more to do" so the handler thread doesn't crash. The
        # bare `OSError` catch covers any other socket-level oddity
        # (timeout, connection reset by router, etc.).
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            for k, v in self._cors_headers().items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except OSError:
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
        try:
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.send_header("Connection", "close")
            for k, v in self._cors_headers().items():
                self.send_header(k, v)
            self.send_header("Access-Control-Max-Age", "86400")
            self.end_headers()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path

        if path == "/health":
            # Intentionally unauthenticated so the userscript can detect
            # helper presence before it has a token. We do NOT return the
            # token here. We DO confirm tools are usable.
            tools = _tools_cache
            with JOBS_LOCK:
                queue_stats = _queue_stats_locked()
            self._send_json(200, {
                "status": "ok",
                "version": VERSION,
                "downloadDir": str(DOWNLOAD_DIR),
                "tools": tools,
                "queue": queue_stats,
                "paused": QUEUE_PAUSED,
                "config": {
                    "maxConcurrent": CONFIG["maxConcurrent"],
                    "maxConcurrentPerHost": CONFIG["maxConcurrentPerHost"],
                    "maxRetries": CONFIG["maxRetries"],
                },
            })
            return

        if path == "/setup":
            # Friendly HTML landing page used by the installer. Shows
            # the token, with a Copy button, plus a one-click link to
            # install the userscript. Unauthenticated by design — it's
            # only reachable from 127.0.0.1, and the token IS the auth
            # bootstrap so it has to come from somewhere.
            self._send_setup_page()
            return

        if not self._check_auth():
            return

        if path == "/jobs":
            with JOBS_LOCK:
                snapshot = [j.to_dict() for j in JOBS.values()]
            self._send_json(200, {"jobs": snapshot})
            return

        if path == "/queue":
            with JOBS_LOCK:
                snapshot = [j.to_dict() for j in JOBS.values()]
                stats = _queue_stats_locked()
            self._send_json(200, {
                "jobs": snapshot,
                "stats": stats,
                "paused": QUEUE_PAUSED,
            })
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
                with JOBS_CV:
                    job.cancel_requested = True
                    if job.process and job.process.poll() is None:
                        try:
                            job.process.terminate()
                        except OSError:
                            pass
                    if job.status == "queued":
                        # Wasn't running yet — flip directly to cancelled.
                        job.status = "cancelled"
                        job.finished_at = now_iso()
                    JOBS_CV.notify_all()
                persist_jobs()
                self._send_json(200, job.to_dict())
                return
            if len(parts) == 3 and parts[2] == "retry":
                with JOBS_CV:
                    if job.status in {"error", "cancelled"}:
                        job.status = "queued"
                        job.retry_count = 0
                        job.retry_at = 0.0
                        job.cancel_requested = False
                        job.error = None
                        job.finished_at = None
                        JOBS_CV.notify_all()
                persist_jobs()
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
            with JOBS_CV:
                JOBS[job.id] = job
                # Wake the dispatcher so it picks the new job up
                # immediately if there's a free slot.
                JOBS_CV.notify_all()
            persist_jobs()
            self._send_json(202, job.to_dict())
            return

        if path == "/queue/pause":
            global QUEUE_PAUSED
            QUEUE_PAUSED = True
            self._send_json(200, {"paused": True})
            return

        if path == "/queue/resume":
            QUEUE_PAUSED = False
            with JOBS_CV:
                JOBS_CV.notify_all()
            self._send_json(200, {"paused": False})
            return

        if path == "/queue/clear-completed":
            with JOBS_LOCK:
                removed = [
                    jid for jid, j in JOBS.items()
                    if j.status in {"done", "error", "cancelled"}
                ]
                for jid in removed:
                    JOBS.pop(jid, None)
            persist_jobs()
            self._send_json(200, {"removed": len(removed)})
            return

        if path == "/queue/cancel-all":
            with JOBS_CV:
                affected = 0
                for j in JOBS.values():
                    if j.status in {"queued", "running"}:
                        j.cancel_requested = True
                        if j.process and j.process.poll() is None:
                            try:
                                j.process.terminate()
                            except OSError:
                                pass
                        if j.status == "queued":
                            j.status = "cancelled"
                            j.finished_at = now_iso()
                        affected += 1
                JOBS_CV.notify_all()
            persist_jobs()
            self._send_json(200, {"cancelled": affected})
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

    def _send_setup_page(self) -> None:
        """Serve the /setup HTML page.

        Token IS shown in the page DOM — this endpoint exists so the
        installer can fire-and-forget open it in the browser and the
        user has one screen with everything they need (token + copy
        button + userscript install link). 127.0.0.1-only bind ensures
        no other machine can read it. We also send X-Content-Type-Options
        and a tight CSP so the page can't be embedded/exfiltrated."""
        userscript_url = (
            "https://raw.githubusercontent.com/BarnsL/universal-video-download/"
            "main/universal-video-download.user.js"
        )
        tampermonkey_url = "https://www.tampermonkey.net/"
        token_html = html.escape(CONFIG["token"])
        dl_html = html.escape(str(DOWNLOAD_DIR))
        body = f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>uvd-helper setup</title>
<style>
  :root {{ color-scheme: dark; }}
  body {{ background: #0f0f10; color: #e7e7ea; font-family: -apple-system,
         BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         max-width: 720px; margin: 40px auto; padding: 0 20px;
         line-height: 1.55; }}
  h1 {{ font-size: 22px; }}
  h2 {{ font-size: 16px; margin-top: 28px; color: #a8a8b3; font-weight: 500; }}
  .step {{ background: #1a1a1c; border: 1px solid #2a2a2f;
          border-radius: 10px; padding: 16px 18px; margin: 12px 0; }}
  .num {{ display: inline-flex; width: 22px; height: 22px;
         border-radius: 50%; background: #6366f1; color: white;
         align-items: center; justify-content: center;
         font-weight: 600; font-size: 13px; margin-right: 8px; }}
  code {{ background: #0a0a0b; padding: 2px 6px; border-radius: 4px;
         font-family: ui-monospace, Consolas, monospace; color: #c4b5fd; }}
  input {{ background: #0a0a0b; color: #c4b5fd; border: 1px solid #2a2a2f;
          border-radius: 6px; padding: 10px 12px; width: 100%;
          font-family: ui-monospace, Consolas, monospace; font-size: 13px;
          box-sizing: border-box; }}
  button {{ background: #6366f1; color: white; border: none;
           border-radius: 6px; padding: 10px 16px; font-size: 13px;
           cursor: pointer; font-weight: 500; }}
  button:hover {{ background: #5158d8; }}
  .copy-row {{ display: grid; grid-template-columns: 1fr auto;
              gap: 8px; margin: 10px 0; }}
  a {{ color: #a5b4fc; }}
  .ok {{ color: #86efac; }}
  .hint {{ color: #888; font-size: 12px; margin-top: 6px; }}
</style></head><body>
<h1>uvd-helper is running <span class="ok">●</span></h1>
<p>Version {VERSION}. Downloads land in <code>{dl_html}</code>.</p>
<h2>Three steps to finish setup</h2>
<div class="step">
  <p><span class="num">1</span><strong>Install Tampermonkey</strong> in your
  browser if you haven't already.</p>
  <p><a href="{tampermonkey_url}" target="_blank">tampermonkey.net</a> —
  works on Chrome, Edge, Brave, Firefox, Safari. On Chromium 138+ also
  enable <em>"Allow User Scripts"</em> on the Tampermonkey card in
  <code>chrome://extensions</code>.</p>
</div>
<div class="step">
  <p><span class="num">2</span><strong>Install the userscript</strong>.</p>
  <p><a href="{userscript_url}" target="_blank">Open the raw script URL</a> —
  Tampermonkey will detect it and offer to install.</p>
</div>
<div class="step">
  <p><span class="num">3</span><strong>Paste the access token</strong> into
  the userscript's Settings panel.</p>
  <div class="copy-row">
    <input id="tok" value="{token_html}" readonly>
    <button id="cp">Copy</button>
  </div>
  <p class="hint">Open any supported site (e.g. youtube.com), press
  <code>Ctrl+Shift+D</code>, click <code>⚙️ Settings</code>, paste,
  Save. After that the Download button just works.</p>
</div>
<h2>Anytime references</h2>
<p>Token also retrievable from a terminal:
<code>python "%LOCALAPPDATA%\\uvd-helper\\uvd-helper.py" --print-token</code></p>
<p>Helper config:
<code>%LOCALAPPDATA%\\uvd-helper\\config.json</code> (edit + restart task
to change download dir, port, concurrency).</p>
<script>
  const inp = document.getElementById('tok');
  const btn = document.getElementById('cp');
  btn.addEventListener('click', async () => {{
    try {{ await navigator.clipboard.writeText(inp.value); }}
    catch (e) {{ inp.select(); document.execCommand('copy'); }}
    btn.textContent = '✅ Copied';
    setTimeout(() => btn.textContent = 'Copy', 1500);
  }});
</script>
</body></html>"""
        data = body.encode("utf-8")
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.send_header("X-Content-Type-Options", "nosniff")
            # Keep the page self-contained — no fonts or images from
            # outside. Tight CSP makes accidental data exfil harder.
            self.send_header(
                "Content-Security-Policy",
                "default-src 'none'; style-src 'unsafe-inline'; "
                "script-src 'unsafe-inline'; img-src data:; connect-src 'none'"
            )
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass


def _queue_stats_locked() -> dict:
    """Aggregate counts for the queue. Caller must hold JOBS_LOCK."""
    counts = {"queued": 0, "running": 0, "done": 0, "error": 0, "cancelled": 0}
    bytes_downloaded = 0
    bytes_total = 0
    for j in JOBS.values():
        counts[j.status] = counts.get(j.status, 0) + 1
        if j.status == "running":
            bytes_downloaded += j.bytes_downloaded
            bytes_total += j.bytes_total
    return {
        "total": len(JOBS),
        "byStatus": counts,
        "activeBytesDownloaded": bytes_downloaded,
        "activeBytesTotal": bytes_total,
    }


def main() -> int:
    if "--print-token" in sys.argv:
        safe_print(CONFIG["token"])
        return 0
    if "--print-config" in sys.argv:
        safe_print(json.dumps({**CONFIG, "configFile": str(config_dir() / "config.json")},
                         indent=2))
        return 0

    # Restore the persisted queue from the previous helper run. Any
    # jobs that were 'running' when we last died get bumped back to
    # 'queued' so the dispatcher picks them up again.
    restore_jobs()

    # Single queue dispatcher thread. Workers spawn off it.
    dispatcher = threading.Thread(target=queue_dispatcher_loop, daemon=True)
    dispatcher.start()

    port = int(CONFIG.get("port", DEFAULT_PORT))
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError as e:
        safe_print(f"failed to bind 127.0.0.1:{port}: {e}", file=sys.stderr)
        return 1
    safe_print(f"uvd-helper v{VERSION} listening on http://127.0.0.1:{port}")
    safe_print(f"  config:    {config_dir() / 'config.json'}")
    safe_print(f"  downloads: {DOWNLOAD_DIR}")
    safe_print(f"  queue:     max {CONFIG['maxConcurrent']} concurrent, "
               f"{CONFIG['maxConcurrentPerHost']}/host, "
               f"retries {CONFIG['maxRetries']} (backoff {CONFIG['retryBackoffSeconds']}s)")
    safe_print("  setup:     http://127.0.0.1:%d/setup" % port)
    safe_print("  token:     (use --print-token to retrieve; paste into the userscript settings)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        safe_print("\nshutting down")
        server.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
