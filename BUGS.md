# Known Bugs — Universal Video Download

## BUG-001: Close button non-functional on YouTube (and other CSP-strict sites)

**Reported:** 2026-06-01
**Fixed:** 2026-06-01 (commit `23f503e`)
**Status:** CLOSED
**Severity:** UX-blocking
**Affected function:** `showEmptyDialog()` (line ~595 area)

### Symptom
Clicking the "Close" button in the "No Streams Detected" dialog does nothing.

### Root Cause
The bottom "Close" button uses an **inline `onclick` attribute**:
```html
<button class="uvd-btn uvd-btn-primary" onclick="document.getElementById('uvd-overlay').remove()">Close</button>
```

YouTube (and many modern sites) enforce a strict Content Security Policy (CSP) that blocks inline event handlers (`onclick`, `onmouseover`, etc.) on dynamically injected DOM elements. The `#uvd-close` X button at the top-right works because it uses `addEventListener`, but the bottom "Close" button does not.

### Fix
Replace the inline `onclick` with an `addEventListener` binding (same pattern as `#uvd-close` and `#uvd-rescan`):

```js
// In showEmptyDialog(), change the Close button HTML to:
<button class="uvd-btn uvd-btn-primary" id="uvd-close-btn">Close</button>

// Then add the event listener:
overlay.querySelector('#uvd-close-btn').addEventListener('click', removeDialog);
```

### Status
**CLOSED** — fixed in commit `23f503e`.

---

## BUG-002: YouTube extractor fails on SPA navigations (no streams found)

**Reported:** 2026-06-01
**Fixed:** 2026-06-01 (commit `23f503e`)
**Status:** CLOSED (Option A implemented — see commit)
**Severity:** Critical (core feature broken on primary target site)
**Affected function:** `extractYouTubeStreams()` (line ~300 area)

### Symptom
Clicking the download button on a YouTube watch page shows "No Streams Detected" with "Captured network requests: 0", even though a video is actively playing.

### Root Cause
YouTube is a **Single Page Application (SPA)**. The extractor uses three methods:

1. `window.ytInitialPlayerResponse` — Only populated on **initial full page load**. Not updated on SPA navigation.
2. `window.ytplayer?.config?.args` — Deprecated YouTube API path, rarely populated.
3. Script-tag scan for `ytInitialPlayerResponse` — Only finds data embedded in `<script>` tags from the initial page render; SPA navigations never write new script tags.

When a user navigates within YouTube (clicking a video from search, playlist auto-advance, sidebar recommendations, radio mixes like `&start_radio=1`), YouTube fetches the player data via XHR (`/youtubei/v1/player`) and feeds it directly to its internal JS player. **None of the three methods pick this up.**

This explains why the script "sometimes works" (hard refresh or direct URL paste = initial load) but usually doesn't (any in-app navigation).

### Potential Fixes (in order of reliability)

**Option A — Intercept the `/youtubei/v1/player` API response:**
```js
// In the network interceptor, add special handling for YouTube's player API:
const origFetch = window.fetch;
window.fetch = async function(input, init) {
    const response = await origFetch.apply(this, arguments);
    const url = typeof input === 'string' ? input : input?.url;
    if (url && url.includes('/youtubei/v1/player')) {
        const clone = response.clone();
        clone.json().then(data => {
            if (data?.streamingData) {
                window.__uvd_playerResponse = data;
            }
        }).catch(() => {});
    }
    return response;
};
```
Then in `extractYouTubeStreams()`, add as Method 0:
```js
if (window.__uvd_playerResponse?.streamingData) {
    playerResponse = window.__uvd_playerResponse;
}
```

**Option B — Use YouTube's internal player API:**
```js
const player = document.querySelector('#movie_player');
if (player && player.getPlayerResponse) {
    playerResponse = player.getPlayerResponse();
}
// or
if (player && player.getVideoData) {
    const vd = player.getVideoData();
    // reconstruct from player internals...
}
```
Note: `getPlayerResponse()` may not exist in all YouTube builds.

**Option C — Re-request the player endpoint ourselves:**
```js
// Make our own /youtubei/v1/player POST with the video ID
// Requires extracting the video ID from the URL and spoofing the innertube context
```
Most complex, but most reliable.

