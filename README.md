# Universal Video Download

A Tampermonkey userscript + tiny localhost daemon that brings **NewPipe-style** downloads to **every site that plays video**, including YouTube's signature-encrypted streams. Pick resolution, container, codec, audio track, subtitles and parallel-thread count from a clean dark dialog. The Download button just works end-to-end — file lands on disk, progress bar lives in the dialog.

---

## Quick start (do this in order)

The userscript can't run `yt-dlp` on its own — the browser sandbox blocks process execution. The helper daemon is what closes the gap. **Install the helper first, then the userscript, then paste the token. The userscript will look broken on YouTube until all three steps are done.**

### 1. Install and start the helper (~30 seconds)

**Windows:**

```powershell
# Clone or download the repo, then from its root:
.\helper\install.ps1
```

The installer ensures Python 3.10+, yt-dlp, and ffmpeg are installed (via winget), drops `uvd-helper.py` into `%LOCALAPPDATA%\uvd-helper\`, sets up auto-start at login via a Startup-folder `.vbs` launcher, runs the daemon now, prints a `/health` check, and **copies the access token to your clipboard**. Keep the clipboard untouched for step 3.

**macOS / Linux:** no installer yet — run `python3 helper/uvd-helper.py` in a terminal (or wire it into launchctl/systemd) and grab the token from `~/Library/Application Support/uvd-helper/config.json` or `$XDG_CONFIG_HOME/uvd-helper/config.json`. See [`helper/README.md`](./helper/README.md) for the full helper docs.

### 2. Install the userscript

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. **Chromium 138+ (Chrome, Edge, Brave, Opera):** open `chrome://extensions` (or the equivalent for your browser), find the Tampermonkey card, and flip **"Allow User Scripts"** on. Without this, Tampermonkey will not execute userscripts at all.
3. Open the raw script URL — Tampermonkey will offer to install it:
   https://raw.githubusercontent.com/BarnsL/universal-video-download/main/universal-video-download.user.js
4. Reload any tab where you want it (e.g. youtube.com).

### 3. Paste the token

1. On any supported site, press **`Ctrl+Shift+D`** to open the dialog (or click the circular FAB bottom-right).
2. Click **⚙️ Settings**.
3. **Paste** (Ctrl+V — the installer put the token in your clipboard). Click **Test** to confirm, then **Save**.
4. Done. The status badge in the footer now reads **"helper running"**.

That's it. Click any stream → **Download** → progress bar appears → file lands at `~/Downloads/uvd/` (or wherever the helper's `config.json` `downloadDir` points).

> If you skip step 1 the userscript still works on most non-YouTube sites via the browser's download manager. For YouTube without the helper you'll get a `yt-dlp` command copied to your clipboard that you have to paste into a terminal yourself. That's the v2.4 fallback path — functional but not what you want long-term.

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

- **Universal detection** — Scans every page for `<video>` and `<source>` elements and intercepts XHR/`fetch`/element-creation calls to capture media URLs in real time.
- **Full YouTube extractor** — Pulls `ytInitialPlayerResponse` directly from the player and exposes every progressive stream, every DASH video/audio rep, every caption track.
- **Quality and codec parity with NewPipe** — Surfaces resolution, FPS (HFR), HDR, container (MP4/WebM/MKV/3GP/OGG), codec (H.264, VP9, AV1, H.265/HEVC, Dolby), bitrate and estimated size.
- **Multi-track audio** — All audio reps grouped by track ID, with bitrate, sample rate, channels and language label.
- **Subtitles** — Every caption track on YouTube; `<track>` element scrape on generic sites. Auto-generated tracks are clearly labeled.
- **Parallel downloads** — Adjustable thread slider (1-8) for the underlying `GM_download`.
- **Floating action button** with a live badge that increments as more media URLs are captured.
- **Keyboard shortcut** — `Ctrl+Shift+D` opens the dialog anywhere, on any page.
- **Site auto-tagging** — Recognizes YouTube, Vimeo, Dailymotion, Twitch, Twitter/X, Reddit, Facebook, Instagram, TikTok, falls back to the host name otherwise.
- **YouTube action-bar button** — A blue **Download** button is injected next to Like/Share on watch pages.
- **Copy URL / Copy All URLs** — Hand off to `yt-dlp`, `aria2c`, `ffmpeg`, IDM, or any external tool with one click.

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
A circular button appears in the bottom-right corner whenever the script detects video on the page. The badge shows how many distinct media URLs have been captured so far. Click to open the dialog.

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
- **Filename** — Pre-sanitized from the page title; editable.
- **Threads** — 1-8 parallel connections. Saved with `GM_setValue`.
- **Copy URL** — Copy the selected stream's direct URL.
- **Copy All URLs** — Copy a newline-delimited list of every URL on the active tab.
- **Download** — Save the selected stream with the chosen filename via `GM_download`.

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

The userscript is a single IIFE with these labelled sections:

```
CONFIGURATION       Defaults: thread count, FAB visibility, scan interval, supportedSites regexes
STYLES              Injected via GM_addStyle — FAB, overlay, dialog, tabs, stream rows, badges
UTILITIES           Byte/duration formatting, codec/container/extension detection, filename sanitizer
NETWORK INTERCEPTOR XHR + fetch + createElement wrappers; deduplicated media-URL set
DOM DETECTOR        Walks <video>, <source>, currentSrc, <iframe> embeds
YOUTUBE EXTRACTOR   Reads ytInitialPlayerResponse, builds progressive/adaptiveVideo/adaptiveAudio/subtitles
GENERIC BUILDER     Same shape, populated from DOM + interceptor
DIALOG              Tabs, stream rows, footer controls; thread preference persisted via GM_setValue
DOWNLOAD            GM_download with sanitized filename + extension; subtitle XML→SRT conversion
BOOTSTRAP           Floating button, autoDetect interval, keyboard shortcut, YouTube action-bar injection
```

All state lives inside the IIFE — no globals are leaked. The `capturedMediaUrls` `Set` is the single source of truth for everything captured at runtime.

---

## Configuration

Edit the `CONFIG` object at the top of the userscript:

```js
const CONFIG = {
    defaultThreads: 4,           // initial thread slider value
    maxThreads: 8,               // upper bound on the slider
    showFloatingButton: true,    // hide the FAB and rely on the shortcut only
    autoDetectInterval: 3000,    // ms between FAB visibility re-checks
    interceptNetworkRequests: true,
    supportedSites: { /* host regexes */ }
};
```

The thread-count preference is persisted via `GM_setValue('uvd_threads', n)` and restored on the next page load.

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

## Privacy

The script runs entirely in your browser. No telemetry, no analytics, no remote calls beyond the media URLs you explicitly download. It does **not** send anything to any server other than the media hosts the page already talks to.

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
