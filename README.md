# Universal Video Download

A Tampermonkey userscript + tiny localhost daemon that brings **NewPipe-style** downloads to **every site that plays video**, including YouTube's signature-encrypted streams. Pick resolution, container, codec, audio track, subtitles and parallel-thread count from a clean dark dialog. The Download button just works end-to-end — file lands on disk, progress bar lives in the dialog.

---

## Quick start (do this in order)

The userscript can't run `yt-dlp` on its own — the browser sandbox blocks process execution. The helper daemon is what closes the gap. **Install the helper first, then the userscript, then paste the token. The userscript will look broken on YouTube until all three steps are done.**

### 1. Install and start the helper (~30 seconds)

**Windows (one-liner):**

```powershell
powershell -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/BarnsL/universal-video-download/main/helper/install.ps1 -OutFile $env:TEMP\uvd-install.ps1; & $env:TEMP\uvd-install.ps1"
```

The installer:

- Ensures Python 3.10+, `yt-dlp`, and `ffmpeg` are installed (via `winget`).
- Drops `uvd-helper.py` into `%LOCALAPPDATA%\uvd-helper\`.
- Sets up auto-start at login via a Startup-folder `.vbs` launcher (silent, no console flash).
- Starts the daemon now and polls `/health` until it's up.
- **Copies the access token to your clipboard** and **opens `http://127.0.0.1:34899/setup` in your default browser** — a self-contained page with the token (with a Copy button), an "Install the userscript" link, and the rest of the setup walk-through.

Just follow what the `/setup` page tells you and you're done. Steps 2 and 3 below mirror what's on that page.

**macOS / Linux:** no installer yet — run `python3 helper/uvd-helper.py` in a terminal (or wire it into `launchctl` / `systemd`) and grab the token from `~/Library/Application Support/uvd-helper/config.json` or `$XDG_CONFIG_HOME/uvd-helper/config.json`. Then open `http://127.0.0.1:34899/setup` for the rest. See [`helper/README.md`](./helper/README.md) for full helper docs.

### 2. Install the userscript

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. **Chromium 138+ (Chrome, Edge, Brave, Opera):** open `chrome://extensions` (or the equivalent for your browser), find the Tampermonkey card, and flip **"Allow User Scripts"** on. Without this, Tampermonkey will not execute userscripts at all.
3. Open the raw script URL — Tampermonkey will offer to install it:
   https://raw.githubusercontent.com/BarnsL/universal-video-download/main/universal-video-download.user.js
4. Reload any tab where you want it (e.g. `youtube.com`).

### 3. Paste the token

1. On any supported site, press **`Ctrl+Shift+D`** to open the dialog (or click the circular FAB bottom-right).
2. Click **⚙️ Settings**.
3. **Paste** (Ctrl+V — the installer put the token in your clipboard). Click **Test** to confirm, then **Save**.
4. Done. The status badge in the footer reads **"helper running"**.

That's it. Click any stream → **Download** → a green toast pops at the bottom and the file goes into the queue. Click **📋 Queue** to watch progress bars, retry/cancel jobs, pause the whole queue, or clear finished ones. Files land in `~/Downloads/uvd/` (or wherever the helper's `config.json` `downloadDir` points).

> If you skip step 1 the userscript still works on most non-YouTube sites via the browser's direct download flow. For YouTube without the helper you'll get a `yt-dlp` command copied to your clipboard that you have to paste into a terminal yourself. That's the v2.4 fallback path — functional but not what you want long-term.

---

## Repo layout

```
universal-video-download.user.js   ← the userscript itself (Tampermonkey)
helper/
  uvd-helper.py                    ← the daemon — Python stdlib only
  install.ps1                      ← Windows installer (winget + Startup launcher + token)
  README.md                        ← helper-specific docs (API, security, troubleshooting)
README.md                          ← you are here
BUGS.md                            ← every bug fixed, why, and how
LICENSE
```

Both halves are deliberately small: one .js file, one .py file, plus a thin installer.

---

## Highlights