### Recommended approach
**Option A** is cleanest — minimal code, leverages existing interceptor pattern, no reliance on undocumented player methods.

### Status
**CLOSED** — Option A landed (fetch + XHR interceptors populate `window.__uvd_ytPlayerResponse`, consumed as Method 0 in `extractYouTubeStreams()`).

---

## BUG-003: Trusted Types CSP halts the entire script on YouTube

**Reported:** 2026-06-21
**Fixed:** 2026-06-21 (v2.3)
**Status:** CLOSED
**Severity:** Critical (no FAB, no button, no `Ctrl+Shift+D`, total silence on YouTube)
**Affected function:** `createFab()`, `showDialog()`, `showEmptyDialog()`, `injectYouTubeButton()` — anything that writes to `innerHTML`

### Symptom
After installing the script and enabling "Allow User Scripts" in `brave://extensions` (or Chrome equivalent), the userscript appears Enabled in Tampermonkey but produces nothing on a YouTube watch page. DevTools console shows:

```
This document requires 'TrustedHTML' assignment. The action has been blocked.
createFab @ universal-video-download.user.js:1361
Uncaught (in promise) TypeError: Failed to set the 'innerHTML' property on 'Element':
  This document requires 'TrustedHTML' assignment.
```

### Root cause
YouTube serves the header

```
Content-Security-Policy: require-trusted-types-for 'script'
```

which forces every `Element.innerHTML` assignment in any script running on the document — including userscripts injected by Tampermonkey — to pass a `TrustedHTML` instance, not a raw string. Raw assignment throws synchronously.

`createFab()` is the very first DOM write during init. Its uncaught throw aborts the rest of the IIFE, so no listeners, no FAB, no `Ctrl+Shift+D` handler — total silence. The user can't even tell whether the script loaded.

Trusted Types are shipped in Chromium (Chrome, Edge, Brave, Opera) and being adopted by more sites every quarter (Google properties, GitHub, parts of Microsoft). Firefox does not implement them yet, which is why the script worked there before this fix.

### Fix
Declare a passthrough Trusted Types policy once at IIFE entry and route every `innerHTML` write through a `setHTML(el, html)` helper:

```js
let uvdTrustedHTML = null;
if (window.trustedTypes && window.trustedTypes.createPolicy) {
    try {
        uvdTrustedHTML = window.trustedTypes.createPolicy('uvd-policy', {
            createHTML: (s) => s
        });
    } catch (e) { /* name collision / blocked — fall back below */ }
}
function setHTML(el, html) {
    el.innerHTML = uvdTrustedHTML ? uvdTrustedHTML.createHTML(html) : html;
}
```

Replace every `el.innerHTML = ` with `setHTML(el, ...)`. There are only 4 sites: 2 in `showDialog`, 1 in `createFab`, 1 in `injectYouTubeButton`.

### Why the passthrough is safe
Every HTML string we feed `setHTML()` is a static template literal authored in this file. We never interpolate attacker-controlled data into HTML — the few interpolations (`streams.title`, `streams.author`) come from YouTube's own player response, which is already trusted by the page. If untrusted input is ever interpolated into a template that flows through `setHTML()`, swap `createHTML` for a sanitizer (DOMPurify or manual escape).

### Why not avoid innerHTML entirely?
We could rewrite the dialog as `createElement` + `appendChild`, but the dialog template is ~80 lines of dense markup. A passthrough policy + 4 call-site changes is far less code to maintain and produces identical output.

### Notes for future maintainers
- The policy name `uvd-policy` must be unique per document. If another script claims it first, `createPolicy` throws and `setHTML` falls back to raw assignment (which will then fail on CSP-strict sites — visible in the console, not silent).
- If a future YouTube/Google policy adds `trusted-types 'allow-duplicates'` restrictions, you may need to nest under an existing default policy. Check the Trusted Types spec.
- Pages without Trusted Types support (Firefox today) hit the raw-assignment branch and work fine — there is no CSP to violate.

---

## BUG-004: YouTube DASH streams are signature-encrypted; no direct download from the browser

