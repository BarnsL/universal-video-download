# uvd-helper

A tiny localhost daemon that bridges the userscript ↔ `yt-dlp`. When
installed, the userscript's Download button just works — no clipboard
round-trip, no terminal, no manual paste. Progress streams back into the
download dialog in real time.

## Why?

The userscript on its own can't run `yt-dlp` because browser sandboxes
block process execution. It also can't decrypt YouTube's signature
ciphers (see [BUG-004 in `BUGS.md`](../BUGS.md)). The helper closes both
gaps: the userscript POSTs a download request to `http://127.0.0.1:34899`,
the helper spawns `yt-dlp`, and the userscript polls a job endpoint to
draw a progress bar.

## Quick start (Windows)

```powershell
# From this directory (helper/) — installs deps, registers an auto-start
# task, copies the token to your clipboard:
.\install.ps1
```

Then in your browser:

1. Open any supported site (e.g. youtube.com).
2. Press **Ctrl+Shift+D** to open the download dialog.
3. Click the gear icon, paste the token, save.
4. Pick a stream and click **Download** — it streams straight to disk.

## What the installer does

1. Ensures Python 3.10+, `yt-dlp`, `ffmpeg` are installed (via winget).
2. Drops `uvd-helper.py` into `%LOCALAPPDATA%\uvd-helper\`.
3. Bootstraps `config.json` with a random 64-hex-char token.
4. Registers a Scheduled Task that auto-starts the helper at login,
   hidden, with no console window (uses `pythonw.exe` when present).
5. Starts the task now.
6. Probes `/health` to confirm the helper is up.
7. Copies the token to your clipboard.

## Architecture

```
[Browser - userscript]  ──HTTP + X-UVD-Token──>  [127.0.0.1:34899 - uvd-helper.py]
        |                                                        |
        |                                                        ├── spawn yt-dlp
        |                                                        |
        └────── GET /jobs/<id> (1Hz poll) ───── progress ────────┘
```

- `GET  /health`                   — unauthenticated; reports version,
                                     download dir, and whether yt-dlp +
                                     ffmpeg are on PATH.
- `POST /download`                 — auth; body `{url, itag, ext, type,
                                     filename, lang?}` → starts a job,
                                     returns 202 with the job snapshot.
- `GET  /jobs`                     — auth; lists known jobs.
- `GET  /jobs/<id>`                — auth; current job state (status,
                                     progress%, bytes, speed, ETA, error).
- `GET  /jobs/<id>/log`            — auth; last ~200 yt-dlp log lines.
- `GET  /jobs/<id>/cancel`         — auth; SIGTERM the spawned yt-dlp.
- `POST /open-download-dir`        — auth; open the download folder in
                                     the OS file browser.

All authed endpoints require `X-UVD-Token: <token>` and an `Origin`
header that matches the same whitelist the userscript's `@match`
declares. `OPTIONS` preflights are answered for CORS.

## Security model

- **127.0.0.1-only bind.** Other machines can't reach the helper.
- **64-hex-char token** stored in `config.json` (mode `0600` on POSIX).
  Required on every authed request. Compared with
  `secrets.compare_digest` (constant-time).
- **Origin whitelist.** Authed requests must come from an allowed origin
  — same site list the userscript supports — so a random tab can't
  trigger downloads if it somehow learns the token.
- **URL scheme guard.** `/download` only accepts `http://` / `https://`
  URLs; `file://` and friends are rejected.
- **Bounded I/O.** Request body is capped at 16 KB. Job log capped at
  ~400 lines. Finished jobs evicted past 50.
- **No shell.** `yt-dlp` is invoked with a list argv via
  `subprocess.Popen`, never through a shell.

## Configuration

`%LOCALAPPDATA%\uvd-helper\config.json`:

```json
{
  "token": "…64 hex chars…",
  "port": 34899,
  "downloadDir": "C:\\Users\\you\\Downloads\\uvd"
}
```

Edit and restart the Scheduled Task (`Start-ScheduledTask -TaskName uvd-helper`)
to apply changes.

## Recovering the token

If you lost it:

```powershell
python "$env:LOCALAPPDATA\uvd-helper\uvd-helper.py" --print-token
```

## Logs / troubleshooting

The helper writes nothing to disk by default — it's silent unless run in
the foreground. To debug, stop the task and run interactively:

```powershell
Stop-ScheduledTask -TaskName uvd-helper
python "$env:LOCALAPPDATA\uvd-helper\uvd-helper.py"
```

Common failures:

- **`/health` returns but `tools.yt-dlp` is `null`.** Reopen PowerShell
  so the freshly-installed yt-dlp is on PATH, then restart the task.
- **Userscript shows "Helper unreachable" but the task is running.** The
  port may be taken — check with `Get-NetTCPConnection -LocalPort 34899`.
  Edit `port` in config.json, restart, and re-paste the same token.
- **CORS error in the browser console.** The site you're on isn't in the
  allowed-origin list. Add a regex branch in `ALLOWED_ORIGIN_RE` in
  `uvd-helper.py` and the userscript's `@match` block.

## Uninstall

```powershell
Unregister-ScheduledTask -TaskName uvd-helper -Confirm:$false
Remove-Item -Recurse "$env:LOCALAPPDATA\uvd-helper"
```

## Non-Windows

The helper is plain stdlib Python and works on macOS and Linux. There is
no installer for those platforms yet — run the script under
`launchctl`/systemd yourself, or just `python3 uvd-helper.py` in a
terminal. Config + downloads live under the platform-standard locations
(see the docstring in `uvd-helper.py`).