- **Real download queue, not a click-and-wait dialog.** Click Download on as many streams as you like; each one is enqueued and runs under a concurrency cap. The dialog stays open so you can keep selecting.
- **Slow-network smarts.** Default 2 concurrent jobs / 2 per host (keeps YouTube anti-bot quiet), 3 retries with exponential backoff (30s → 60s → 120s), and a free-disk guard that pauses new jobs when the volume is nearly full.
- **Survives crashes / reboots.** Job state is persisted to `jobs.json` on every transition. Anything that was running when the helper died comes back queued on next start.
- **Universal detection.** Scans every page for `<video>` and `<source>` elements and intercepts XHR / `fetch` / `createElement` calls so segment URLs from MSE-fed players still get captured.
- **Full YouTube extractor.** Reads `ytInitialPlayerResponse` directly from the player and surfaces every progressive stream, every DASH video / audio rep, every caption track. Signature-encrypted streams are downloaded via the helper's `yt-dlp` shell-out — no clipboard ping-pong.
- **NewPipe-grade quality / codec parity.** Resolution, FPS (HFR), HDR, container (MP4 / WebM / MKV / 3GP / OGG), codec (H.264 / VP9 / AV1 / H.265 / Dolby), bitrate, estimated size.
- **Multi-track audio.** All audio reps grouped by track ID, with bitrate, sample rate, channels and language label.
- **Subtitles.** Every caption track on YouTube; `<track>` element scrape on generic sites. Auto-generated tracks are clearly labeled.
- **Floating action button** with a live badge that increments as more media URLs are captured.
- **Keyboard shortcut.** `Ctrl+Shift+D` opens the dialog anywhere, on any page.
- **Site auto-tagging.** Recognises YouTube, Vimeo, Dailymotion, Twitch, Twitter/X, Reddit, Facebook, Instagram, TikTok; falls back to the host name otherwise.
- **YouTube action-bar button.** A blue **Download** button is injected next to Like/Share on watch pages.
- **Copy URL / Copy All URLs.** Hand off to `yt-dlp`, `aria2c`, `ffmpeg`, IDM, or any external tool with one click — useful even when the helper is doing the heavy lifting.

---

## Permissions used by the userscript

| Grant | Why |
| --- | --- |
| `GM_download` | Save selected streams via the browser download manager |
| `GM_addStyle` | Inject the dialog stylesheet without touching site CSS |
| `GM_xmlhttpRequest` | Fetch cross-origin manifests/segments without CORS errors |
| `GM_getValue` / `GM_setValue` | Persist the thread-count preference between sessions |
| `@connect *` | Allow `GM_xmlhttpRequest` to reach any host (needed because media CDNs are different per site) |
| `@run-at document-idle` | Wait until the page settles before scanning, so SPAs have populated their player state |

---

## Usage

### Floating action button
A circular button appears in the bottom-right corner of every supported site. The dot in the corner of the FAB is the **helper status indicator** — green when the helper is reachable, slate when it isn't. The badge above the FAB shows how many distinct media URLs have been captured so far. Click to open the dialog.

### Keyboard shortcut
`Ctrl+Shift+D` opens the download dialog anywhere, even before any video is detected. Useful for sites that lazy-load players after a scroll or click.

### YouTube action-bar button
On `youtube.com/watch` and `/shorts/`, a blue **Download** button is injected next to the Like/Share buttons. Same behavior as the FAB.

### The dialog

Three tabs:
- **Video** — Progressive (muxed audio+video) streams, then adaptive video-only streams sorted by resolution and FPS. Badges flag `NO SOUND`, `HDR`, `HFR`, `COMBINED`.
- **Audio** — All audio reps grouped by language track. Sample rate, channels, codec, bitrate, estimated size.
- **Subtitles** — Every caption track. Auto-generated tracks are tagged `AUTO`. SRT is generated client-side from YouTube's timed-text XML.