**Reported:** 2026-06-21
**Mitigated:** 2026-06-21 (v2.4)
**Status:** MITIGATED (full fix is fundamentally out of scope — see below)
**Severity:** Functional gap (the script detects streams but can't save them)
**Affected function:** `performDownload()`, `extractCipherUrl()`

### Symptom
After v2.3 fixed Trusted Types and the dialog opens correctly on YouTube, clicking **Download** on most adaptive video or audio streams hits an alert that reads *"No direct download URL available."* The stream is detected and listed, but pressing Download does nothing useful.

### Root cause
Modern YouTube ships adaptive streams (the `adaptiveFormats` array in the player response) without a plain `url` field. Instead, each format object contains either:

- `signatureCipher`: a URL-encoded blob containing `s` (an encrypted signature), `sp` (the query-param name to put the decrypted signature into, usually `sig` or `sig2`), and `url` (the base URL).
- A plain `url` that is *almost* playable but whose query string contains an `n` parameter that has been throttled. Requests with the original `n` succeed at a few hundred KB/s; requests with a deobfuscated `n` succeed at full speed.

To produce a working download URL the script would have to:

1. Fetch YouTube's per-version JS player (`base.js`).
2. Parse it to locate the `s`-decryption function (usually a chain of array reverses, splices, and swaps) and the `n`-deobfuscation function (a much hairier JS expression).
3. Re-implement both in the userscript's sandbox and apply them to each format.

yt-dlp does exactly this, and the extractor breaks every few weeks when YouTube ships a new player version. Tracking it from a single-file userscript is not realistic.

`extractCipherUrl()` in the script does the easy part — `URLSearchParams(cipher).get('url')` — but the `url` it returns is the *base* URL with no signature appended, so playback servers reject it. The function returns an empty string in practice on modern YouTube.

### Mitigation (v2.4)
Instead of dead-ending with a useless alert when `url` is empty, the script now builds a ready-to-run `yt-dlp` command using the stream's `itag` plus the current watch URL, copies it to the clipboard, and tells the user to paste it into a terminal.

- Added `data-itag="..."` to the four stream-item template literals so the itag survives into the DOM where `performDownload()` can read it.
- In `performDownload()`, the no-URL branch now:
  - Strips `&list=…` / `&t=…` etc. off the current URL so yt-dlp sees a clean watch URL.
  - For `video-only` adaptive streams, formats as `-f <itag>+bestaudio --merge-output-format mp4` (so the user actually ends up with playable video, not silent video).
  - For progressive / audio / subtitle types, just `-f <itag>`.
  - Pipes the command through `navigator.clipboard.writeText`; falls back to `prompt()` if clipboard is blocked.
- The alert tells the user it's been copied and points at `winget install yt-dlp` for setup.

### Why this is the right ceiling
- yt-dlp is the canonical, maintained, frequently-updated implementation of YouTube extraction. Re-implementing a subset of it in this script would create a second thing that breaks every few weeks.
- The userscript is most valuable on non-YouTube sites where direct download via `<video>`, `<source>`, or intercepted manifests Just Works. For YouTube it's a sophisticated detector + a one-click handoff.
- If you do want to attempt cipher decryption later, look at the `_decipher` and `_descramble_n` helpers in `yt_dlp/extractor/youtube/_video.py` — they're the canonical reference.

### Notes for users
- Once `yt-dlp` is installed, the entire workflow is: click Download → paste in PowerShell → file lands in your CWD.
- If `yt-dlp -U` reports the extractor is broken on a given day, that's YouTube changing things; wait for the next yt-dlp release. The userscript does not need to be re-installed.

---

## Notes

- Both bugs are in the single file `universal-video-download.user.js`
- The script is "NewPipe-style" but unlike NewPipe (which makes its own HTTP requests to YouTube's API), this script relies on reading the page's own player state — which is fragile on SPAs
- The README already acknowledges signature decryption as a limitation, but the SPA navigation issue is a more fundamental problem that affects ALL streams (not just cipher-protected ones)
- The network interceptor (`capturedMediaUrls` / `capturedStreams`) SHOULD in theory capture `/videoplayback` URLs, but YouTube's modern player may use MSE (Media Source Extensions) feeding blob URLs, or the interceptor may fire before the script's wrapper is installed
