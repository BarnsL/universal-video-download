# Known Bugs — Universal Video Download

## BUG-001: Close button non-functional on YouTube (and other CSP-strict sites)

**Reported:** 2026-06-01  
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
**OPEN** — needs fix in userscript.

---

## BUG-002: YouTube extractor fails on SPA navigations (no streams found)

**Reported:** 2026-06-01  
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
**OPEN** — needs fix in userscript. This is the higher priority bug since it makes the script fundamentally broken on YouTube for most user flows.

---

## Notes

- Both bugs are in the single file `universal-video-download.user.js`
- The script is "NewPipe-style" but unlike NewPipe (which makes its own HTTP requests to YouTube's API), this script relies on reading the page's own player state — which is fragile on SPAs
- The README already acknowledges signature decryption as a limitation, but the SPA navigation issue is a more fundamental problem that affects ALL streams (not just cipher-protected ones)
- The network interceptor (`capturedMediaUrls` / `capturedStreams`) SHOULD in theory capture `/videoplayback` URLs, but YouTube's modern player may use MSE (Media Source Extensions) feeding blob URLs, or the interceptor may fire before the script's wrapper is installed
