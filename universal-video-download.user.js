// ==UserScript==
// @name         Universal Video Download (NewPipe-Style)
// @namespace    http://tampermonkey.net/
// @version      2.8.6
// @description  Detects video elements on any website and offers full NewPipe-style download options (resolution, format, codec, audio tracks, subtitles, thread count)
// @author       BarnsL
// @updateURL    https://raw.githubusercontent.com/BarnsL/universal-video-download/main/universal-video-download.user.js
// @downloadURL  https://raw.githubusercontent.com/BarnsL/universal-video-download/main/universal-video-download.user.js
// @match        *://*/*
// @grant        GM_download
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      *
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    // ==================== TRUSTED TYPES (BUG-003 fix) ====================
    // YouTube (and a growing list of Google properties, GitHub, etc.) send
    //   Content-Security-Policy: require-trusted-types-for 'script'
    // which makes ANY raw `el.innerHTML = "..."` throw at runtime:
    //   "This document requires 'TrustedHTML' assignment. The action has been blocked."
    // Because our very first DOM write is in createFab() during init, an
    // unhandled throw there halts the whole script — no FAB, no YouTube
    // button, no Ctrl+Shift+D dialog, nothing.
    //
    // Fix: declare a passthrough Trusted Types policy once at boot and route
    // every innerHTML write through setHTML(). The policy name must be unique
    // per document; we use "uvd-policy". On browsers without Trusted Types
    // (Firefox today, older Chromium) trustedTypes is undefined and we fall
    // back to raw assignment, which is harmless because the CSP isn't there.
    //
    // Why a passthrough is safe here: every HTML string we feed setHTML() is
    // a static template literal authored in this file. We never interpolate
    // attacker-controlled data into innerHTML. If that ever changes, swap
    // createHTML to sanitize.
    let uvdTrustedHTML = null;
    if (typeof window !== 'undefined' && window.trustedTypes && window.trustedTypes.createPolicy) {
        try {
            uvdTrustedHTML = window.trustedTypes.createPolicy('uvd-policy', {
                createHTML: (s) => s
            });
        } catch (e) {
            // Policy name already claimed on this document, or page CSP
            // forbids creating new policies. Leave uvdTrustedHTML null and
            // let setHTML() try raw assignment — it will throw and the
            // failure will be visible in the console rather than silent.
        }
    }
    function setHTML(el, html) {
        el.innerHTML = uvdTrustedHTML ? uvdTrustedHTML.createHTML(html) : html;
    }

    // ==================== HELPER BRIDGE (v2.5 — BUG-005) ====================
    // The userscript can't run yt-dlp directly (browser sandbox) and can't
    // decrypt YouTube's signature ciphers (see BUG-004). v2.5 adds a tiny
    // localhost daemon (helper/uvd-helper.py) that does both. The userscript
    // POSTs a download request and polls a job endpoint for progress.
    //
    // Detection: on init we GET /health (unauthenticated). If reachable,
    // the FAB grows a green dot and the download flow uses the helper.
    // If not reachable, everything falls back to v2.4 behavior (clipboard
    // yt-dlp command on YouTube, GM_download elsewhere).
    //
    // Auth: every authed request carries X-UVD-Token. Token is stored via
    // GM_setValue (per-userscript secure storage) and entered once via a
    // settings panel. Helper rejects non-allowlisted Origin headers, so
    // even if a hostile page leaks the token, it can't trigger a download
    // unless it ALSO satisfies the Origin whitelist baked into the helper.
    const HELPER = {
        url: 'http://127.0.0.1:34899',
        // populated by detectHelper(); ui code reads HELPER.alive
        alive: false,
        version: null,
        downloadDir: null,
        tools: null,
        // pollers we need to tear down on dialog close
        activePoll: null,
    };

    function helperGetToken() {
        try { return GM_getValue('helperToken', '') || ''; } catch (e) { return ''; }
    }
    function helperSetToken(t) {
        try { GM_setValue('helperToken', t || ''); } catch (e) {}
    }

    // Tampermonkey's GM_xmlhttpRequest bypasses page CORS, which is critical
    // because YouTube would otherwise block our cross-origin POST to the
    // helper. We promisify it because async/await is much easier to follow
    // than the onload/onerror callback dance.
    function gmFetch(method, path, body, opts) {
        opts = opts || {};
        return new Promise((resolve, reject) => {
            const headers = { 'Content-Type': 'application/json' };
            const token = helperGetToken();
            if (token && !opts.noAuth) headers['X-UVD-Token'] = token;
            GM_xmlhttpRequest({
                method: method,
                url: HELPER.url + path,
                headers: headers,
                data: body == null ? undefined : JSON.stringify(body),
                timeout: opts.timeout || 10000,
                onload: (r) => {
                    let json = null;
                    try { json = r.responseText ? JSON.parse(r.responseText) : {}; } catch (e) {}
                    if (r.status >= 200 && r.status < 300) resolve(json || {});
                    else reject({ status: r.status, body: json || r.responseText });
                },
                onerror: () => reject({ status: 0, body: 'network error' }),
                ontimeout: () => reject({ status: 0, body: 'timeout' }),
                onabort: () => reject({ status: 0, body: 'aborted' }),
            });
        });
    }

    async function detectHelper() {
        // We keep the last error around so the Settings panel can show
        // it. The most common failure modes:
        //   - Tampermonkey blocked the request because @connect doesn't
        //     match 127.0.0.1 (fixed by the explicit @connect entries
        //     in the header above).
        //   - Chromium's Private Network Access requires the helper to
        //     send `Access-Control-Allow-Private-Network: true` on the
        //     preflight (helper does this from v1.0.2 on).
        //   - User hasn't run the installer; helper isn't listening.
        try {
            const h = await gmFetch('GET', '/health', null, { timeout: 2500, noAuth: true });
            HELPER.alive = h && h.status === 'ok';
            HELPER.version = h && h.version;
            HELPER.downloadDir = h && h.downloadDir;
            HELPER.tools = h && h.tools;
            HELPER.lastError = null;
        } catch (e) {
            HELPER.alive = false;
            HELPER.lastError = e && (e.body || e.status === 0 ? 'unreachable (helper not running or @connect blocked)' : `HTTP ${e.status}`);
            // Surface in console too — the Settings panel only shows it
            // after the user opens the dialog.
            try { console.warn('[UVD] helper unreachable:', e); } catch (_) {}
        }
        // Reflect state on the FAB.
        const dot = document.querySelector('#uvd-fab .uvd-helper-dot');
        if (dot) dot.style.background = HELPER.alive ? '#22c55e' : '#64748b';
        return HELPER.alive;
    }

    async function helperStartDownload(payload) {
        return gmFetch('POST', '/download', payload);
    }
    async function helperJobStatus(jobId) {
        return gmFetch('GET', '/jobs/' + jobId);
    }
    async function helperCancelJob(jobId) {
        return gmFetch('GET', '/jobs/' + jobId + '/cancel');
    }
    async function helperOpenDownloadDir() {
        return gmFetch('POST', '/open-download-dir', {});
    }

    // ==================== AUTO-NEXT + EPISODE DISCOVERY (v2.8.0) ====================
    //
    // Adapted from mikutellyourworld/AnimePahe-Streaming-Autoplay-Fix-
    // TamperMonkey-Script (animepahe-autonext-v2.user.js). The original
    // is animepahe-specific; this version is URL-pattern based so it
    // works on wcoanimedub.tv (e.g. .../my-dress-up-darling-episode-7-
    // english-dubbed → .../my-dress-up-darling-episode-8-english-dubbed)
    // and any other site whose episode pages contain a `-episode-N-`
    // segment.
    //
    // Two features ride on the same detector:
    //   1. "▶ Next episode" navigation (+ optional countdown auto-nav)
    //   2. "📥 Queue next N episodes via yt-dlp" — for the downloader
    //      use case, send N+1..N+K to the helper /download endpoint so
    //      the helper grabs them in the background.
    const AUTONEXT_ENABLED_KEY = 'uvd_autonext_enabled';
    const AUTONEXT_COUNTDOWN_SECONDS = 10;
    // -episode-<digits> with an optional trailing word ("-english-dubbed", "-sub", "-raw")
    const EPISODE_RE = /-episode-(\d+)((?:-[a-z0-9]+)*)(?=\/|$|\?|#)/i;

    function detectEpisodeContext() {
        const m = location.pathname.match(EPISODE_RE);
        if (!m) return null;
        const current = parseInt(m[1], 10);
        if (!Number.isFinite(current) || current < 0) return null;
        return { current, tail: m[2] || '' };
    }

    function buildEpisodeUrl(n) {
        const ctx = detectEpisodeContext();
        if (!ctx) return null;
        const newPath = location.pathname.replace(EPISODE_RE,
            (_full, _num, tail) => `-episode-${n}${tail || ''}`);
        return location.origin + newPath + location.search;
    }

    // Find an explicit "next episode" anchor in the DOM. Pattern
    // borrowed from the mikutellyourworld script — first try a
    // title-attributed link, then any anchor whose own href matches
    // -episode-(N+1)-.
    function findNextEpisodeLink() {
        const el = findNextEpisodeAnchorElement();
        return el ? (el.href || el.getAttribute('href')) : null;
    }

    // Same matching as findNextEpisodeLink but returns the DOM element
    // itself so the button injector can park UVD's button right next
    // to / under the site's existing episode-navigation button.
    function findNextEpisodeAnchorElement() {
        const explicit = document.querySelector(
            'a[title*="Next" i][title*="Episode" i], a[title="Play Next Episode"]'
        );
        if (explicit && (explicit.href || explicit.getAttribute('href'))) return explicit;

        const ctx = detectEpisodeContext();
        if (!ctx) return null;
        const wantN = ctx.current + 1;
        const candidates = Array.from(document.querySelectorAll('a[href]'));
        for (const a of candidates) {
            const m = (a.getAttribute('href') || a.href || '').match(EPISODE_RE);
            if (m && parseInt(m[1], 10) === wantN) return a;
        }
        return null;
    }

    function nextEpisodeUrl() {
        return findNextEpisodeLink() || buildEpisodeUrl(
            (detectEpisodeContext()?.current ?? -1) + 1
        );
    }

    function autonextEnabled() {
        try { return !!GM_getValue(AUTONEXT_ENABLED_KEY, false); }
        catch (e) { return false; }
    }
    function setAutonextEnabled(v) {
        try { GM_setValue(AUTONEXT_ENABLED_KEY, !!v); } catch (e) {}
    }

    // Countdown toast — directly modeled on the animepahe-autonext
    // showCountdown() function. Cancellable; on zero, navigates.
    let _autoNextCountdownTimer = null;
    function startAutonextCountdown(targetUrl) {
        cancelAutonextCountdown();
        if (!targetUrl) return;

        const toast = document.createElement('div');
        toast.id = 'uvd-autonext-toast';
        toast.style.cssText = [
            'position:fixed','bottom:88px','right:24px','z-index:2147483647',
            'background:rgba(15,15,25,.95)','color:#fff',
            'padding:14px 20px','border-radius:10px',
            'font:bold 14px ui-sans-serif, system-ui, -apple-system, sans-serif',
            'box-shadow:0 4px 24px rgba(0,0,0,.6)',
            'display:flex','flex-direction:column','gap:8px',
            'min-width:240px','border:1px solid rgba(99,102,241,.5)',
        ].join(';');

        let remaining = AUTONEXT_COUNTDOWN_SECONDS;
        const label = document.createElement('span');
        label.style.fontSize = '15px';
        label.textContent = `▶ Next episode in ${remaining}s…`;
        toast.appendChild(label);

        const sub = document.createElement('span');
        sub.style.cssText = 'font-size:11px;color:#a5b4fc;word-break:break-all;font-weight:400;';
        sub.textContent = targetUrl;
        toast.appendChild(sub);

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = [
            'background:#d43','color:#fff','border:none','border-radius:5px',
            'padding:5px 14px','cursor:pointer','font-size:13px',
            'font-weight:bold','align-self:flex-end',
        ].join(';');
        cancelBtn.addEventListener('click', () => cancelAutonextCountdown());
        toast.appendChild(cancelBtn);

        document.body.appendChild(toast);

        _autoNextCountdownTimer = setInterval(() => {
            remaining -= 1;
            label.textContent = `▶ Next episode in ${remaining}s…`;
            if (remaining <= 0) {
                cancelAutonextCountdown();
                try { location.href = targetUrl; } catch (e) {}
            }
        }, 1000);
    }

    function cancelAutonextCountdown() {
        if (_autoNextCountdownTimer) {
            clearInterval(_autoNextCountdownTimer);
            _autoNextCountdownTimer = null;
        }
        const t = document.getElementById('uvd-autonext-toast');
        if (t) t.remove();
    }

    // Small persistent toggle in the top-right corner of episode pages.
    // v2.8.2 — split into TWO pills:
    //   left  = "AUTO-NEXT ON/OFF" toggle (persists)
    //   right = "Skip now" — fires the countdown immediately so the
    //           user can move on without waiting for video.ended (the
    //           usual fallback for cross-origin iframe players where
    //           we have no way to know when the video actually ended).
    function maybeMountAutonextBadge() {
        if (!detectEpisodeContext()) return;
        if (document.getElementById('uvd-autonext-wrap')) return;

        const wrap = document.createElement('div');
        wrap.id = 'uvd-autonext-wrap';
        wrap.style.cssText = [
            'position:fixed','top:96px','right:18px','z-index:2147483646',
            'display:flex','gap:6px','align-items:center',
            'font:600 11px ui-sans-serif, system-ui, sans-serif',
            'letter-spacing:.05em',
        ].join(';');

        const toggle = document.createElement('button');
        toggle.id = 'uvd-autonext-badge';
        toggle.title = 'Universal Video Download — Auto-next toggle';

        const skip = document.createElement('button');
        skip.id = 'uvd-autonext-skip';
        skip.title = 'Skip to next episode now (10s countdown)';

        const baseStyle = [
            'padding:6px 12px','border-radius:999px',
            'cursor:pointer','border:1px solid',
            'box-shadow:0 2px 8px rgba(0,0,0,.4)',
            'display:flex','align-items:center','gap:6px',
            'font:inherit',
        ];

        const renderToggle = () => {
            const on = autonextEnabled();
            toggle.style.cssText = baseStyle.concat([
                on ? 'border-color:#22c55e' : 'border-color:#444',
                'background:' + (on ? '#14532d' : '#1a1a1c'),
                'color:' + (on ? '#bbf7d0' : '#aaa'),
            ]).join(';');
            toggle.textContent = on ? '⏭ AUTO-NEXT ON' : '⏸ AUTO-NEXT OFF';
        };
        skip.style.cssText = baseStyle.concat([
            'border-color:#6366f1', 'background:#1e1b4b', 'color:#c7d2fe',
        ]).join(';');
        skip.textContent = '⏩ Skip now';

        toggle.addEventListener('click', () => {
            setAutonextEnabled(!autonextEnabled());
            renderToggle();
            if (autonextEnabled()) {
                const url = nextEpisodeUrl();
                if (url) console.info('[UVD] auto-next armed →', url);
                wireAutonextWatcher();
            } else {
                cancelAutonextCountdown();
            }
        });

        skip.addEventListener('click', () => {
            const url = nextEpisodeUrl();
            if (!url) {
                alert('Could not derive the next-episode URL from this page.');
                return;
            }
            startAutonextCountdown(url);
        });

        wrap.appendChild(toggle);
        wrap.appendChild(skip);
        document.body.appendChild(wrap);
        renderToggle();
    }

    // v2.8.2 — Three independent triggers, race to fire startAutonextCountdown:
    //   A. <video>.ended on any in-page video (works for parent-page players)
    //   B. window.message handler that recognises common
    //      end-of-video payloads broadcast by embed players
    //      (postMessage event names like 'video.ended', 'ended', 'finish',
    //      'complete', 'PLAYER_STATE_CHANGED' / state:0). Reaches into
    //      cross-origin iframes without breaking their CSP — the iframe
    //      just has to be configured to broadcast, which most modern
    //      players do.
    //   C. Manual "Skip now" button on the corner badge — guaranteed
    //      to work even when A and B don't.
    let _autoNextWired = false;
    function wireAutonextWatcher() {
        if (_autoNextWired) return;
        _autoNextWired = true;

        // (A) <video>.ended on any current or future in-page <video>
        const tryWireVideos = () => {
            const videos = document.querySelectorAll('video');
            for (const v of videos) {
                if (v.__uvdAutoNextWired) continue;
                v.__uvdAutoNextWired = true;
                v.addEventListener('ended', () => {
                    if (!autonextEnabled()) return;
                    const url = nextEpisodeUrl();
                    if (url) startAutonextCountdown(url);
                });
            }
        };
        tryWireVideos();
        setInterval(() => { if (autonextEnabled()) tryWireVideos(); }, 3000);

        // (B) postMessage listener. We watch for the patterns common
        // to JWPlayer, Plyr, Video.js, YouTube-style and bespoke embed
        // players. Loose matcher — better to over-fire and let the
        // countdown's Cancel button save the user than to miss it.
        const ENDED_HINTS = /\b(?:ended|finish|complete|onended|video[_-]?end|playback[_-]?end|state[_-]?changed)\b/i;
        const ENDED_STATE_RE = /state\s*[:=]\s*(?:'?ended'?|0)/i;
        window.addEventListener('message', (ev) => {
            if (!autonextEnabled()) return;
            let payload = ev.data;
            try {
                if (typeof payload === 'string') {
                    if (ENDED_HINTS.test(payload) || /["']ended["']/i.test(payload)) {
                        const url = nextEpisodeUrl();
                        if (url) startAutonextCountdown(url);
                        return;
                    }
                    try { payload = JSON.parse(payload); } catch (_) {}
                }
                if (payload && typeof payload === 'object') {
                    const keys = Object.keys(payload).join(' ');
                    const str = JSON.stringify(payload);
                    if (
                        ENDED_HINTS.test(keys) ||
                        ENDED_HINTS.test(payload.event || payload.type || payload.name || '') ||
                        ENDED_STATE_RE.test(str) ||
                        payload.ended === true || payload.complete === true ||
                        payload.playerState === 0 // YT/HTML5-ish
                    ) {
                        const url = nextEpisodeUrl();
                        if (url) startAutonextCountdown(url);
                    }
                }
            } catch (_) {}
        }, { passive: true });
    }

    // Queue the next K episodes through the helper. Used by the
    // "📥 Queue next N" button in the dialog when the helper is alive.
    async function queueNextEpisodes(k) {
        const ctx = detectEpisodeContext();
        if (!ctx) return { queued: 0, error: 'no episode pattern in URL' };
        const titleBase = (document.title || location.hostname).replace(/episode\s*\d+/i, '').trim();
        const results = [];
        for (let i = 1; i <= k; i++) {
            const n = ctx.current + i;
            const u = buildEpisodeUrl(n);
            if (!u) continue;
            const payload = {
                url: u,
                type: 'video',
                ext: 'mp4',
                filename: sanitizeFilename(`${titleBase} - Episode ${n}`),
            };
            try {
                const job = await helperStartDownload(payload);
                results.push(job && job.id);
            } catch (e) {
                results.push(null);
            }
        }
        return { queued: results.filter(Boolean).length, total: k };
    }

    // ==================== CONFIGURATION ====================
    const CONFIG = {
        defaultThreads: 4,
        maxThreads: 8,
        showFloatingButton: true,
        autoDetectInterval: 3000, // ms between scans
        interceptNetworkRequests: true,
        supportedSites: {
            youtube: /youtube\.com|youtu\.be/,
            vimeo: /vimeo\.com/,
            dailymotion: /dailymotion\.com/,
            twitch: /twitch\.tv/,
            twitter: /twitter\.com|x\.com/,
            reddit: /reddit\.com|redd\.it/,
            facebook: /facebook\.com|fb\.watch/,
            instagram: /instagram\.com/,
            tiktok: /tiktok\.com/,
            atoz: /atoz\.amazon\.work/,
            generic: /.*/
        }
    };

    // ==================== STYLES ====================
    GM_addStyle(`
        /* ===== Floating Action Button ===== */
        #uvd-fab {
            position: fixed;
            bottom: 24px;
            right: 24px;
            z-index: 999999;
            width: 56px;
            height: 56px;
            border-radius: 50%;
            background: linear-gradient(135deg, #065fd4, #3ea6ff);
            border: none;
            cursor: pointer;
            box-shadow: 0 4px 16px rgba(6,95,212,0.4);
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            opacity: 0;
            transform: scale(0.8);
            pointer-events: none;
        }
        #uvd-fab.visible {
            opacity: 1;
            transform: scale(1);
            pointer-events: all;
        }
        #uvd-fab:hover {
            transform: scale(1.1);
            box-shadow: 0 6px 24px rgba(6,95,212,0.6);
        }
        #uvd-fab:active {
            transform: scale(0.95);
        }
        #uvd-fab svg {
            width: 26px;
            height: 26px;
            fill: #fff;
        }
        #uvd-fab .uvd-badge {
            position: absolute;
            top: -2px;
            right: -2px;
            background: #ff4444;
            color: #fff;
            font-size: 11px;
            font-weight: 700;
            width: 20px;
            height: 20px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-family: sans-serif;
        }

        /* ===== AtoZ/Rustici Inline Download Button ===== */
        #uvd-atoz-btn {
            position: fixed;
            top: 0;
            right: 10px;
            z-index: 999999;
            padding: 6px 20px;
            background: #232f3e;
            color: #ffffff;
            border: 1px solid #3a4553;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 600;
            font-family: Arial, Helvetica, sans-serif;
            cursor: pointer;
            transition: background 0.15s;
            white-space: nowrap;
        }
        #uvd-atoz-btn:hover {
            background: #3a4a5c;
        }

        /* ===== Overlay & Dialog ===== */
        #uvd-overlay {
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.7);
            backdrop-filter: blur(4px);
            z-index: 9999999;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            transition: opacity 0.25s;
        }
        #uvd-overlay.visible { opacity: 1; }

        #uvd-dialog {
            background: #1a1a1a;
            color: #e0e0e0;
            border-radius: 16px;
            padding: 0;
            width: 600px;
            max-width: 92vw;
            max-height: 88vh;
            overflow: hidden;
            box-shadow: 0 12px 48px rgba(0,0,0,0.7);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            flex-direction: column;
        }

        /* Header */
        .uvd-header {
            padding: 20px 24px 16px;
            border-bottom: 1px solid #2a2a2a;
            position: relative;
        }
        .uvd-header h2 {
            margin: 0 0 4px;
            font-size: 17px;
            color: #fff;
            font-weight: 600;
            padding-right: 32px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .uvd-header .uvd-meta {
            display: flex;
            gap: 14px;
            font-size: 12px;
            color: #888;
        }
        .uvd-header .uvd-meta span {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        #uvd-close {
            position: absolute;
            top: 16px; right: 16px;
            background: #2a2a2a;
            border: none;
            color: #aaa;
            width: 28px; height: 28px;
            border-radius: 50%;
            font-size: 16px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.15s;
        }
        #uvd-close:hover { background: #444; color: #fff; }

        /* Tabs */
        .uvd-tabs {
            display: flex;
            border-bottom: 1px solid #2a2a2a;
            padding: 0 24px;
            background: #1e1e1e;
        }
        .uvd-tab {
            padding: 12px 18px;
            font-size: 13px;
            font-weight: 500;
            color: #888;
            cursor: pointer;
            border-bottom: 2px solid transparent;
            margin-bottom: -1px;
            transition: all 0.2s;
            white-space: nowrap;
        }
        .uvd-tab:hover { color: #ccc; }
        .uvd-tab.active { color: #3ea6ff; border-bottom-color: #3ea6ff; }
        .uvd-tab .uvd-tab-count {
            font-size: 11px;
            background: #333;
            color: #aaa;
            padding: 1px 6px;
            border-radius: 10px;
            margin-left: 6px;
        }
        .uvd-tab.active .uvd-tab-count {
            background: #1a3a5c;
            color: #3ea6ff;
        }

        /* Content */
        .uvd-content {
            flex: 1;
            overflow-y: auto;
            padding: 16px 24px;
        }
        .uvd-section { display: none; }
        .uvd-section.active { display: block; }

        /* Stream Group */
        .uvd-group-label {
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: #666;
            margin: 16px 0 8px 4px;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .uvd-group-label:first-child { margin-top: 0; }

        /* Stream Items */
        .uvd-stream-list {
            list-style: none;
            padding: 0;
            margin: 0;
        }
        .uvd-stream-item {
            display: grid;
            grid-template-columns: 90px 65px 80px 1fr 70px;
            align-items: center;
            padding: 10px 12px;
            margin-bottom: 2px;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.12s;
            border: 1px solid transparent;
        }
        .uvd-stream-item:hover { background: #252525; }
        .uvd-stream-item.selected {
            background: #0d2847;
            border-color: #3ea6ff;
        }
        .uvd-stream-item .uvd-col-quality {
            font-size: 14px;
            font-weight: 600;
            color: #fff;
        }
        .uvd-stream-item .uvd-col-format {
            font-size: 12px;
            color: #aaa;
        }
        .uvd-stream-item .uvd-col-codec {
            font-size: 11px;
            color: #777;
        }
        .uvd-stream-item .uvd-col-extra {
            font-size: 11px;
            color: #666;
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
        }
        .uvd-stream-item .uvd-col-size {
            font-size: 12px;
            color: #3ea6ff;
            text-align: right;
            font-weight: 500;
        }
        .uvd-badge {
            font-size: 10px;
            padding: 2px 6px;
            border-radius: 4px;
            font-weight: 500;
        }
        .uvd-badge-nosound { background: #3d2200; color: #ff9800; }
        .uvd-badge-hdr { background: #1a3d1a; color: #66bb6a; }
        .uvd-badge-hfr { background: #2a1a3d; color: #ab47bc; }
        .uvd-badge-auto { background: #333; color: #aaa; }
        .uvd-badge-combined { background: #1a2a3d; color: #64b5f6; }

        /* Audio Track Selector */
        .uvd-track-selector {
            margin-bottom: 12px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .uvd-track-selector label {
            font-size: 12px;
            color: #888;
        }
        .uvd-track-selector select {
            padding: 6px 12px;
            background: #2a2a2a;
            border: 1px solid #444;
            border-radius: 6px;
            color: #fff;
            font-size: 13px;
            cursor: pointer;
        }
        .uvd-track-selector select:focus {
            outline: none;
            border-color: #3ea6ff;
        }

        /* Footer / Options */
        .uvd-footer {
            padding: 16px 24px;
            border-top: 1px solid #2a2a2a;
            background: #1e1e1e;
        }
        .uvd-options-row {
            display: flex;
            gap: 12px;
            margin-bottom: 12px;
            align-items: flex-end;
        }
        .uvd-option-group {
            flex: 1;
        }
        .uvd-option-group label {
            display: block;
            font-size: 11px;
            color: #888;
            margin-bottom: 4px;
        }
        .uvd-option-group input[type="text"] {
            width: 100%;
            padding: 8px 12px;
            background: #2a2a2a;
            border: 1px solid #3a3a3a;
            border-radius: 6px;
            color: #fff;
            font-size: 13px;
            box-sizing: border-box;
        }
        .uvd-option-group input[type="text"]:focus {
            outline: none;
            border-color: #3ea6ff;
        }

        /* Thread slider */
        .uvd-thread-row {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 14px;
        }
        .uvd-thread-row label {
            font-size: 12px;
            color: #888;
            white-space: nowrap;
        }
        .uvd-thread-row input[type="range"] {
            flex: 1;
            accent-color: #3ea6ff;
            cursor: pointer;
        }
        .uvd-thread-row .uvd-thread-val {
            font-size: 13px;
            color: #3ea6ff;
            font-weight: 600;
            min-width: 20px;
            text-align: center;
        }

        /* Action buttons */
        .uvd-actions {
            display: flex;
            gap: 10px;
            justify-content: flex-end;
        }
        .uvd-btn {
            padding: 10px 24px;
            border: none;
            border-radius: 20px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
        }
        .uvd-btn-primary {
            background: #3ea6ff;
            color: #000;
        }
        .uvd-btn-primary:hover { background: #65b8ff; }
        .uvd-btn-primary:disabled { background: #444; color: #888; cursor: not-allowed; }
        .uvd-btn-secondary {
            background: #333;
            color: #ddd;
        }
        .uvd-btn-secondary:hover { background: #444; }
        .uvd-btn-copy {
            background: transparent;
            color: #3ea6ff;
            border: 1px solid #3ea6ff;
        }
        .uvd-btn-copy:hover { background: #0d2847; }

        /* Loading / Error */
        .uvd-loading {
            text-align: center;
            padding: 48px 24px;
            color: #888;
        }
        .uvd-spinner {
            width: 36px; height: 36px;
            border: 3px solid #333;
            border-top-color: #3ea6ff;
            border-radius: 50%;
            animation: uvd-spin 0.7s linear infinite;
            margin: 0 auto 16px;
        }
        @keyframes uvd-spin { to { transform: rotate(360deg); } }
        .uvd-empty {
            text-align: center;
            padding: 32px;
            color: #666;
            font-size: 13px;
        }

        /* Source indicator */
        .uvd-source-tag {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            font-size: 11px;
            color: #666;
            background: #252525;
            padding: 2px 8px;
            border-radius: 4px;
            margin-left: auto;
        }

        /* Video picker (when multiple videos detected) */
        .uvd-video-picker {
            margin-bottom: 16px;
        }
        .uvd-video-picker select {
            width: 100%;
            padding: 8px 12px;
            background: #2a2a2a;
            border: 1px solid #444;
            border-radius: 6px;
            color: #fff;
            font-size: 13px;
        }

        /* ===== v2.5: helper-bridge UI ===== */
        #uvd-fab .uvd-helper-dot {
            position: absolute;
            bottom: 2px;
            right: 2px;
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: #64748b;
            border: 2px solid #1a1a1a;
            transition: background 0.2s;
        }
        .uvd-gear-btn {
            background: transparent;
            border: 1px solid #444;
            color: #aaa;
            border-radius: 6px;
            padding: 6px 10px;
            cursor: pointer;
            font-size: 13px;
            margin-right: auto; /* push to left in footer */
        }
        .uvd-gear-btn:hover { background: #2a2a2a; color: #fff; }
        .uvd-helper-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-size: 11px;
            padding: 3px 8px;
            border-radius: 999px;
            margin-left: 8px;
        }
        .uvd-helper-badge.alive  { background: #14532d; color: #86efac; }
        .uvd-helper-badge.absent { background: #3f3f3f; color: #aaa; }
        .uvd-helper-badge .uvd-helper-badge-dot {
            width: 6px; height: 6px; border-radius: 50%;
        }
        .uvd-helper-badge.alive  .uvd-helper-badge-dot { background: #22c55e; }
        .uvd-helper-badge.absent .uvd-helper-badge-dot { background: #94a3b8; }
        .uvd-settings-modal {
            position: absolute;
            inset: 0;
            background: rgba(0, 0, 0, 0.85);
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 12px;
            z-index: 10;
        }
        .uvd-settings-panel {
            background: #1f1f1f;
            border: 1px solid #444;
            border-radius: 10px;
            padding: 24px;
            width: 90%;
            max-width: 500px;
        }
        .uvd-settings-panel h3 {
            margin: 0 0 16px 0;
            color: #fff;
            font-size: 16px;
        }
        .uvd-settings-panel label {
            display: block;
            color: #ccc;
            font-size: 12px;
            margin: 12px 0 4px;
        }
        .uvd-settings-panel input {
            font-family: ui-monospace, Consolas, monospace;
        }
        .uvd-settings-panel .uvd-settings-info {
            font-size: 12px;
            color: #888;
            background: #161616;
            border-radius: 6px;
            padding: 10px 12px;
            margin-top: 12px;
            line-height: 1.5;
        }
        .uvd-settings-panel .uvd-settings-info code {
            color: #c4b5fd;
            font-family: ui-monospace, Consolas, monospace;
        }
        .uvd-settings-actions {
            display: flex;
            gap: 8px;
            margin-top: 18px;
            justify-content: flex-end;
        }
        .uvd-progress-view {
            padding: 32px 24px;
        }
        .uvd-progress-view h3 {
            color: #fff;
            margin: 0 0 6px 0;
            font-size: 15px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .uvd-progress-view .uvd-progress-sub {
            color: #888;
            font-size: 12px;
            margin-bottom: 22px;
        }
        .uvd-progress-bar {
            height: 10px;
            background: #2a2a2a;
            border-radius: 999px;
            overflow: hidden;
            margin-bottom: 14px;
        }
        .uvd-progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #6366f1, #a855f7);
            width: 0%;
            transition: width 0.3s ease;
        }
        .uvd-progress-stats {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 14px;
            margin-bottom: 22px;
            font-size: 12px;
        }
        .uvd-progress-stats .uvd-stat-label { color: #888; display: block; margin-bottom: 2px; }
        .uvd-progress-stats .uvd-stat-value { color: #fff; font-weight: 500; font-family: ui-monospace, Consolas, monospace; }
        .uvd-progress-status {
            background: #161616;
            border-radius: 6px;
            padding: 10px 12px;
            margin-bottom: 18px;
            color: #ccc;
            font-size: 12px;
        }
        .uvd-progress-status.error { background: #3f1d1d; color: #fecaca; }
        .uvd-progress-status.done  { background: #14532d; color: #bbf7d0; }
        .uvd-progress-actions {
            display: flex;
            gap: 8px;
            justify-content: flex-end;
        }
        .uvd-progress-log {
            background: #0d0d0d;
            border: 1px solid #2a2a2a;
            border-radius: 6px;
            padding: 10px 12px;
            margin-top: 18px;
            max-height: 140px;
            overflow-y: auto;
            font-family: ui-monospace, Consolas, monospace;
            font-size: 11px;
            color: #888;
            white-space: pre-wrap;
            word-break: break-all;
        }

        /* ===== v2.6.0: queue toast + queue panel ===== */
        .uvd-queue-toast {
            position: absolute;
            left: 50%;
            bottom: 18px;
            transform: translate(-50%, 120%);
            background: #14532d;
            color: #bbf7d0;
            border-radius: 8px;
            padding: 8px 14px;
            font-size: 12px;
            opacity: 0;
            transition: opacity 0.25s ease, transform 0.25s ease;
            display: inline-flex;
            align-items: center;
            gap: 10px;
            white-space: nowrap;
            max-width: 80%;
            overflow: hidden;
            text-overflow: ellipsis;
            box-shadow: 0 4px 16px rgba(0,0,0,0.4);
            z-index: 5;
        }
        .uvd-queue-toast.show {
            opacity: 1;
            transform: translate(-50%, 0);
        }
        .uvd-queue-toast code {
            color: #fff;
            font-family: ui-monospace, Consolas, monospace;
            background: rgba(0,0,0,0.25);
            padding: 1px 6px;
            border-radius: 4px;
            font-size: 11px;
        }
        .uvd-toast-link {
            background: transparent;
            border: 1px solid rgba(187, 247, 208, 0.5);
            color: #bbf7d0;
            border-radius: 6px;
            padding: 3px 10px;
            font-size: 11px;
            cursor: pointer;
        }
        .uvd-toast-link:hover { background: rgba(187, 247, 208, 0.1); }

        .uvd-queue-panel {
            padding: 18px 22px 22px;
        }
        .uvd-queue-head {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 14px;
            gap: 12px;
            flex-wrap: wrap;
        }
        .uvd-queue-head-actions {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
        }
        .uvd-queue-sub {
            color: #888;
            font-size: 12px;
            margin-top: 4px;
        }
        .uvd-queue-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
            max-height: 56vh;
            overflow-y: auto;
            padding-right: 4px;
        }
        .uvd-q-row {
            background: #161616;
            border: 1px solid #2a2a2a;
            border-radius: 8px;
            padding: 10px 12px;
        }
        .uvd-q-row-top {
            display: grid;
            grid-template-columns: max-content 1fr auto;
            gap: 10px;
            align-items: center;
        }
        .uvd-q-status {
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            font-family: ui-monospace, Consolas, monospace;
            letter-spacing: 0.05em;
        }
        .uvd-q-name {
            color: #ddd;
            font-size: 12px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .uvd-q-actions { display: inline-flex; gap: 6px; }
        .uvd-q-btn {
            background: transparent;
            color: #aaa;
            border: 1px solid #444;
            border-radius: 5px;
            padding: 3px 9px;
            font-size: 11px;
            cursor: pointer;
        }
        .uvd-q-btn:hover { background: #2a2a2a; color: #fff; }
        .uvd-q-bar {
            margin-top: 8px;
            height: 4px;
            background: #2a2a2a;
            border-radius: 999px;
            overflow: hidden;
        }
        .uvd-q-fill {
            height: 100%;
            transition: width 0.3s ease;
        }
        .uvd-q-meta {
            color: #888;
            font-size: 11px;
            margin-top: 6px;
            font-family: ui-monospace, Consolas, monospace;
        }
    `);

    // ==================== UTILITIES ====================
    function formatBytes(bytes) {
        if (!bytes || bytes <= 0) return '~';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
        return (bytes / 1073741824).toFixed(2) + ' GB';
    }

    function formatDuration(sec) {
        if (!sec || sec <= 0) return '';
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = Math.floor(sec % 60);
        if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
        return `${m}:${String(s).padStart(2,'0')}`;
    }

    function getCodecName(mime) {
        if (!mime) return '';
        const m = mime.match(/codecs="([^"]+)"/);
        if (!m) return '';
        const c = m[1];
        if (c.startsWith('avc1')) return 'H.264';
        if (c.startsWith('av01')) return 'AV1';
        if (c.startsWith('vp9') || c.startsWith('vp09')) return 'VP9';
        if (c.startsWith('hev1') || c.startsWith('hvc1')) return 'H.265/HEVC';
        if (c.startsWith('mp4a')) return 'AAC';
        if (c.startsWith('opus')) return 'Opus';
        if (c.startsWith('vorbis')) return 'Vorbis';
        if (c.startsWith('flac')) return 'FLAC';
        if (c.startsWith('ec-3') || c.startsWith('ac-3')) return 'Dolby';
        return c.split('.')[0];
    }

    function getContainer(mime) {
        if (!mime) return '';
        if (mime.includes('mp4')) return 'MP4';
        if (mime.includes('webm')) return 'WebM';
        if (mime.includes('3gpp')) return '3GP';
        if (mime.includes('ogg')) return 'OGG';
        if (mime.includes('mpeg')) return 'MPEG';
        if (mime.includes('matroska') || mime.includes('mkv')) return 'MKV';
        if (mime.includes('flv')) return 'FLV';
        if (mime.includes('m3u8') || mime.includes('x-mpegURL')) return 'HLS';
        if (mime.includes('dash') || mime.includes('mpd')) return 'DASH';
        return mime.split('/')[1]?.split(';')[0] || '';
    }

    function getFileExtension(mime, container) {
        if (container === 'WebM') return 'webm';
        if (container === 'MP4') return 'mp4';
        if (container === '3GP') return '3gp';
        if (container === 'OGG') return 'ogg';
        if (container === 'MKV') return 'mkv';
        if (container === 'FLV') return 'flv';
        if (mime?.includes('audio/mp4') || mime?.includes('m4a')) return 'm4a';
        if (mime?.includes('audio/webm')) return 'webm';
        if (mime?.includes('audio/ogg')) return 'ogg';
        return 'mp4';
    }

    function sanitizeFilename(name) {
        return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().substring(0, 200);
    }

    function estimateSize(bitrate, duration) {
        if (!bitrate || !duration) return 0;
        return Math.round((bitrate * duration) / 8);
    }

    function getSiteName() {
        const host = location.hostname.replace('www.', '');
        for (const [name, regex] of Object.entries(CONFIG.supportedSites)) {
            if (name !== 'generic' && regex.test(host)) return name;
        }
        return host;
    }

    // ==================== NETWORK INTERCEPTOR ====================
    // Captures media URLs from network requests
    const capturedMediaUrls = new Set();
    const capturedStreams = [];

    if (CONFIG.interceptNetworkRequests) {
        // Intercept XHR
        const origXHROpen = XMLHttpRequest.prototype.open;
        const origXHRSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url) {
            this.__uvd_url = url;
            if (url && typeof url === 'string') {
                checkMediaUrl(url, 'xhr');
            }
            return origXHROpen.apply(this, arguments);
        };
        // BUG-002 FIX: Also capture YouTube player API responses via XHR
        XMLHttpRequest.prototype.send = function() {
            if (this.__uvd_url && this.__uvd_url.includes('/youtubei/v1/player')) {
                this.addEventListener('load', function() {
                    try {
                        const data = JSON.parse(this.responseText);
                        if (data?.streamingData) {
                            window.__uvd_ytPlayerResponse = data;
                        }
                    } catch(e) {}
                });
            }
            return origXHRSend.apply(this, arguments);
        };

        // Intercept fetch
        const origFetch = window.fetch;
        window.fetch = function(input, init) {
            const url = typeof input === 'string' ? input : input?.url;
            if (url) checkMediaUrl(url, 'fetch');

            // BUG-002 FIX: Intercept YouTube's player API responses on SPA navigations
            // to capture streamingData that ytInitialPlayerResponse misses
            if (url && url.includes('/youtubei/v1/player')) {
                return origFetch.apply(this, arguments).then(response => {
                    const clone = response.clone();
                    clone.json().then(data => {
                        if (data?.streamingData) {
                            window.__uvd_ytPlayerResponse = data;
                        }
                    }).catch(() => {});
                    return response;
                });
            }
            return origFetch.apply(this, arguments);
        };

        // Intercept createElement for script/source elements
        const origCreateElement = document.createElement.bind(document);
        document.createElement = function(tag) {
            const el = origCreateElement(tag);
            if (tag.toLowerCase() === 'source' || tag.toLowerCase() === 'video') {
                const origSetAttribute = el.setAttribute.bind(el);
                el.setAttribute = function(name, value) {
                    if (name === 'src' && value) checkMediaUrl(value, 'element');
                    return origSetAttribute(name, value);
                };
            }
            return el;
        };
    }

    function checkMediaUrl(url, source) {
        try {
            const lower = url.toLowerCase();
            const mediaExts = ['.mp4', '.webm', '.m3u8', '.mpd', '.ts', '.m4s', '.mp3', '.m4a', '.ogg', '.flac', '.mkv', '.avi'];
            const mediaPatterns = ['/videoplayback', '/manifest/', 'mime=video', 'mime=audio', 'itag=', 'audio_quality', 'video_quality'];

            const isMedia = mediaExts.some(ext => lower.includes(ext)) ||
                           mediaPatterns.some(p => lower.includes(p)) ||
                           /\.(mp4|webm|m3u8|mpd|ts|m4s|flv|avi|mkv|mp3|m4a|ogg|aac|flac|opus)(\?|$)/i.test(url);

            if (isMedia && !capturedMediaUrls.has(url)) {
                capturedMediaUrls.add(url);

                // Categorize
                const isAudio = /audio|\.mp3|\.m4a|\.ogg|\.aac|\.flac|\.opus/i.test(url);
                const isManifest = /\.m3u8|\.mpd|manifest/i.test(url);

                capturedStreams.push({
                    url: url,
                    type: isManifest ? 'manifest' : (isAudio ? 'audio' : 'video'),
                    source: source,
                    timestamp: Date.now()
                });

                updateFabBadge();
            }
        } catch(e) {}
    }

    // ==================== VIDEO ELEMENT DETECTOR ====================
    function detectVideoElements() {
        const videos = [];

        // Find all <video> elements
        document.querySelectorAll('video').forEach((video, idx) => {
            const sources = [];

            // Direct src
            if (video.src && !video.src.startsWith('blob:')) {
                sources.push({ url: video.src, type: video.type || guessType(video.src) });
            }

            // <source> children
            video.querySelectorAll('source').forEach(src => {
                if (src.src && !src.src.startsWith('blob:')) {
                    sources.push({ url: src.src, type: src.type || guessType(src.src) });
                }
            });

            // currentSrc
            if (video.currentSrc && !video.currentSrc.startsWith('blob:') && !sources.find(s => s.url === video.currentSrc)) {
                sources.push({ url: video.currentSrc, type: guessType(video.currentSrc) });
            }

            // Blob URL detection — check for MediaSource
            if (video.src && video.src.startsWith('blob:')) {
                sources.push({ url: video.src, type: 'blob', note: 'Blob/MediaSource (streams captured separately)' });
            }

            videos.push({
                element: video,
                index: idx,
                sources: sources,
                duration: video.duration || 0,
                width: video.videoWidth || video.width || 0,
                height: video.videoHeight || video.height || 0,
                poster: video.poster || '',
                currentTime: video.currentTime || 0
            });
        });

        // Find <iframe> embedded players (note: can't access cross-origin)
        document.querySelectorAll('iframe[src*="youtube"], iframe[src*="vimeo"], iframe[src*="player"]').forEach(iframe => {
            videos.push({
                element: iframe,
                index: videos.length,
                sources: [{ url: iframe.src, type: 'embed' }],
                isEmbed: true,
                duration: 0,
                width: iframe.width || 0,
                height: iframe.height || 0
            });
        });

        return videos;
    }

    function guessType(url) {
        if (!url) return '';
        const lower = url.toLowerCase();
        if (lower.includes('.mp4')) return 'video/mp4';
        if (lower.includes('.webm')) return 'video/webm';
        if (lower.includes('.m3u8')) return 'application/x-mpegURL';
        if (lower.includes('.mpd')) return 'application/dash+xml';
        if (lower.includes('.mp3')) return 'audio/mpeg';
        if (lower.includes('.m4a')) return 'audio/mp4';
        if (lower.includes('.ogg')) return 'audio/ogg';
        if (lower.includes('.flv')) return 'video/x-flv';
        return 'video/mp4';
    }

    // ==================== YOUTUBE EXTRACTOR ====================
    // BUG-002: This extractor ONLY works on initial full page loads.
    // YouTube is an SPA — navigating between videos (clicking links, playlist
    // auto-advance, radio mixes) fetches player data via XHR to /youtubei/v1/player
    // and NEVER updates window.ytInitialPlayerResponse or injects new <script> tags.
    // All 3 methods below fail silently on SPA navigations, causing "No Streams Detected".
    //
    // FIX: Intercept fetch() calls to /youtubei/v1/player and cache the response.
    // See BUGS.md (BUG-002, Option A) for implementation details.
    function extractYouTubeStreams() {
        if (!CONFIG.supportedSites.youtube.test(location.hostname)) return null;
        if (location.pathname !== '/watch' && !location.pathname.startsWith('/shorts/')) return null;

        let playerResponse = null;

        // Method 0: Intercepted player API response (works on SPA navigations)
        if (window.__uvd_ytPlayerResponse?.streamingData) {
            playerResponse = window.__uvd_ytPlayerResponse;
        }

        // Method 1: ytInitialPlayerResponse
        if (!playerResponse && window.ytInitialPlayerResponse?.streamingData) {
            playerResponse = window.ytInitialPlayerResponse;
        }

        // Method 2: ytplayer
        if (!playerResponse && window.ytplayer?.config?.args) {
            try {
                playerResponse = JSON.parse(window.ytplayer.config.args.raw_player_response);
            } catch(e) {}
        }

        // Method 3: scan scripts
        if (!playerResponse) {
            for (const script of document.querySelectorAll('script')) {
                const text = script.textContent;
                if (text.includes('ytInitialPlayerResponse')) {
                    const match = text.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;/s);
                    if (match) {
                        try { playerResponse = JSON.parse(match[1]); } catch(e) {}
                    }
                }
            }
        }

        if (!playerResponse?.streamingData) return null;

        const sd = playerResponse.streamingData;
        const vd = playerResponse.videoDetails || {};
        const captions = playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

        const result = {
            site: 'youtube',
            title: vd.title || document.title.replace(' - YouTube', ''),
            author: vd.author || '',
            duration: parseInt(vd.lengthSeconds) || 0,
            videoId: vd.videoId || '',
            thumbnail: vd.thumbnail?.thumbnails?.slice(-1)[0]?.url || '',
            progressive: [],
            adaptiveVideo: [],
            adaptiveAudio: [],
            subtitles: []
        };

        // Progressive (muxed) streams
        for (const fmt of (sd.formats || [])) {
            result.progressive.push({
                url: fmt.url || extractCipherUrl(fmt.signatureCipher || fmt.cipher),
                quality: fmt.qualityLabel || `${fmt.height}p`,
                mimeType: fmt.mimeType || '',
                container: getContainer(fmt.mimeType),
                codec: getCodecName(fmt.mimeType),
                bitrate: fmt.bitrate || 0,
                width: fmt.width || 0,
                height: fmt.height || 0,
                fps: fmt.fps || 30,
                size: parseInt(fmt.contentLength) || estimateSize(fmt.bitrate, result.duration),
                hasAudio: true,
                itag: fmt.itag
            });
        }

        // Adaptive formats
        for (const fmt of (sd.adaptiveFormats || [])) {
            const stream = {
                url: fmt.url || extractCipherUrl(fmt.signatureCipher || fmt.cipher),
                mimeType: fmt.mimeType || '',
                container: getContainer(fmt.mimeType),
                codec: getCodecName(fmt.mimeType),
                bitrate: fmt.bitrate || 0,
                size: parseInt(fmt.contentLength) || estimateSize(fmt.bitrate, result.duration),
                itag: fmt.itag,
                indexRange: fmt.indexRange,
                initRange: fmt.initRange
            };

            if (fmt.mimeType?.startsWith('video/')) {
                stream.quality = fmt.qualityLabel || `${fmt.height}p`;
                stream.width = fmt.width || 0;
                stream.height = fmt.height || 0;
                stream.fps = fmt.fps || 30;
                stream.hasAudio = false;
                stream.hdr = fmt.colorInfo?.primaries === 'COLOR_PRIMARIES_BT2020' || fmt.qualityLabel?.includes('HDR');
                result.adaptiveVideo.push(stream);
            } else if (fmt.mimeType?.startsWith('audio/')) {
                stream.quality = fmt.bitrate ? Math.round(fmt.bitrate / 1000) + ' kbps' : 'unknown';
                stream.audioQuality = fmt.audioQuality || '';
                stream.sampleRate = fmt.audioSampleRate || '';
                stream.channels = fmt.audioChannels || 2;
                stream.audioTrackId = fmt.audioTrack?.id || 'default';
                stream.audioTrackName = fmt.audioTrack?.displayName || 'Default';
                stream.isDefault = fmt.audioTrack?.audioIsDefault !== false;
                stream.loudnessDb = fmt.loudnessDb;
                result.adaptiveAudio.push(stream);
            }
        }

        // Subtitles
        for (const track of captions) {
            result.subtitles.push({
                url: track.baseUrl,
                language: track.name?.simpleText || track.languageCode,
                languageCode: track.languageCode,
                isAutoGenerated: track.kind === 'asr',
                isTranslatable: track.isTranslatable
            });
        }

        // Sort
        result.progressive.sort((a, b) => (b.height || 0) - (a.height || 0));
        result.adaptiveVideo.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.fps || 0) - (a.fps || 0));
        result.adaptiveAudio.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

        return result;
    }

    function extractCipherUrl(cipher) {
        if (!cipher) return '';
        try {
            const params = new URLSearchParams(cipher);
            return params.get('url') || '';
        } catch(e) { return ''; }
    }

    // ==================== GENERIC STREAM BUILDER ====================
    function buildGenericStreams() {
        const videos = detectVideoElements();
        const title = document.title.replace(/\s*[-|–]\s*$/, '').trim() || 'video';

        const result = {
            site: getSiteName(),
            title: title,
            author: location.hostname,
            duration: 0,
            progressive: [],
            adaptiveVideo: [],
            adaptiveAudio: [],
            subtitles: [],
            detected: videos,
            captured: [...capturedStreams]
        };

        // From detected video elements
        for (const video of videos) {
            if (video.duration > result.duration) result.duration = video.duration;

            for (const src of video.sources) {
                if (src.type === 'blob' || src.type === 'embed') continue;
                if (!src.url) continue;

                const container = getContainer(src.type);
                const isAudio = src.type?.startsWith('audio/');

                const stream = {
                    url: src.url,
                    mimeType: src.type,
                    container: container || 'MP4',
                    codec: getCodecName(src.type),
                    bitrate: 0,
                    size: 0,
                    quality: video.height ? `${video.height}p` : 'Original',
                    width: video.width,
                    height: video.height,
                    fps: 0,
                    hasAudio: !isAudio,
                    source: 'element'
                };

                if (isAudio) {
                    result.adaptiveAudio.push(stream);
                } else {
                    result.progressive.push(stream);
                }
            }
        }

        // From captured network requests
        for (const cap of capturedStreams) {
            // Skip manifests and duplicates
            if (cap.type === 'manifest') continue;

            const container = getContainer(cap.url);
            const stream = {
                url: cap.url,
                mimeType: '',
                container: container || 'MP4',
                codec: '',
                bitrate: 0,
                size: 0,
                quality: 'Captured',
                hasAudio: cap.type !== 'audio',
                source: 'network'
            };

            if (cap.type === 'audio') {
                result.adaptiveAudio.push(stream);
            } else {
                // Try to extract quality from URL params
                const urlObj = new URL(cap.url, location.href);
                const itag = urlObj.searchParams.get('itag');
                if (itag) stream.quality = `itag ${itag}`;

                result.progressive.push(stream);
            }
        }

        // Check for <track> subtitle elements
        for (const video of videos) {
            if (!video.element) continue;
            video.element.querySelectorAll('track[kind="subtitles"], track[kind="captions"]').forEach(track => {
                if (track.src) {
                    result.subtitles.push({
                        url: track.src,
                        language: track.label || track.srclang || 'Unknown',
                        languageCode: track.srclang || '',
                        isAutoGenerated: false
                    });
                }
            });
        }

        return result;
    }

    // ==================== DIALOG BUILDER ====================
    function showDialog() {
        // Try YouTube first
        let streams = extractYouTubeStreams();

        // Fall back to generic detection
        if (!streams) {
            streams = buildGenericStreams();
        }

        // Check if we have anything
        const totalStreams = streams.progressive.length + streams.adaptiveVideo.length +
                           streams.adaptiveAudio.length + streams.subtitles.length;

        if (totalStreams === 0) {
            showEmptyDialog();
            return;
        }

        renderDialog(streams);
    }

    function renderDialog(streams) {
        removeDialog();

        const videoCount = streams.progressive.length + streams.adaptiveVideo.length;
        const audioCount = streams.adaptiveAudio.length;
        const subCount = streams.subtitles.length;

        const overlay = document.createElement('div');
        overlay.id = 'uvd-overlay';
        // setHTML() wraps the template through the Trusted Types policy so
        // YouTube's require-trusted-types-for CSP doesn't block this write.
        setHTML(overlay, `
            <div id="uvd-dialog">
                <div class="uvd-header">
                    <h2 title="${streams.title}">⬇️ ${streams.title}</h2>
                    <div class="uvd-meta">
                        ${streams.author ? `<span>👤 ${streams.author}</span>` : ''}
                        ${streams.duration ? `<span>⏱ ${formatDuration(streams.duration)}</span>` : ''}
                        <span class="uvd-source-tag">🌐 ${streams.site || getSiteName()}</span>
                    </div>
                    <button id="uvd-close">✕</button>
                </div>

                <div class="uvd-tabs">
                    <div class="uvd-tab active" data-tab="video">
                        Video <span class="uvd-tab-count">${videoCount}</span>
                    </div>
                    <div class="uvd-tab" data-tab="audio">
                        Audio <span class="uvd-tab-count">${audioCount}</span>
                    </div>
                    <div class="uvd-tab" data-tab="subtitles">
                        Subtitles <span class="uvd-tab-count">${subCount}</span>
                    </div>
                </div>

                <div class="uvd-content">
                    <div class="uvd-section active" data-section="video">
                        ${renderVideoSection(streams)}
                    </div>
                    <div class="uvd-section" data-section="audio">
                        ${renderAudioSection(streams)}
                    </div>
                    <div class="uvd-section" data-section="subtitles">
                        ${renderSubtitleSection(streams)}
                    </div>
                </div>

                <div class="uvd-footer">
                    <div class="uvd-options-row">
                        <div class="uvd-option-group" style="flex:2;">
                            <label>Filename</label>
                            <input type="text" id="uvd-filename" value="${sanitizeFilename(streams.title)}">
                        </div>
                    </div>
                    <div class="uvd-thread-row">
                        <label>Download threads:</label>
                        <input type="range" id="uvd-threads" min="1" max="${CONFIG.maxThreads}" value="${CONFIG.defaultThreads}">
                        <span class="uvd-thread-val" id="uvd-thread-display">${CONFIG.defaultThreads}</span>
                    </div>
                    <div class="uvd-actions">
                        <button class="uvd-gear-btn" id="uvd-settings" title="Helper settings">⚙️ Settings
                            <span class="uvd-helper-badge ${HELPER.alive ? 'alive' : 'absent'}" id="uvd-helper-badge">
                                <span class="uvd-helper-badge-dot"></span>
                                ${HELPER.alive ? 'helper running' : 'no helper'}
                            </span>
                        </button>
                        <button class="uvd-gear-btn" id="uvd-view-queue" title="Open the queue panel" style="margin-right: 0;">📋 Queue</button>
                        <button class="uvd-btn uvd-btn-copy" id="uvd-copy-url">📋 Copy URL</button>
                        <button class="uvd-btn uvd-btn-secondary" id="uvd-copy-all">📦 Copy All URLs</button>
                        <button class="uvd-btn uvd-btn-primary" id="uvd-download-btn">⬇️ Download</button>
                    </div>
                </div>
            </div>
        `);

        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add('visible'));

        // === Event bindings ===

        // Close
        overlay.addEventListener('click', e => { if (e.target === overlay) removeDialog(); });
        overlay.querySelector('#uvd-close').addEventListener('click', removeDialog);
        document.addEventListener('keydown', escHandler);

        // Tabs
        overlay.querySelectorAll('.uvd-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                overlay.querySelectorAll('.uvd-tab').forEach(t => t.classList.remove('active'));
                overlay.querySelectorAll('.uvd-section').forEach(s => s.classList.remove('active'));
                tab.classList.add('active');
                overlay.querySelector(`[data-section="${tab.dataset.tab}"]`).classList.add('active');
            });
        });

        // Stream selection
        overlay.querySelectorAll('.uvd-stream-item').forEach(item => {
            item.addEventListener('click', () => {
                const section = item.closest('.uvd-section');
                section.querySelectorAll('.uvd-stream-item').forEach(i => i.classList.remove('selected'));
                item.classList.add('selected');
            });
        });

        // Default selections
        overlay.querySelectorAll('.uvd-section').forEach(section => {
            const first = section.querySelector('.uvd-stream-item');
            if (first) first.classList.add('selected');
        });

        // Thread slider
        const threadSlider = overlay.querySelector('#uvd-threads');
        const threadDisplay = overlay.querySelector('#uvd-thread-display');
        threadSlider.addEventListener('input', () => {
            threadDisplay.textContent = threadSlider.value;
        });

        // Settings (helper config)
        overlay.querySelector('#uvd-settings').addEventListener('click', () => {
            openSettingsModal(overlay);
        });

        // Queue panel
        const qBtn = overlay.querySelector('#uvd-view-queue');
        if (qBtn) qBtn.addEventListener('click', () => openQueuePanel(overlay));

        // Refresh helper badge whenever the dialog opens — the helper may
        // have come up since the last detection (e.g. user just ran the
        // installer).
        detectHelper().then(() => updateHelperBadge(overlay));

        // Download
        overlay.querySelector('#uvd-download-btn').addEventListener('click', () => {
            const selected = overlay.querySelector('.uvd-section.active .uvd-stream-item.selected');
            if (!selected) return;
            performDownload(selected, overlay);
        });

        // Copy URL
        overlay.querySelector('#uvd-copy-url').addEventListener('click', () => {
            const selected = overlay.querySelector('.uvd-section.active .uvd-stream-item.selected');
            if (!selected) return;
            const url = selected.dataset.url;
            if (url) {
                navigator.clipboard.writeText(url).then(() => {
                    const btn = overlay.querySelector('#uvd-copy-url');
                    btn.textContent = '✅ Copied!';
                    setTimeout(() => btn.textContent = '📋 Copy URL', 2000);
                });
            }
        });

        // Copy All URLs
        overlay.querySelector('#uvd-copy-all').addEventListener('click', () => {
            const urls = [];
            overlay.querySelectorAll('.uvd-section.active .uvd-stream-item').forEach(item => {
                if (item.dataset.url) urls.push(item.dataset.url);
            });
            if (urls.length) {
                navigator.clipboard.writeText(urls.join('\n')).then(() => {
                    const btn = overlay.querySelector('#uvd-copy-all');
                    btn.textContent = '✅ Copied!';
                    setTimeout(() => btn.textContent = '📦 Copy All URLs', 2000);
                });
            }
        });
    }

    function renderVideoSection(streams) {
        let html = '';

        if (streams.progressive.length > 0) {
            html += `<div class="uvd-group-label">📦 Combined (video + audio) <span class="uvd-badge uvd-badge-combined">muxed</span></div>`;
            html += '<ul class="uvd-stream-list">';
            for (const s of streams.progressive) {
                const ext = getFileExtension(s.mimeType, s.container);
                const badges = [];
                if (s.fps > 30) badges.push(`<span class="uvd-badge uvd-badge-hfr">${s.fps}fps</span>`);
                html += `
                    <li class="uvd-stream-item" data-url="${s.url || ''}" data-itag="${s.itag || ''}" data-ext="${ext}" data-type="video">
                        <span class="uvd-col-quality">${s.quality || 'Original'}</span>
                        <span class="uvd-col-format">${s.container || ext.toUpperCase()}</span>
                        <span class="uvd-col-codec">${s.codec || ''}</span>
                        <span class="uvd-col-extra">${badges.join('')}</span>
                        <span class="uvd-col-size">${formatBytes(s.size)}</span>
                    </li>`;
            }
            html += '</ul>';
        }

        if (streams.adaptiveVideo.length > 0) {
            html += `<div class="uvd-group-label">🎞️ Video-only (DASH/Adaptive) <span class="uvd-badge uvd-badge-nosound">no sound</span></div>`;
            html += '<ul class="uvd-stream-list">';
            for (const s of streams.adaptiveVideo) {
                const ext = getFileExtension(s.mimeType, s.container);
                const badges = [];
                if (s.fps > 30) badges.push(`<span class="uvd-badge uvd-badge-hfr">${s.fps}fps</span>`);
                if (s.hdr) badges.push(`<span class="uvd-badge uvd-badge-hdr">HDR</span>`);
                html += `
                    <li class="uvd-stream-item" data-url="${s.url || ''}" data-itag="${s.itag || ''}" data-ext="${ext}" data-type="video-only">
                        <span class="uvd-col-quality">${s.quality}</span>
                        <span class="uvd-col-format">${s.container}</span>
                        <span class="uvd-col-codec">${s.codec}</span>
                        <span class="uvd-col-extra">${badges.join('')}</span>
                        <span class="uvd-col-size">${formatBytes(s.size)}</span>
                    </li>`;
            }
            html += '</ul>';
        }

        if (!streams.progressive.length && !streams.adaptiveVideo.length) {
            html = '<div class="uvd-empty">No video streams detected yet.<br><small>Try playing the video first — streams will be captured.</small></div>';
        }

        return html;
    }

    function renderAudioSection(streams) {
        if (!streams.adaptiveAudio.length) {
            return '<div class="uvd-empty">No audio-only streams available</div>';
        }

        let html = '';

        // Group by audio track (for multi-language)
        const trackGroups = {};
        for (const s of streams.adaptiveAudio) {
            const key = s.audioTrackId || 'default';
            if (!trackGroups[key]) trackGroups[key] = { name: s.audioTrackName || 'Default', streams: [] };
            trackGroups[key].streams.push(s);
        }

        const trackKeys = Object.keys(trackGroups);
        if (trackKeys.length > 1) {
            html += `<div class="uvd-track-selector">
                <label>🌐 Audio Track:</label>
                <select id="uvd-audio-track">
                    ${trackKeys.map(k => `<option value="${k}">${trackGroups[k].name}</option>`).join('')}
                </select>
            </div>`;
        }

        html += '<ul class="uvd-stream-list">';
        for (const s of streams.adaptiveAudio) {
            const ext = getFileExtension(s.mimeType, s.container);
            const extras = [];
            if (s.sampleRate) extras.push(`${s.sampleRate}Hz`);
            if (s.channels && s.channels > 2) extras.push(`${s.channels}ch`);
            if (s.loudnessDb) extras.push(`${s.loudnessDb.toFixed(1)}dB`);

            html += `
                <li class="uvd-stream-item" data-url="${s.url || ''}" data-itag="${s.itag || ''}" data-ext="${ext}" data-type="audio" data-track="${s.audioTrackId || 'default'}">
                    <span class="uvd-col-quality">${s.quality}</span>
                    <span class="uvd-col-format">${s.container}</span>
                    <span class="uvd-col-codec">${s.codec}</span>
                    <span class="uvd-col-extra">${extras.join(' · ')}</span>
                    <span class="uvd-col-size">${formatBytes(s.size)}</span>
                </li>`;
        }
        html += '</ul>';

        return html;
    }

    function renderSubtitleSection(streams) {
        if (!streams.subtitles.length) {
            return '<div class="uvd-empty">No subtitles/captions available for this video</div>';
        }

        let html = '<ul class="uvd-stream-list">';
        for (const s of streams.subtitles) {
            const label = s.isAutoGenerated ? s.language : s.language;
            const badge = s.isAutoGenerated ? '<span class="uvd-badge uvd-badge-auto">auto</span>' : '';
            const srtUrl = s.url ? (s.url.includes('?') ? s.url + '&fmt=srv3' : s.url) : '';

            html += `
                <li class="uvd-stream-item" data-url="${srtUrl || s.url}" data-ext="srt" data-type="subtitle">
                    <span class="uvd-col-quality">${label}</span>
                    <span class="uvd-col-format">SRT</span>
                    <span class="uvd-col-codec">${s.languageCode || ''}</span>
                    <span class="uvd-col-extra">${badge}</span>
                    <span class="uvd-col-size">—</span>
                </li>`;
        }
        html += '</ul>';

        return html;
    }

    function showEmptyDialog() {
        removeDialog();

        // BUG-001: The bottom "Close" button below uses an inline onclick handler.
        // YouTube's Content Security Policy (CSP) blocks inline event handlers on
        // dynamically injected DOM. This makes the Close button non-functional.
        // FIX: Replace inline onclick with addEventListener (same as #uvd-close and #uvd-rescan).
        // See BUGS.md for full details.
        const overlay = document.createElement('div');
        overlay.id = 'uvd-overlay';
        // Trusted Types wrapper — see top of file (BUG-003 fix).
        setHTML(overlay, `
            <div id="uvd-dialog">
                <div class="uvd-header">
                    <h2>⬇️ No Streams Detected</h2>
                    <button id="uvd-close">✕</button>
                </div>
                <div class="uvd-content">
                    <div class="uvd-empty" style="padding:40px;">
                        <p style="font-size:15px;color:#ccc;margin-bottom:16px;">No downloadable video/audio found on this page.</p>
                        ${HELPER.alive && helperGetToken() ? `
                        <div style="background:#1e1b4b;border:1px solid #6366f1;border-radius:8px;padding:14px;margin-bottom:18px;">
                            <p style="font-size:13px;color:#c7d2fe;margin:0 0 10px 0;line-height:1.5;">
                                <strong>Try yt-dlp on this page.</strong> Many sites (animepahe, embedded players, niche streamers) are supported by yt-dlp's site-specific extractors even when the in-page scan finds nothing.
                            </p>
                            <button class="uvd-btn uvd-btn-primary" id="uvd-try-ytdlp">▶ Queue this page in yt-dlp</button>
                        </div>` : ''}
                        ${detectEpisodeContext() ? `
                        <div style="background:#1a1a1c;border:1px solid #2a2a2f;border-radius:8px;padding:14px;margin-bottom:18px;">
                            <p style="font-size:13px;color:#ddd;margin:0 0 10px 0;line-height:1.5;">
                                <strong>This looks like Episode ${detectEpisodeContext().current}.</strong>
                                ${nextEpisodeUrl() ? `Next episode auto-detected.` : `No next-episode link found in the DOM, but URL pattern lets us build one.`}
                            </p>
                            <div style="display:flex;gap:8px;flex-wrap:wrap;">
                                <button class="uvd-btn uvd-btn-secondary" id="uvd-go-next-ep">▶ Open Episode ${detectEpisodeContext().current + 1}</button>
                                ${HELPER.alive && helperGetToken() ? `
                                <button class="uvd-btn uvd-btn-secondary" id="uvd-queue-next-5">📥 Queue next 5 via yt-dlp</button>
                                <button class="uvd-btn uvd-btn-secondary" id="uvd-queue-next-12">📥 Queue next 12</button>
                                ` : ''}
                                <button class="uvd-btn uvd-btn-secondary" id="uvd-toggle-autonext">${autonextEnabled() ? '⏸ Disable Auto-next' : '⏭ Enable Auto-next'}</button>
                            </div>
                        </div>` : ''}
                        <p style="font-size:13px;color:#888;line-height:1.6;">
                            <strong>Tips:</strong><br>
                            • Make sure the video has started playing<br>
                            • Some sites use DRM protection (Widevine/FairPlay) which cannot be bypassed<br>
                            • Blob/MediaSource URLs require the video to be actively streaming<br>
                            • Try refreshing the page with the script enabled<br>
                            • Embedded iframes from other domains cannot be accessed in-page${HELPER.alive && helperGetToken() ? ' — use the helper button above' : ''}
                        </p>
                        <p style="font-size:12px;color:#555;margin-top:16px;">
                            Captured network requests: ${capturedStreams.length}
                        </p>
                    </div>
                </div>
                <div class="uvd-footer">
                    <div class="uvd-actions">
                        <button class="uvd-btn uvd-btn-secondary" id="uvd-rescan">🔄 Rescan Page</button>
                        <button class="uvd-btn uvd-btn-primary" id="uvd-close-btn">Close</button>
                    </div>
                </div>
            </div>
        `);
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add('visible'));

        overlay.addEventListener('click', e => { if (e.target === overlay) removeDialog(); });
        overlay.querySelector('#uvd-close').addEventListener('click', removeDialog);
        overlay.querySelector('#uvd-close-btn').addEventListener('click', removeDialog);
        overlay.querySelector('#uvd-rescan')?.addEventListener('click', () => {
            removeDialog();
            setTimeout(showDialog, 500);
        });
        // v2.7.0: "Queue this page in yt-dlp" — when no in-page streams
        // are detected and the helper is up, hand the page URL straight
        // to the daemon. yt-dlp's extractors cover hundreds of sites
        // (animepahe, niche streamers, cross-origin iframe-only pages,
        // etc.) that the userscript's in-page scan can't see.
        overlay.querySelector('#uvd-try-ytdlp')?.addEventListener('click', () => {
            queuePageThroughHelper(overlay);
        });
        // v2.8.0 — episode navigation + queue-next-N + autonext toggle.
        overlay.querySelector('#uvd-go-next-ep')?.addEventListener('click', () => {
            const url = nextEpisodeUrl();
            if (!url) { alert('Could not derive a next-episode URL from this page.'); return; }
            location.href = url;
        });
        const queueNHandler = async (n) => {
            const btn = overlay.querySelector(`#uvd-queue-next-${n}`);
            if (!btn) return;
            const prev = btn.textContent;
            btn.disabled = true;
            btn.textContent = `Queueing ${n}…`;
            try {
                const r = await queueNextEpisodes(n);
                btn.textContent = `✅ Queued ${r.queued}/${r.total}`;
                pollQueueOnce(overlay);
                setTimeout(() => openQueuePanel(overlay), 600);
            } catch (e) {
                btn.textContent = '⚠ Helper failed';
                setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 2200);
            }
        };
        overlay.querySelector('#uvd-queue-next-5')?.addEventListener('click', () => queueNHandler(5));
        overlay.querySelector('#uvd-queue-next-12')?.addEventListener('click', () => queueNHandler(12));
        overlay.querySelector('#uvd-toggle-autonext')?.addEventListener('click', (e) => {
            setAutonextEnabled(!autonextEnabled());
            const on = autonextEnabled();
            e.currentTarget.textContent = on ? '⏸ Disable Auto-next' : '⏭ Enable Auto-next';
            // Re-mount the corner badge so its color/state matches.
            const existing = document.getElementById('uvd-autonext-badge');
            if (existing) existing.remove();
            maybeMountAutonextBadge();
            if (on) wireAutonextWatcher();
            else cancelAutonextCountdown();
        });
        document.addEventListener('keydown', escHandler);
    }

    // Queue the current page URL through the helper without any
    // itag/type/filename — yt-dlp picks the best by itself. Used by the
    // "No streams found" dialog and by the generic site-button injector.
    function queuePageThroughHelper(overlay) {
        if (!HELPER.alive || !helperGetToken()) {
            alert('Helper is not running or token is missing. Click ⚙️ Settings to set one up.');
            return;
        }
        const cleanUrl = location.href.split('#')[0];
        const titleGuess = sanitizeFilename(document.title || location.hostname);
        const payload = {
            url: cleanUrl,
            type: 'video',          // generic — yt-dlp picks
            ext: 'mp4',             // hint only; yt-dlp overrides
            filename: titleGuess,
        };
        helperStartDownload(payload).then((job) => {
            // Reuse the toast/queue refresh path. If we're in the
            // empty dialog, also swap to the queue panel so the user
            // can watch progress without manually clicking.
            showQueueToast(overlay, job, payload);
            pollQueueOnce(overlay);
            setTimeout(() => {
                if (document.getElementById('uvd-overlay')) openQueuePanel(overlay);
            }, 400);
        }, (err) => {
            if (err && err.status === 401) {
                alert('Helper rejected token. Open ⚙️ Settings and paste the token again.');
            } else {
                alert('Helper request failed: ' + ((err && err.body && err.body.error) || (err && err.status) || 'unknown'));
            }
        });
    }

    // ==================== HELPER UI ===================================
    // Settings modal: paste/clear the helper token, see status, link to
    // the install command. Lives inside the dialog overlay so it inherits
    // z-index and dismissal.
    function openSettingsModal(overlay) {
        if (overlay.querySelector('.uvd-settings-modal')) return;
        const currentToken = helperGetToken();
        const installCmd = 'powershell -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/BarnsL/universal-video-download/main/helper/install.ps1 | iex"';
        const modal = document.createElement('div');
        modal.className = 'uvd-settings-modal';
        setHTML(modal, `
            <div class="uvd-settings-panel">
                <h3>⚙️ Helper Settings</h3>
                <div>Status: <span class="uvd-helper-badge ${HELPER.alive ? 'alive' : 'absent'}">
                    <span class="uvd-helper-badge-dot"></span>
                    ${HELPER.alive ? `running (v${HELPER.version || '?'})` : 'not running'}
                </span></div>
                ${HELPER.alive && HELPER.downloadDir ? `<div style="font-size:11px;color:#888;margin-top:6px;">Download dir: <code style="color:#c4b5fd;">${HELPER.downloadDir}</code></div>` : ''}
                ${!HELPER.alive && HELPER.lastError ? `<div style="font-size:11px;color:#fca5a5;margin-top:6px;">Last error: ${HELPER.lastError}</div>` : ''}
                <label for="uvd-token-input">Token (64 hex characters)</label>
                <input type="password" id="uvd-token-input" value="${currentToken}" placeholder="paste from install.ps1 output…" autocomplete="off" spellcheck="false">
                <div class="uvd-settings-info">
                    The helper is a small localhost daemon that runs yt-dlp on your behalf.<br>
                    Install on Windows:<br>
                    <code style="user-select:all;">${installCmd}</code><br>
                    The installer copies the token to your clipboard.
                </div>
                <div class="uvd-settings-actions">
                    <button class="uvd-btn uvd-btn-secondary" id="uvd-token-test">Test</button>
                    <button class="uvd-btn uvd-btn-secondary" id="uvd-token-cancel">Cancel</button>
                    <button class="uvd-btn uvd-btn-primary" id="uvd-token-save">Save</button>
                </div>
            </div>
        `);
        overlay.querySelector('#uvd-dialog').appendChild(modal);

        const close = () => modal.remove();
        modal.addEventListener('click', e => { if (e.target === modal) close(); });
        modal.querySelector('#uvd-token-cancel').addEventListener('click', close);
        modal.querySelector('#uvd-token-save').addEventListener('click', () => {
            helperSetToken(modal.querySelector('#uvd-token-input').value.trim());
            detectHelper().then(() => updateHelperBadge(overlay));
            close();
        });
        modal.querySelector('#uvd-token-test').addEventListener('click', async () => {
            const btn = modal.querySelector('#uvd-token-test');
            const prev = btn.textContent;
            btn.textContent = 'Testing…';
            // Save first so gmFetch uses the new token.
            helperSetToken(modal.querySelector('#uvd-token-input').value.trim());
            try {
                await gmFetch('GET', '/jobs');
                btn.textContent = '✅ Token works';
                detectHelper().then(() => updateHelperBadge(overlay));
            } catch (e) {
                btn.textContent = e.status === 401 ? '❌ Bad token' : `❌ ${e.status || 'unreachable'}`;
            }
            setTimeout(() => { btn.textContent = prev; }, 2500);
        });
    }

    function updateHelperBadge(overlay) {
        const badge = overlay.querySelector('#uvd-helper-badge');
        if (!badge) return;
        badge.classList.toggle('alive', !!HELPER.alive);
        badge.classList.toggle('absent', !HELPER.alive);
        // Rebuild the badge content cleanly. The template-literal source
        // produces leading whitespace text nodes that earlier versions
        // mistook for the label node — replacing the wrong one left the
        // real "helper running" text behind and the badge rendered
        // "helper running • helper running". Wipe and re-append the dot
        // + one fresh label node.
        const dot = badge.querySelector('.uvd-helper-badge-dot');
        badge.textContent = '';
        if (dot) badge.appendChild(dot);
        else {
            const fresh = document.createElement('span');
            fresh.className = 'uvd-helper-badge-dot';
            badge.appendChild(fresh);
        }
        badge.appendChild(document.createTextNode(' ' + (HELPER.alive ? 'helper running' : 'no helper')));
    }

    // Progress overlay (replaces the dialog body when a helper job is
    // running). We keep the header so the user still sees the title.
    function renderProgressView(overlay, job, payload) {
        const dialog = overlay.querySelector('#uvd-dialog');
        // Drop the streams/footer; keep just the header.
        [...dialog.querySelectorAll('.uvd-content, .uvd-footer, .uvd-tabs')].forEach(el => el.remove());

        const view = document.createElement('div');
        view.className = 'uvd-progress-view';
        view.id = 'uvd-progress-view';
        setHTML(view, `
            <h3 title="${payload.filename || job.filename || 'download'}">⬇️ ${payload.filename || job.filename || 'Downloading…'}</h3>
            <div class="uvd-progress-sub">job <code style="user-select:all;">${job.id}</code></div>
            <div class="uvd-progress-bar"><div class="uvd-progress-fill" id="uvd-pf"></div></div>
            <div class="uvd-progress-stats">
                <div><span class="uvd-stat-label">Progress</span><span class="uvd-stat-value" id="uvd-p-pct">0.0%</span></div>
                <div><span class="uvd-stat-label">Downloaded</span><span class="uvd-stat-value" id="uvd-p-bytes">—</span></div>
                <div><span class="uvd-stat-label">Speed</span><span class="uvd-stat-value" id="uvd-p-speed">—</span></div>
                <div><span class="uvd-stat-label">ETA</span><span class="uvd-stat-value" id="uvd-p-eta">—</span></div>
            </div>
            <div class="uvd-progress-status" id="uvd-p-status">Starting…</div>
            <div class="uvd-progress-actions" id="uvd-p-actions">
                <button class="uvd-btn uvd-btn-secondary" id="uvd-p-cancel">Cancel</button>
                <button class="uvd-btn uvd-btn-secondary" id="uvd-p-back">Back to streams</button>
            </div>
            <pre class="uvd-progress-log" id="uvd-p-log" style="display:none;"></pre>
        `);
        dialog.appendChild(view);

        const pf = view.querySelector('#uvd-pf');
        const pct = view.querySelector('#uvd-p-pct');
        const bytes = view.querySelector('#uvd-p-bytes');
        const speed = view.querySelector('#uvd-p-speed');
        const eta = view.querySelector('#uvd-p-eta');
        const status = view.querySelector('#uvd-p-status');
        const actions = view.querySelector('#uvd-p-actions');
        const log = view.querySelector('#uvd-p-log');

        view.querySelector('#uvd-p-cancel').addEventListener('click', () => {
            helperCancelJob(job.id).catch(() => {});
        });
        view.querySelector('#uvd-p-back').addEventListener('click', () => {
            stopProgressPoll();
            removeDialog();
            setTimeout(showDialog, 100);
        });

        const fmt = (n) => {
            if (!n) return '—';
            if (n < 1024) return n + ' B';
            if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
            if (n < 1073741824) return (n / 1048576).toFixed(2) + ' MB';
            return (n / 1073741824).toFixed(2) + ' GB';
        };
        const sizeStr = (cur, total) => total ? `${fmt(cur)} / ${fmt(total)}` : fmt(cur);

        stopProgressPoll();
        HELPER.activePoll = setInterval(async () => {
            let j;
            try { j = await helperJobStatus(job.id); }
            catch (e) {
                status.textContent = `Lost connection to helper: ${e.status || e.body || 'unknown'}`;
                status.className = 'uvd-progress-status error';
                stopProgressPoll();
                return;
            }
            const p = Math.max(0, Math.min(100, j.progress || 0));
            pf.style.width = p + '%';
            pct.textContent = p.toFixed(1) + '%';
            bytes.textContent = sizeStr(j.bytesDownloaded || 0, j.bytesTotal || 0);
            speed.textContent = j.speed || '—';
            eta.textContent = j.eta || '—';

            if (j.status === 'running' || j.status === 'queued') {
                status.textContent = j.status === 'queued' ? 'Queued…' : 'Downloading…';
                status.className = 'uvd-progress-status';
            } else if (j.status === 'done') {
                status.textContent = `Done → ${j.outputPath || HELPER.downloadDir || ''}`;
                status.className = 'uvd-progress-status done';
                setHTML(actions, `
                    <button class="uvd-btn uvd-btn-secondary" id="uvd-p-reveal">📁 Open folder</button>
                    <button class="uvd-btn uvd-btn-secondary" id="uvd-p-log-toggle">📜 Log</button>
                    <button class="uvd-btn uvd-btn-primary" id="uvd-p-done">Done</button>
                `);
                actions.querySelector('#uvd-p-reveal').addEventListener('click', () => helperOpenDownloadDir().catch(() => {}));
                actions.querySelector('#uvd-p-log-toggle').addEventListener('click', async () => {
                    log.style.display = log.style.display === 'none' ? 'block' : 'none';
                    if (log.style.display === 'block') {
                        try {
                            const r = await gmFetch('GET', '/jobs/' + job.id + '/log');
                            log.textContent = (r.log || []).join('\n');
                            log.scrollTop = log.scrollHeight;
                        } catch (e) {}
                    }
                });
                actions.querySelector('#uvd-p-done').addEventListener('click', () => removeDialog());
                stopProgressPoll();
            } else if (j.status === 'cancelled') {
                status.textContent = 'Cancelled.';
                status.className = 'uvd-progress-status error';
                stopProgressPoll();
            } else if (j.status === 'error') {
                status.textContent = `Error: ${j.error || 'unknown'}`;
                status.className = 'uvd-progress-status error';
                setHTML(actions, `
                    <button class="uvd-btn uvd-btn-secondary" id="uvd-p-log-toggle">📜 Log</button>
                    <button class="uvd-btn uvd-btn-secondary" id="uvd-p-back2">Back to streams</button>
                `);
                actions.querySelector('#uvd-p-log-toggle').addEventListener('click', async () => {
                    log.style.display = log.style.display === 'none' ? 'block' : 'none';
                    if (log.style.display === 'block') {
                        try {
                            const r = await gmFetch('GET', '/jobs/' + job.id + '/log');
                            log.textContent = (r.log || []).join('\n');
                            log.scrollTop = log.scrollHeight;
                        } catch (e) {}
                    }
                });
                actions.querySelector('#uvd-p-back2').addEventListener('click', () => {
                    stopProgressPoll();
                    removeDialog();
                    setTimeout(showDialog, 100);
                });
                stopProgressPoll();
            }
        }, 800);
    }

    function stopProgressPoll() {
        if (HELPER.activePoll) {
            clearInterval(HELPER.activePoll);
            HELPER.activePoll = null;
        }
    }

    // v2.6.0 — Queue toast + queue panel.
    //
    // Instead of replacing the dialog when the user clicks Download
    // (which prevented batch queueing), we drop a transient toast at
    // the bottom of the dialog, leave the streams list intact, and
    // bump a "queue" badge near the Settings/helper status. The full
    // progress UI is still available via the "View queue" button.
    function showQueueToast(overlay, job, payload) {
        const footer = overlay.querySelector('.uvd-footer') || overlay.querySelector('#uvd-dialog');
        let toast = overlay.querySelector('#uvd-queue-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'uvd-queue-toast';
            toast.className = 'uvd-queue-toast';
            (footer || overlay).appendChild(toast);
        }
        const name = (payload && payload.filename) || (job && job.filename) || 'stream';
        setHTML(toast, `✅ Queued <code>${escapeHtmlText(name)}</code>
            <button class="uvd-toast-link" id="uvd-toast-view">View queue</button>`);
        toast.classList.add('show');
        // Re-bind the action button (setHTML replaces the inner DOM each time)
        const viewBtn = toast.querySelector('#uvd-toast-view');
        if (viewBtn) viewBtn.addEventListener('click', () => openQueuePanel(overlay));
        clearTimeout(toast._hideTimer);
        toast._hideTimer = setTimeout(() => toast.classList.remove('show'), 4000);
    }

    function escapeHtmlText(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    // Fetch a single /queue snapshot and update the helper badge with
    // a "N queued · M running" suffix if there's any activity.
    async function pollQueueOnce(overlay) {
        try {
            const q = await gmFetch('GET', '/queue');
            const stats = (q && q.stats) || { byStatus: {} };
            const queued = stats.byStatus?.queued || 0;
            const running = stats.byStatus?.running || 0;
            const badge = overlay.querySelector('#uvd-helper-badge');
            if (badge) {
                // We rebuild the badge's text the same way updateHelperBadge does.
                const dot = badge.querySelector('.uvd-helper-badge-dot');
                badge.textContent = '';
                if (dot) badge.appendChild(dot);
                let label = HELPER.alive ? 'helper running' : 'no helper';
                if (queued + running > 0) label += ` · ${running}↓ / ${queued}🕓`;
                badge.appendChild(document.createTextNode(' ' + label));
            }
        } catch (e) { /* badge stays as-is */ }
    }

    // Replaces the dialog body with the full queue panel. Polls
    // every 800ms; one row per job with status, progress, controls.
    function openQueuePanel(overlay) {
        const dialog = overlay.querySelector('#uvd-dialog');
        [...dialog.querySelectorAll('.uvd-content, .uvd-footer, .uvd-tabs, .uvd-progress-view, .uvd-queue-panel')].forEach(el => el.remove());

        const panel = document.createElement('div');
        panel.className = 'uvd-queue-panel';
        setHTML(panel, `
            <div class="uvd-queue-head">
                <div>
                    <h3 style="margin:0;color:#fff;">Queue</h3>
                    <div class="uvd-queue-sub" id="uvd-queue-sub">—</div>
                </div>
                <div class="uvd-queue-head-actions">
                    <button class="uvd-btn uvd-btn-secondary" id="uvd-q-back">← Streams</button>
                    <button class="uvd-btn uvd-btn-secondary" id="uvd-q-pause">⏸ Pause queue</button>
                    <button class="uvd-btn uvd-btn-secondary" id="uvd-q-clear">🧹 Clear done</button>
                </div>
            </div>
            <div class="uvd-queue-list" id="uvd-q-list"></div>
        `);
        dialog.appendChild(panel);

        panel.querySelector('#uvd-q-back').addEventListener('click', () => {
            stopProgressPoll();
            removeDialog();
            setTimeout(showDialog, 100);
        });
        panel.querySelector('#uvd-q-pause').addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            const willPause = !btn.dataset.paused;
            try {
                await gmFetch('POST', willPause ? '/queue/pause' : '/queue/resume', {});
                btn.dataset.paused = willPause ? '1' : '';
                btn.textContent = willPause ? '▶ Resume queue' : '⏸ Pause queue';
            } catch (_) {}
        });
        panel.querySelector('#uvd-q-clear').addEventListener('click', async () => {
            try { await gmFetch('POST', '/queue/clear-completed', {}); } catch (_) {}
        });

        const list = panel.querySelector('#uvd-q-list');
        const sub = panel.querySelector('#uvd-queue-sub');

        const fmt = (n) => {
            if (!n) return '—';
            if (n < 1024) return n + ' B';
            if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
            if (n < 1073741824) return (n / 1048576).toFixed(2) + ' MB';
            return (n / 1073741824).toFixed(2) + ' GB';
        };

        const refresh = async () => {
            let q;
            try { q = await gmFetch('GET', '/queue'); }
            catch (e) { sub.textContent = 'Helper unreachable.'; return; }
            const stats = q.stats || { byStatus: {} };
            const bs = stats.byStatus || {};
            sub.textContent = `${bs.running || 0} running · ${bs.queued || 0} queued · ${bs.done || 0} done · ${bs.error || 0} error`;
            const jobs = (q.jobs || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
            const rows = jobs.map(j => {
                const statusColor = ({
                    running: '#22c55e', queued: '#a8a29e',
                    done: '#86efac', error: '#fca5a5', cancelled: '#94a3b8',
                }[j.status] || '#a8a29e');
                const pct = Math.max(0, Math.min(100, j.progress || 0));
                const showBar = j.status === 'running' || j.status === 'done';
                const sizeStr = j.bytesTotal ? `${fmt(j.bytesDownloaded)} / ${fmt(j.bytesTotal)}` : (j.bytesDownloaded ? fmt(j.bytesDownloaded) : '');
                const meta = [j.speed, j.eta ? `ETA ${j.eta}` : '', sizeStr].filter(Boolean).join(' · ');
                const retry = j.retryCount > 0 ? ` <span style="color:#fbbf24;">retry ${j.retryCount}</span>` : '';
                return `<div class="uvd-q-row" data-id="${j.id}">
                    <div class="uvd-q-row-top">
                        <span class="uvd-q-status" style="color:${statusColor}">${j.status}${retry}</span>
                        <span class="uvd-q-name" title="${escapeHtmlText(j.filename || '')}">${escapeHtmlText(j.filename || j.url || '(no name)')}</span>
                        <span class="uvd-q-actions">
                            ${j.status === 'queued' || j.status === 'running' ? `<button class="uvd-q-btn" data-act="cancel">Cancel</button>` : ''}
                            ${j.status === 'error' || j.status === 'cancelled' ? `<button class="uvd-q-btn" data-act="retry">Retry</button>` : ''}
                        </span>
                    </div>
                    ${showBar ? `<div class="uvd-q-bar"><div class="uvd-q-fill" style="width:${pct.toFixed(1)}%;background:${statusColor}"></div></div>` : ''}
                    <div class="uvd-q-meta">${pct ? pct.toFixed(1) + '% · ' : ''}${meta}${j.error ? ` <span style="color:#fca5a5;">${escapeHtmlText(j.error.split('\n')[0])}</span>` : ''}</div>
                </div>`;
            }).join('');
            setHTML(list, rows || '<div class="uvd-empty">Nothing in the queue yet.</div>');
            list.querySelectorAll('.uvd-q-btn').forEach(b => {
                b.addEventListener('click', async (e) => {
                    const row = e.currentTarget.closest('.uvd-q-row');
                    const jid = row && row.dataset.id;
                    const act = e.currentTarget.dataset.act;
                    if (!jid) return;
                    try {
                        await gmFetch('GET', `/jobs/${jid}/${act}`);
                    } catch (_) {}
                });
            });
        };

        stopProgressPoll();
        HELPER.activePoll = setInterval(refresh, 800);
        refresh();
    }

    // ==================== DOWNLOAD HANDLER ====================
    // Resolution order:
    //   1. Helper available + token set → POST /download, show progress UI.
    //      Works for ALL stream types including YouTube cipher-encrypted.
    //   2. No helper, but a direct URL is available → GM_download / anchor.
    //   3. No helper, YouTube cipher case → clipboard yt-dlp command
    //      (v2.4 behavior; user pastes into a shell).
    //   4. Nothing else → useful error.
    function performDownload(selectedItem, overlay) {
        const url = selectedItem.dataset.url;
        const ext = selectedItem.dataset.ext || 'mp4';
        const itag = selectedItem.dataset.itag || '';
        const type = selectedItem.dataset.type || '';
        const filename = overlay.querySelector('#uvd-filename').value || 'download';
        const fullFilename = `${sanitizeFilename(filename)}.${ext}`;

        const isYouTube = CONFIG.supportedSites.youtube.test(location.hostname);
        const watchUrl = isYouTube ? location.href.split(/[&?]list=|&t=/)[0] : location.href;

        // Path 1: helper.
        if (HELPER.alive && helperGetToken()) {
            const payload = {
                // For YouTube cipher streams we pass the WATCH URL plus itag —
                // yt-dlp re-resolves the format. For direct-URL streams we
                // still pass the watch URL when on YouTube (cleaner) and the
                // direct URL on other sites.
                url: isYouTube ? watchUrl : (url || location.href),
                itag: itag,
                type: type || (selectedItem.dataset.type === 'subtitle' ? 'subtitle' : 'video'),
                ext: ext,
                filename: filename,
            };
            if (payload.type === 'subtitle') {
                // language code carried in data-quality / data-codec; we
                // settle for 'en' fallback because the userscript doesn't
                // currently surface the lang to the dataset.
                payload.lang = (selectedItem.querySelector('.uvd-col-codec')?.textContent || 'en').trim() || 'en';
            }
            helperStartDownload(payload).then((job) => {
                // v2.6.0: don't replace the dialog with the progress
                // view on every single click — that made it impossible
                // to queue multiple streams in one sitting. Just show a
                // brief toast at the bottom of the dialog and refresh
                // the queue badge. The user can keep selecting and
                // clicking Download to fill the queue. The full progress
                // UI is one click away via the "Queue" button.
                showQueueToast(overlay, job, payload);
                pollQueueOnce(overlay);
            }, (err) => {
                if (err && err.status === 401) {
                    alert('Helper rejected token. Click ⚙️ Settings and paste the token again.');
                } else {
                    alert('Helper request failed: ' + (err && (err.body?.error || err.body) || err?.status || 'unknown'));
                }
            });
            return;
        }

        // Path 3: YouTube cipher, no helper → clipboard yt-dlp command.
        if (!url) {
            if (itag && isYouTube) {
                const fmt = type === 'video-only' ? `${itag}+bestaudio` : itag;
                const merge = type === 'video-only' ? ' --merge-output-format mp4' : '';
                const cmd = `yt-dlp -f ${fmt}${merge} "${watchUrl}" -o "${fullFilename}"`;
                navigator.clipboard.writeText(cmd).then(() => {
                    alert(`This YouTube stream is signature-encrypted — direct download isn't possible from the browser.\n\nA ready-to-run yt-dlp command has been copied to your clipboard:\n\n${cmd}\n\nPaste it into PowerShell or a terminal. Requires yt-dlp installed (winget install yt-dlp).\n\nTip: install the helper for one-click downloads — click ⚙️ Settings.`);
                }, () => {
                    prompt('Copy this yt-dlp command and run it in a terminal:', cmd);
                });
                return;
            }
            alert('No direct download URL available.\n\nThis stream may be:\n• DRM protected\n• Using blob/MediaSource (not directly downloadable)\n• Signature-encrypted (YouTube DASH)\n\nInstall the helper (⚙️ Settings) or use "Copy URL" with yt-dlp.');
            return;
        }

        // Path 2: direct URL → GM_download.
        try {
            GM_download({
                url: url,
                name: fullFilename,
                saveAs: true,
                onerror: (err) => {
                    console.warn('GM_download failed, falling back:', err);
                    fallbackDownload(url, fullFilename);
                }
            });
        } catch(e) {
            fallbackDownload(url, fullFilename);
        }
    }

    function fallbackDownload(url, filename) {
        // Try anchor download
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.target = '_blank';
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => a.remove(), 100);
    }

    // ==================== FAB (Floating Action Button) ====================
    function createFab() {
        if (document.getElementById('uvd-fab')) return;

        const fab = document.createElement('button');
        fab.id = 'uvd-fab';
        fab.title = 'Download Video';
        // Trusted Types wrapper — see top of file (BUG-003 fix). Without this,
        // YouTube's CSP throws here and the entire init halts.
        // The .uvd-helper-dot is colored by detectHelper(): green if the
        // local helper daemon is reachable, slate otherwise.
        setHTML(fab, `
            <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
            <span class="uvd-badge" style="display:none;">0</span>
            <span class="uvd-helper-dot" title="Helper status"></span>
        `);
        fab.addEventListener('click', showDialog);
        document.body.appendChild(fab);
    }

    function updateFabBadge() {
        const badge = document.querySelector('#uvd-fab .uvd-badge');
        if (!badge) return;
        const count = capturedStreams.length;
        if (count > 0) {
            badge.textContent = count > 99 ? '99+' : count;
            badge.style.display = 'flex';
        }
    }

    function showFab() {
        // v2.8.6 — disabled globally. The corner-circle FAB was
        // redundant once we have the inline 'Download' pill in the
        // action bar (or under the next-episode link, on sites that
        // don't have one). Ctrl+Shift+D still opens the dialog from
        // anywhere. createFab() still runs so the badge / status dot
        // logic compiles, but the FAB stays opacity:0/pointer-events
        // :none — it just never gets the .visible class.
        return;
    }

    function hideFab() {
        const fab = document.getElementById('uvd-fab');
        if (fab) fab.classList.remove('visible');
    }

    // ==================== LIFECYCLE ====================
    function removeDialog() {
        // If a download is in flight, stop the progress poller so we
        // don't keep spamming the helper after the user closes the UI.
        stopProgressPoll();
        const overlay = document.getElementById('uvd-overlay');
        if (overlay) {
            overlay.classList.remove('visible');
            setTimeout(() => overlay.remove(), 250);
        }
        document.removeEventListener('keydown', escHandler);
    }

    function escHandler(e) {
        if (e.key === 'Escape') removeDialog();
    }

    // Periodic scan for video elements
    function scanForMedia() {
        const videos = detectVideoElements();
        const hasVideo = videos.length > 0 || capturedStreams.length > 0;

        // On AtoZ/Rustici, use inline button instead of FAB
        if (CONFIG.supportedSites.atoz.test(location.hostname)) {
            injectAtozButton();
            hideFab();
            return;
        }

        // On YouTube, always show on /watch pages, and keep trying to
        // inject the inline button until it sticks (YouTube's action-
        // bar DOM isn't always present at first load).
        if (CONFIG.supportedSites.youtube.test(location.hostname) && location.pathname === '/watch') {
            if (!document.getElementById('uvd-yt-btn')) injectYouTubeButton();
            // v2.8.5 — only show the FAB on YouTube if the inline pill
            // failed to inject (DOM not ready yet). Once the pill is
            // present, drop the FAB; the corner circle was redundant.
            if (document.getElementById('uvd-yt-btn')) hideFab();
            else showFab();
            return;
        }

        // v2.7.0 — on any non-YouTube site we know about (or even
        // generic), try to find the site's own "Download" button and
        // park our companion right next to it. Cheap (DOM query is
        // bounded by querySelectorAll on 3 tag names) and idempotent.
        if (!document.getElementById('uvd-site-btn')) injectGenericSiteButton();

        // v2.7.1 — if the inline companion button is in place, don't
        // re-show the FAB. The inline button is enough, and the FAB
        // tends to sit on top of player controls at the viewport corner.
        if (document.getElementById('uvd-site-btn')) {
            hideFab();
            return;
        }

        if (hasVideo) {
            showFab();
        }
    }

    // v2.7.0 — Generic site-button companion.
    // For sites that already have a "Download" button (animepahe,
    // CDN-fronted clip sites, etc.), drop our blue button immediately
    // next to it so the user finds it without thinking. Idempotent —
    // safe to call repeatedly on SPA navigation / DOM mutations.
    //
    // We also avoid double-injection on YouTube (which has its own
    // injector) and on the AtoZ flow.
    //
    // v2.7.2 — match broader labels ("Download Episode", "Download MP4"),
    // aria-labels / titles, AND fall back to "right under the video
    // iframe" on sites that have no Download button at all (wcoanimedub
    // → embed.wcostream.com, plenty of similar mirror sites).
    // v2.8.4 — Return true only if the current page has at least one
    // signal that suggests it's a video page: a sufficiently large
    // iframe, an in-page <video> element, or a captured media URL
    // from the network interceptor. Prevents the inline button from
    // attaching to random `download`-looking elements on non-video
    // pages (GitHub file lists, doc anchors, etc.) when the
    // NON_VIDEO_HOSTS_RE list doesn't catch them.
    function hasAnyVideoEvidence() {
        try {
            if (typeof capturedStreams !== 'undefined' && capturedStreams.length > 0) return true;
        } catch (_) {}
        for (const v of document.querySelectorAll('video')) {
            const r = v.getBoundingClientRect();
            if (r.width >= 200 && r.height >= 120) return true;
        }
        for (const f of document.querySelectorAll('iframe')) {
            const r = f.getBoundingClientRect();
            if (r.width >= 320 && r.height >= 180) return true;
        }
        return false;
    }

    // v2.8.4 — Skip code-hosting / dev / docs sites entirely. They tend
    // to have lots of `download` strings (filenames like
    // download-certs.ps1, "Download ZIP" in repo headers, doc anchors,
    // etc.) that the generic matcher would latch onto and produce a
    // jarring blue button in the middle of a file list. Universal Video
    // Download is for video sites; these aren't them.
    const NON_VIDEO_HOSTS_RE = /(?:^|\.)(?:github\.com|githubusercontent\.com|gitlab\.com|bitbucket\.org|sourceforge\.net|codeberg\.org|gitea\.com|launchpad\.net|stackoverflow\.com|stackexchange\.com|developer\.mozilla\.org|wikipedia\.org|wikimedia\.org|docs\.python\.org|nodejs\.org|npmjs\.com|pypi\.org|crates\.io|rubygems\.org|maven\.org|nuget\.org|godoc\.org|pkg\.go\.dev|hexdocs\.pm|hackage\.haskell\.org|microsoft\.com|learn\.microsoft\.com|apple\.com\/developer|developer\.apple\.com|developer\.android\.com|chromewebstore\.google\.com|addons\.mozilla\.org|tampermonkey\.net|mail\.google\.com|outlook\.live\.com|outlook\.office\.com|app\.slack\.com|notion\.so|atlassian\.net|linear\.app|claude\.ai|chatgpt\.com|chat\.openai\.com)$/i;

    function injectGenericSiteButton() {
        if (CONFIG.supportedSites.youtube.test(location.hostname)) return;
        if (CONFIG.supportedSites.atoz.test(location.hostname)) return;
        if (NON_VIDEO_HOSTS_RE.test(location.hostname)) return;
        if (document.getElementById('uvd-site-btn')) return;
        // v2.8.4 — only inject if there's actual video evidence on the
        // page. Three signals are enough: an iframe that looks like a
        // player (any host, just sized right), an in-page <video>
        // element, or our network interceptor has already captured at
        // least one media URL. Otherwise we wait — scanForMedia keeps
        // running every 3s, so as soon as a player loads we react.
        if (!hasAnyVideoEvidence()) return;

        // v2.8.3 — on episode pages, prefer the site's existing
        // "next episode" link as the anchor. The button stacks directly
        // under it instead of being centered across the page width,
        // which on sites like wcoanimedub.tv puts the UVD button under
        // the right-side "Episode N+1" navigation pill rather than
        // floating across the middle of the page.
        if (detectEpisodeContext()) {
            const nextEpAnchor = findNextEpisodeAnchorElement();
            if (nextEpAnchor) {
                placeUvdButtonAfter(nextEpAnchor, 'Download via UVD', { align: 'inherit' });
                hideFab();
                return;
            }
        }

        // Skip elements that are inside our own dialog/FAB so we don't
        // attach the button to itself.
        const skipInside = (el) => {
            for (let n = el; n; n = n.parentElement) {
                if (n.id === 'uvd-overlay' || n.id === 'uvd-fab' || n.id === 'uvd-site-btn') return true;
            }
            return false;
        };

        // Match priority (best -> worst):
        //   1. own text is exactly "Download" — high confidence
        //   2. own text starts with "Download " (e.g. "Download Episode")
        //   3. aria-label / title contains the word "download"
        //   4. has a child element with class/id containing "download"
        //      (icon-only buttons, font-awesome download glyphs, etc.)
        const EXACT_RE = /^download$/i;
        const STARTS_RE = /^download[\s:_-]/i;
        const HAS_RE = /\bdownload\b/i;
        const ICONISH_RE = /(?:^|[\s.-])(?:fa-download|icon-download|download-icon|btn-download|download-btn)(?:$|[\s.-])/i;

        const all = Array.from(document.querySelectorAll('button, a, [role="button"]'))
            .filter(el => !skipInside(el));
        const matched = [];
        for (const el of all) {
            const own = Array.from(el.childNodes)
                .filter(n => n.nodeType === Node.TEXT_NODE)
                .map(n => n.nodeValue.trim())
                .join(' ').trim();
            const aria = (el.getAttribute('aria-label') || '').trim();
            const title = (el.getAttribute('title') || '').trim();
            const cls = (el.className || '').toString() + ' ' + (el.id || '');
            const innerCls = Array.from(el.querySelectorAll('[class],[id]'))
                .map(c => (c.className || '') + ' ' + (c.id || '')).join(' ');

            let score = 0;
            if (EXACT_RE.test(own)) score = 100;
            else if (STARTS_RE.test(own)) score = 80;
            else if (HAS_RE.test(aria) || HAS_RE.test(title)) score = 60;
            else if (ICONISH_RE.test(cls) || ICONISH_RE.test(innerCls)) score = 40;
            if (score > 0) matched.push({ el, score });
        }

        // No native download button -> fall through to iframe-anchor mode.
        if (!matched.length) {
            const iframeAnchor = findVideoIframeAnchor();
            if (iframeAnchor) {
                placeUvdButtonAfter(iframeAnchor, 'Download via UVD');
                hideFab();
            }
            return;
        }

        // Highest score first; among equals, largest visible bounding rect.
        const target = matched
            .map(x => {
                const r = x.el.getBoundingClientRect();
                return { el: x.el, score: x.score, area: r.width * r.height, w: r.width, h: r.height };
            })
            .filter(x => x.w > 20 && x.h > 14)
            .sort((a, b) => (b.score - a.score) || (b.area - a.area))[0];
        if (!target) return;

        placeUvdButtonAfter(target.el, 'Download via UVD');
        hideFab();
    }

    // Anchor finder for sites that don't have any download button at
    // all. We look for, in priority order:
    //   1. A large iframe whose src points at a known embed host
    //   2. A large iframe regardless of host (v2.8.1 — covers cases
    //      where the player iframe is injected by JS after page load
    //      with a src we don't recognize, e.g. wcoanimedub.tv's
    //      cizgi/video-page-main wrapper)
    //   3. A large in-page <video>
    //   4. A known video-container wrapper (.video-page-main,
    //      #player, etc.) — even when empty, the embed lands inside
    //      it, so dropping the button right after the wrapper still
    //      lands in a sensible place
    function findVideoIframeAnchor() {
        const KNOWN_EMBED_RE = /(?:^|\.)(?:wcostream|wcofun|embed\.|mp4upload|streamtape|doodstream|dood\.|vidstreaming|vidstream|vidsrc|vidcdn|megacloud|megaplay|filemoon|mixdrop|streamhg|streamhide|vidoza|vidlox|sbplay|sbembed|hydrax|kwik\.|kwik|emturbovid|fembed|stape\.fun|abyss\.to|playerwish|swiftplayers|streamwish|cizgi)/i;
        const EMBED_PATH_RE = /\/(?:embed|e|player|video|play|stream)\b/i;
        const MIN_W = 320, MIN_H = 180;

        const iframes = Array.from(document.querySelectorAll('iframe'));
        const ranked = iframes.map(f => {
            const src = (f.getAttribute('src') || f.src || '').toString();
            const r = f.getBoundingClientRect();
            let score = 0;
            try {
                const u = new URL(src, location.href);
                if (KNOWN_EMBED_RE.test(u.hostname)) score += 60;
                if (EMBED_PATH_RE.test(u.pathname)) score += 20;
            } catch (_) {}
            // v2.8.1 — any visibly-sized iframe is a plausible player.
            // Score it by area so the biggest wins even with no host
            // match. We still skip tiny tracker pixels (< MIN_W/MIN_H).
            if (r.width >= MIN_W && r.height >= MIN_H) score += 30;
            return { el: f, score, area: r.width * r.height, w: r.width, h: r.height };
        }).filter(x => x.w >= MIN_W && x.h >= MIN_H)
          .sort((a, b) => (b.score - a.score) || (b.area - a.area));
        if (ranked.length) return ranked[0].el;

        const videos = Array.from(document.querySelectorAll('video'));
        const vid = videos
            .map(v => ({ el: v, r: v.getBoundingClientRect() }))
            .filter(x => x.r.height >= MIN_H && x.r.width >= MIN_W)
            .sort((a, b) => (b.r.width * b.r.height) - (a.r.width * a.r.height))[0];
        if (vid) return vid.el;

        // v2.8.1 fallback — common wrapper selectors. Catches sites
        // where the player iframe is injected by JS only after user
        // interaction (Click-to-load gates, ad bypass scripts, etc.),
        // OR where the iframe lives behind a same-origin shadow root.
        // We pick the largest matching element by area.
        const WRAPPER_SELECTORS = [
            '.video-page-main', '.video-page', '#video', '#videoplayer',
            '#player', '#player-container', '.player-container',
            '.video-container', '.video-wrapper', '.embed-container',
            '.episode-video', '.episode-player', '[id*="player"]',
            '[class*="player-wrap"]',
        ];
        const wrappers = [];
        for (const sel of WRAPPER_SELECTORS) {
            try {
                document.querySelectorAll(sel).forEach(el => {
                    const r = el.getBoundingClientRect();
                    if (r.width >= MIN_W && r.height >= 80) {
                        wrappers.push({ el, area: r.width * r.height });
                    }
                });
            } catch (_) {}
        }
        wrappers.sort((a, b) => b.area - a.area);
        return wrappers.length ? wrappers[0].el : null;
    }

    function placeUvdButtonAfter(anchor, label, opts) {
        opts = opts || {};
        const align = opts.align || 'center';  // 'center' | 'inherit'

        // v2.8.6 — keep oval pill shape but blue (#065fd4) so it's
        // unambiguously the UVD button on every site.
        const bgIdle  = '#065fd4';
        const bgHover = '#0451b5';

        const btn = document.createElement('button');
        btn.id = 'uvd-site-btn';
        btn.title = 'Universal Video Download — open the streams dialog (Ctrl+Shift+D)';
        btn.style.cssText = `
            display: inline-flex; align-items: center; gap: 6px;
            margin: 0;
            padding: 0 14px; height: 36px;
            background: ${bgIdle}; color: #fff;
            border: none; border-radius: 18px;
            font-size: 14px; font-weight: 500; cursor: pointer;
            font-family: inherit;
            transition: background 0.15s;
            white-space: nowrap; vertical-align: middle;
        `;
        btn.addEventListener('mouseover', () => btn.style.background = bgHover);
        btn.addEventListener('mouseout', () => btn.style.background = bgIdle);
        setHTML(btn, `<svg style="width:18px;height:18px;fill:currentColor;flex-shrink:0;" viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg><span>${label}</span>`);
        btn.addEventListener('click', () => showDialog());

        const parent = anchor.parentElement;
        if (!parent) return;

        if (align === 'inherit') {
            // v2.8.3 — sibling-mode placement. Read the parent's
            // computed text-align so the UVD button stacks directly
            // under whatever side the anchor sits on (typically right
            // on episode pages — wcoanimedub puts the next-episode
            // pill in a right-aligned <td>). Without this match the
            // button would left-align under a right-aligned link,
            // breaking the visual association the user asked for.
            let parentTA = 'inherit';
            try {
                parentTA = getComputedStyle(parent).textAlign || 'inherit';
            } catch (_) {}
            const wrap = document.createElement('div');
            wrap.style.cssText = `display:block;margin:8px 0 0 0;text-align:${parentTA};`;
            wrap.appendChild(btn);
            if (anchor.nextSibling) {
                parent.insertBefore(wrap, anchor.nextSibling);
            } else {
                parent.appendChild(wrap);
            }
        } else {
            const wrap = document.createElement('div');
            wrap.style.cssText = 'display:block;margin:10px 0 8px 0;text-align:center;width:100%;';
            wrap.appendChild(btn);
            if (anchor.nextSibling) {
                parent.insertBefore(wrap, anchor.nextSibling);
            } else {
                parent.appendChild(wrap);
            }
        }
    }

    // Also inject an inline button on YouTube. YouTube renames their
    // action-bar container roughly every few months; we walk a list of
    // known selectors (newest first) and fall back to "next to the Like
    // button" if none of them match. If even that fails we just leave
    // the FAB as the only entry point — the script still works.
    function injectYouTubeButton() {
        if (!CONFIG.supportedSites.youtube.test(location.hostname)) return;
        if (document.getElementById('uvd-yt-btn')) return;

        const selectors = [
            // 2026 layout (current)
            'ytd-watch-metadata #actions-inner #menu ytd-menu-renderer #top-level-buttons-computed',
            'ytd-watch-metadata #actions #menu ytd-menu-renderer #top-level-buttons-computed',
            'ytd-watch-metadata #menu ytd-menu-renderer #top-level-buttons-computed',
            // older
            '#top-level-buttons-computed',
            'ytd-menu-renderer #top-level-buttons-computed',
            // generic action-bar fallbacks
            'ytd-watch-metadata #actions-inner',
            'ytd-watch-metadata #actions',
            '#actions-inner',
            '#actions',
        ];
        let container = null;
        for (const sel of selectors) {
            container = document.querySelector(sel);
            if (container) break;
        }
        // Last resort: find the Like button's parent (its row almost
        // always hosts the inline action buttons).
        if (!container) {
            const like = document.querySelector('like-button-view-model, ytd-toggle-button-renderer, button[aria-label*="like" i]');
            if (like) container = like.parentElement;
        }
        if (!container) {
            console.warn('[UVD] could not find a YouTube action-bar container to inject Download button into; using FAB only.');
            return;
        }

        // v2.8.6 — keep the oval / action-bar pill shape from v2.8.5
        // but restore the saturated YouTube blue (#065fd4) so it's
        // unambiguously *our* button and visually distinct from the
        // native Like / Share / native-Download pills. Hover deepens
        // by ~12%.
        const btn = document.createElement('button');
        btn.id = 'uvd-yt-btn';
        const bgIdle  = '#065fd4';
        const bgHover = '#0451b5';
        btn.style.cssText = `
            display: inline-flex; align-items: center; gap: 6px;
            padding: 0 14px; height: 36px;
            margin-left: 8px;
            background: ${bgIdle}; color: #fff;
            border: none; border-radius: 18px;
            font-size: 14px; font-weight: 500;
            cursor: pointer; font-family: 'Roboto', 'Arial', sans-serif;
            transition: background 0.15s;
            vertical-align: middle; white-space: nowrap;
        `;
        setHTML(btn, `<svg style="width:18px;height:18px;fill:currentColor;flex-shrink:0;" viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg><span>Download</span>`);
        btn.addEventListener('mouseover', () => btn.style.background = bgHover);
        btn.addEventListener('mouseout', () => btn.style.background = bgIdle);
        btn.addEventListener('click', showDialog);
        container.appendChild(btn);
        hideFab();
    }

    // ==================== AtoZ/Rustici Download Button ====================
    function injectAtozButton() {
        if (!CONFIG.supportedSites.atoz.test(location.hostname)) return;

        // Remove any existing download button(s) to prevent duplicates
        document.querySelectorAll('#uvd-atoz-btn').forEach(el => el.remove());

        // Find the "Save and Exit" button
        let saveBtn = null;
        const candidates = document.querySelectorAll('button, a, input[type="button"], span[role="button"]');
        for (const el of candidates) {
            const text = (el.textContent || el.value || '').trim().toLowerCase();
            if (text.includes('save and exit') || text.includes('save & exit')) {
                saveBtn = el;
                break;
            }
        }

        if (!saveBtn) return; // Wait until Save and Exit is available

        const btn = document.createElement('button');
        btn.id = 'uvd-atoz-btn';
        btn.textContent = 'Download Video';
        btn.addEventListener('click', showDialog);

        // Position: fixed, same X as Save and Exit, 20px below it
        const rect = saveBtn.getBoundingClientRect();
        btn.style.top = (rect.bottom + 20) + 'px';
        btn.style.right = (window.innerWidth - rect.right) + 'px';

        // Match computed style of Save and Exit
        const cs = window.getComputedStyle(saveBtn);
        btn.style.padding = cs.padding;
        btn.style.fontSize = cs.fontSize;
        btn.style.fontFamily = cs.fontFamily;
        btn.style.borderRadius = cs.borderRadius;
        btn.style.background = cs.backgroundColor;
        btn.style.color = cs.color;
        btn.style.border = cs.border;
        btn.style.fontWeight = cs.fontWeight;

        document.body.appendChild(btn);
        hideFab();
    }

    // ==================== INITIALIZATION ====================
    try {
        createFab();
        // Show the FAB immediately on supported sites — historically we
        // waited 2s for scanForMedia() to add the .visible class. That
        // made it look like "nothing happened" after install on YouTube.
        // On supported sites we already know the FAB should be visible.
        if (CONFIG.supportedSites.youtube.test(location.hostname)
            || CONFIG.supportedSites.vimeo.test(location.hostname)
            || CONFIG.supportedSites.twitter.test(location.hostname)
            || CONFIG.supportedSites.tiktok.test(location.hostname)
            || CONFIG.supportedSites.reddit.test(location.hostname)
            || CONFIG.supportedSites.twitch.test(location.hostname)
            || CONFIG.supportedSites.facebook.test(location.hostname)
            || CONFIG.supportedSites.instagram.test(location.hostname)
            || CONFIG.supportedSites.dailymotion.test(location.hostname)) {
            showFab();
        }
        console.info('[UVD] FAB created and visible. v2.5.2');
    } catch (e) {
        console.error('[UVD] createFab failed (likely a CSP/Trusted Types issue):', e);
    }

    // Probe the helper once at startup. Cheap (single GET to localhost
    // with a short timeout), and lets us color the FAB dot before the
    // user even opens the dialog. We re-probe each time the dialog
    // opens too — see showDialog().
    detectHelper();

    // v2.8.0 — mount the autonext badge on any page whose URL matches
    // the `-episode-N-` pattern. Badge starts visible (off by default)
    // so the user can flip it on without opening the dialog.
    setTimeout(() => {
        maybeMountAutonextBadge();
        if (autonextEnabled()) wireAutonextWatcher();
    }, 1500);

    // Initial scan
    setTimeout(() => {
        scanForMedia();
        injectYouTubeButton();
        injectAtozButton();
    }, 2000);

    // Periodic re-scan
    setInterval(scanForMedia, CONFIG.autoDetectInterval);

    // YouTube SPA navigation
    if (CONFIG.supportedSites.youtube.test(location.hostname)) {
        let lastYTUrl = location.href;
        const ytObserver = new MutationObserver(() => {
            if (location.href !== lastYTUrl) {
                lastYTUrl = location.href;
                // Remove old button, re-inject
                const oldBtn = document.getElementById('uvd-yt-btn');
                if (oldBtn) oldBtn.remove();
                setTimeout(injectYouTubeButton, 1500);
            }
        });
        ytObserver.observe(document.body, { childList: true, subtree: true });

        window.addEventListener('yt-navigate-finish', () => {
            const oldBtn = document.getElementById('uvd-yt-btn');
            if (oldBtn) oldBtn.remove();
            setTimeout(injectYouTubeButton, 1000);
        });
    }

    // Keyboard shortcut: Ctrl+Shift+D
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && e.key === 'D') {
            e.preventDefault();
            showDialog();
        }
    });

    console.log('[Universal Video Download] Loaded. Press Ctrl+Shift+D or click the FAB to download.');

})();
