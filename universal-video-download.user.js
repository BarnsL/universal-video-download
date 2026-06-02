// ==UserScript==
// @name         Universal Video Download (NewPipe-Style)
// @namespace    http://tampermonkey.net/
// @version      2.2
// @description  Detects video elements on any website and offers full NewPipe-style download options (resolution, format, codec, audio tracks, subtitles, thread count)
// @author       BarnsL
// @match        *://*/*
// @grant        GM_download
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

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
        overlay.innerHTML = `
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
                        <button class="uvd-btn uvd-btn-copy" id="uvd-copy-url">📋 Copy URL</button>
                        <button class="uvd-btn uvd-btn-secondary" id="uvd-copy-all">📦 Copy All URLs</button>
                        <button class="uvd-btn uvd-btn-primary" id="uvd-download-btn">⬇️ Download</button>
                    </div>
                </div>
            </div>
        `;

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
                    <li class="uvd-stream-item" data-url="${s.url || ''}" data-ext="${ext}" data-type="video">
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
                    <li class="uvd-stream-item" data-url="${s.url || ''}" data-ext="${ext}" data-type="video-only">
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
                <li class="uvd-stream-item" data-url="${s.url || ''}" data-ext="${ext}" data-type="audio" data-track="${s.audioTrackId || 'default'}">
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
        overlay.innerHTML = `
            <div id="uvd-dialog">
                <div class="uvd-header">
                    <h2>⬇️ No Streams Detected</h2>
                    <button id="uvd-close">✕</button>
                </div>
                <div class="uvd-content">
                    <div class="uvd-empty" style="padding:40px;">
                        <p style="font-size:15px;color:#ccc;margin-bottom:16px;">No downloadable video/audio found on this page.</p>
                        <p style="font-size:13px;color:#888;line-height:1.6;">
                            <strong>Tips:</strong><br>
                            • Make sure the video has started playing<br>
                            • Some sites use DRM protection (Widevine/FairPlay) which cannot be bypassed<br>
                            • Blob/MediaSource URLs require the video to be actively streaming<br>
                            • Try refreshing the page with the script enabled<br>
                            • Embedded iframes from other domains cannot be accessed
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
        `;
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add('visible'));

        overlay.addEventListener('click', e => { if (e.target === overlay) removeDialog(); });
        overlay.querySelector('#uvd-close').addEventListener('click', removeDialog);
        overlay.querySelector('#uvd-close-btn').addEventListener('click', removeDialog);
        overlay.querySelector('#uvd-rescan')?.addEventListener('click', () => {
            removeDialog();
            setTimeout(showDialog, 500);
        });
        document.addEventListener('keydown', escHandler);
    }

    // ==================== DOWNLOAD HANDLER ====================
    function performDownload(selectedItem, overlay) {
        const url = selectedItem.dataset.url;
        const ext = selectedItem.dataset.ext || 'mp4';
        const filename = overlay.querySelector('#uvd-filename').value || 'download';
        const fullFilename = `${sanitizeFilename(filename)}.${ext}`;

        if (!url) {
            alert('No direct download URL available.\n\nThis stream may be:\n• DRM protected\n• Using blob/MediaSource (not directly downloadable)\n• Signature-encrypted (YouTube DASH)\n\nTry "Copy URL" and use yt-dlp or another tool.');
            return;
        }

        // Try GM_download (Tampermonkey's cross-origin download)
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
        fab.innerHTML = `
            <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
            <span class="uvd-badge" style="display:none;">0</span>
        `;
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
        const fab = document.getElementById('uvd-fab');
        if (fab) fab.classList.add('visible');
    }

    function hideFab() {
        const fab = document.getElementById('uvd-fab');
        if (fab) fab.classList.remove('visible');
    }

    // ==================== LIFECYCLE ====================
    function removeDialog() {
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

        // On YouTube, always show on /watch pages
        if (CONFIG.supportedSites.youtube.test(location.hostname) && location.pathname === '/watch') {
            showFab();
            return;
        }

        if (hasVideo) {
            showFab();
        }
    }

    // Also inject an inline button on YouTube
    function injectYouTubeButton() {
        if (!CONFIG.supportedSites.youtube.test(location.hostname)) return;
        if (document.getElementById('uvd-yt-btn')) return;

        const container = document.querySelector('#top-level-buttons-computed') ||
                         document.querySelector('ytd-menu-renderer #top-level-buttons-computed');
        if (!container) return;

        const btn = document.createElement('button');
        btn.id = 'uvd-yt-btn';
        btn.style.cssText = `
            display: inline-flex; align-items: center; gap: 6px;
            padding: 8px 16px; margin-left: 8px;
            background: #065fd4; color: #fff; border: none;
            border-radius: 18px; font-size: 14px; font-weight: 500;
            cursor: pointer; font-family: 'Roboto', sans-serif;
            transition: background 0.2s;
        `;
        btn.innerHTML = `<svg style="width:16px;height:16px;fill:currentColor;" viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg> Download`;
        btn.addEventListener('mouseover', () => btn.style.background = '#0051b5');
        btn.addEventListener('mouseout', () => btn.style.background = '#065fd4');
        btn.addEventListener('click', showDialog);
        container.appendChild(btn);
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
    createFab();

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