Footer controls:
- **⚙️ Settings** — Open the helper-token panel and live helper status. Includes a **Test** button to verify auth.
- **📋 Queue** — Open the queue panel: per-job status, progress bar, speed, ETA, retry count; per-row Cancel / Retry; header controls for Pause queue / Clear done.
- **Filename** — Pre-sanitised from the page title; editable.
- **Threads** — 1-8 parallel connections for the in-browser fallback path (helper-managed downloads are paced by the daemon's queue caps instead).
- **Copy URL** — Copy the selected stream's direct URL.
- **Copy All URLs** — Copy a newline-delimited list of every URL on the active tab.
- **Download** — Queue the selected stream. If the helper is reachable and the token is set, the dialog stays open and a green toast confirms the queue add. Otherwise the script falls back to the browser download manager (or copies a `yt-dlp` command on YouTube cipher streams).

### Queueing many streams at once

With the helper running, the recommended flow for batch downloads is:

1. Press `Ctrl+Shift+D` on a watch page.
2. Click **Download** on each stream you want — the dialog doesn't close.
3. Repeat across as many tabs as you like.
4. Click **📋 Queue** to monitor.

The helper respects `maxConcurrent` and `maxConcurrentPerHost` so it never spawns more `yt-dlp` processes than your network or YouTube's anti-bot tolerates, retries transient failures with exponential backoff, and persists the queue across helper restarts.

---

## Supported sites

The script always falls back to generic detection, so most sites work even if they aren't listed. Sites with first-class extractors or recognizers:

YouTube · Vimeo · Dailymotion · Twitch · Twitter/X · Reddit · Facebook · Instagram · TikTok

Any other host is labelled with its domain (e.g. `bbc.co.uk`).

### How detection works

1. **YouTube fast path** — Reads `window.ytInitialPlayerResponse` (with fallbacks to `ytplayer.config.args` and a script-tag scan), parses `streamingData.formats` and `streamingData.adaptiveFormats`, and enumerates `captions.playerCaptionsTracklistRenderer.captionTracks`. Cipher URLs are surfaced via the `signatureCipher`/`cipher` fallback (note: signature-decryption is NOT performed — see Limitations).
2. **DOM scan** — `document.querySelectorAll('video')`, `<source>` children, `currentSrc`, plus `<iframe>` embeds for YouTube/Vimeo/generic player URLs.
3. **Network interceptor** — `XMLHttpRequest.prototype.open`, `window.fetch`, and `document.createElement` are wrapped so any URL ending in a media extension (`.mp4`, `.webm`, `.m3u8`, `.mpd`, `.ts`, `.m4s`, `.mp3`, `.m4a`, `.ogg`, `.flac`, `.mkv`, `.avi`) or matching common patterns (`/videoplayback`, `/manifest/`, `mime=video`, `itag=`, etc.) is captured into a deduplicated set.
4. **`<track>` scrape** — Generic subtitle support pulls any `<track kind="subtitles|captions">` from detected video elements.

---

## Limitations

- **DRM** — Netflix, Disney+, Hulu, Prime Video, HBO Max and any other Widevine/PlayReady-protected content **cannot** be downloaded. The script will not pretend otherwise.
- **YouTube signature decryption** — Some DASH streams require the `signatureCipher` to be decrypted with a per-session JS function. The script exposes the underlying URL but does **not** decrypt it. For those, click **Copy URL** and pass it to [`yt-dlp`](https://github.com/yt-dlp/yt-dlp), which handles cipher resolution server-side.
- **Blob / MediaSource URLs** — When a `<video>` is fed via MSE (Media Source Extensions), `video.src` is a `blob:` URL that points at an in-memory buffer rather than a network resource. The dialog notes this and relies on the network interceptor to capture the underlying segment URLs as they're fetched.
- **HLS / DASH manifests** — Captured but not muxed. Pass them to `yt-dlp`, `ffmpeg -i <url>`, or `N_m3u8DL-RE` for offline assembly.
- **Cross-origin iframes** — The script can't reach into a cross-origin iframe (browser security boundary). It surfaces the iframe URL so you can open it in its own tab and run the script there.
- **Per-site scraping** — Beyond YouTube, no site-specific extractor exists. If a site obfuscates its player, generic detection plus the network interceptor is what you get.

---

## Architecture

```
[Browser tab]                                  [localhost 127.0.0.1:34899]
  Tampermonkey                                   uvd-helper.py
  └─ userscript                                  ├─ HTTP server (HTTP/1.0)
     ├─ dialog UI (streams + queue panel)        ├─ Queue dispatcher thread
     ├─ POST /download  ──────────────────────▶  ├─ Worker threads (yt-dlp)
     ├─ POST /queue/pause | resume | clear  ──▶  ├─ jobs.json persistence
     ├─ GET /queue (800ms while panel open) ◀──  └─ /setup HTML page
     └─ GET /health  (on init + dialog open) ◀──
```

The userscript is a single IIFE with these labelled sections:

```
TRUSTED TYPES       Passthrough TrustedHTML policy (BUG-003 fix) so YouTube's
                    require-trusted-types-for CSP doesn't kill innerHTML writes
HELPER BRIDGE       gmFetch() wrapping GM_xmlhttpRequest, detectHelper(),
                    helperStartDownload(), helperJobStatus(), helperCancelJob()
CONFIGURATION       FAB visibility, scan interval, supportedSites regexes
STYLES              GM_addStyle — FAB, overlay, dialog, tabs, queue panel, toast
UTILITIES           Byte/duration formatting, codec/container/extension detection
NETWORK INTERCEPTOR XHR + fetch + createElement wrappers; deduplicated media URLs
DOM DETECTOR        Walks <video>, <source>, currentSrc, <iframe> embeds
YOUTUBE EXTRACTOR   Reads ytInitialPlayerResponse + caches /youtubei/v1/player
                    responses for SPA navigations (BUG-002 fix)
GENERIC BUILDER     Same stream shape, populated from DOM + interceptor
DIALOG              Tabs, stream rows, footer controls (Settings + Queue)
QUEUE UI            showQueueToast, pollQueueOnce, openQueuePanel
DOWNLOAD            Helper POST /download path, then fallback to GM_download
                    or yt-dlp clipboard command on YouTube cipher streams
BOOTSTRAP           FAB, autoDetect interval, Ctrl+Shift+D, YT SPA observer
```

The helper is a single Python stdlib file with three threads:

```
main         HTTPServer.serve_forever (request handlers)
dispatcher   queue_dispatcher_loop — claims free slots, spawns workers
workers      run_job_worker (one per active job) — yt-dlp + retry logic
```

State lives in `JOBS` (dict of `Job` keyed by id), guarded by `JOBS_CV`
(a `threading.Condition`). The dispatcher waits on the CV; the workers
notify it on every status transition. `persist_jobs()` writes `jobs.json`
atomically (`.tmp` + `os.replace`) on every transition so a crashed
helper resumes cleanly on next start.

---

## Configuration

### Helper (`%LOCALAPPDATA%\uvd-helper\config.json` on Windows; per-OS paths in [`helper/README.md`](./helper/README.md))

```jsonc
{
  "token":                  "<64 hex chars; do not share>",
  "port":                   34899,
  "downloadDir":            "C:\\Users\\you\\Downloads\\uvd",

  // Queue / retry knobs (v1.1.0+)
  "maxConcurrent":          2,   // total concurrent yt-dlp jobs
  "maxConcurrentPerHost":   2,   // per-host cap; youtube.com/youtu.be share one bucket
  "maxRetries":             3,   // transient failures retry this many times
  "retryBackoffSeconds":    30,  // exponential: 30s, 60s, 120s, ...
  "minFreeDiskMB":          200  // skip starting new jobs when free space < this
}
```

Edit and restart the Startup `.vbs` (or reboot — it auto-runs at login) to apply.

### Userscript (`CONFIG` block at the top of `universal-video-download.user.js`)

```js
const CONFIG = {
    defaultThreads: 4,           // thread slider initial value (browser fallback only)
    maxThreads: 8,               // upper bound on the slider
    showFloatingButton: true,    // hide the FAB and rely on the shortcut only
    autoDetectInterval: 3000,    // ms between FAB visibility re-checks
    interceptNetworkRequests: true,
    supportedSites: { /* host regexes */ }
};
```

The thread-count preference is persisted via `GM_setValue('uvd_threads', n)` and restored on the next page load. The helper token is stored under `GM_setValue('helperToken', ...)` after you paste it.

---

## Recommended companion tools

For streams the userscript cannot mux or decrypt itself:

- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** — Use **Copy URL** for YouTube cipher streams: `yt-dlp "<url>"`.
- **[ffmpeg](https://ffmpeg.org/)** — Mux video-only + audio-only into a single MP4: `ffmpeg -i video.mp4 -i audio.m4a -c copy out.mp4`.
- **[aria2c](https://aria2.github.io/)** — Multi-segment downloader for HLS/DASH manifests.
- **[N_m3u8DL-RE](https://github.com/nilaoda/N_m3u8DL-RE)** — Excellent HLS/DASH downloader on Windows.

---

## Browser support

| Browser | Status |
| --- | --- |
| Chrome / Chromium / Edge | ✅ Tested |
| Firefox | ✅ Tested |
| Brave / Opera / Vivaldi | ✅ Should work (Chromium-based) |
| Safari | ⚠️ Tampermonkey on Safari has reduced `GM_*` support; `GM_download` may fall back to a save-as dialog |

---

## Privacy & security

- **No telemetry, no analytics, no remote calls.** The userscript talks to two endpoints: the media hosts the page already serves, and `http://127.0.0.1:34899/*` (the helper) when it's installed.
- **Helper is 127.0.0.1-only.** Other machines on your LAN can't reach it.
- **64-hex-char token.** Required on every authed helper request. Compared with `secrets.compare_digest` (constant-time). Stored at mode `0600` on POSIX. Pasted into the userscript once via Settings → stored in Tampermonkey's encrypted GM storage.
- **Origin whitelist on the helper.** Authed requests must come from one of the supported sites' origins (or `localhost`). Even if a hostile tab learns the token, it can't trigger a download unless its `Origin` matches.
- **CSP-strict `/setup` page.** `default-src 'none'`; no fonts or remote assets. The page just shows the token and copy/install buttons.
- **No shell on the helper.** `yt-dlp` is invoked via list argv through `subprocess.Popen` — no injection surface.

Full helper threat model + endpoint reference: [`helper/README.md`](./helper/README.md).

---

## Contributing

Issues and pull requests are welcome on the [BarnsL/universal-video-download](https://github.com/BarnsL/universal-video-download) repository.

When adding a site-specific extractor, follow the YouTube pattern:
1. Detect the host with a regex in `CONFIG.supportedSites`.
2. Read the player's state object (`window.__INITIAL_STATE__`, `window.playerData`, etc.) directly from the page.
3. Populate the canonical `{ progressive, adaptiveVideo, adaptiveAudio, subtitles }` shape so the generic dialog renderer just works.

---

## License

[MIT](./LICENSE) © 2026 BarnsL
