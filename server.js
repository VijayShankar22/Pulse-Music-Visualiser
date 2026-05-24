const http = require('http');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');
const YTMusic = require('ytmusic-api');
const { Innertube } = require('youtubei.js');
const path = require('path');
const fs = require('fs');

/**
 * Enhanced Thumbnail Resolution Booster
 * Upgrades standard YouTube Music thumbnails to 1080p high-resolution versions.
 */
function getHighResThumb(thumbnails) {
    if (!thumbnails || thumbnails.length === 0) return '';
    const sorted = [...thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0));
    let url = sorted[0].url;
    if (url.includes('googleusercontent.com') || url.includes('ytimg.com')) {
        url = url.replace(/=w\d+-h\d+.*$/, '=s1080');
        url = url.replace(/\/s\d+-c-k-no/, '/s1080');
        url = url.replace(/s\d+-c/, 's1080-c');
        url = url.replace(/mqdefault|hqdefault|sddefault|default/, 'maxresdefault');
    }
    return url;
}

/**
 * Bypasses library signature deciphering issues.
 */
async function resolveStreamUrl(videoId) {
    const response = await fetch(
        "https://www.youtube.com/youtubei/v1/player?key=AIzaSyC9XL3ZjWddXya6XG1dJoAZ79f4Z7T67OQ",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": "com.google.android.youtube/20.03.35 (Linux; U; Android 14)",
                "X-Goog-Api-Format-Version": "2",
            },
            body: JSON.stringify({
                context: {
                    client: {
                        clientName: "ANDROID",
                        clientVersion: "20.03.35",
                        hl: "en",
                        gl: "IN",
                        androidSdkVersion: 33,
                    },
                },
                videoId: videoId,
                playbackContext: {
                    contentPlaybackContext: { html5Preference: "HTML5_PREF_WANTS" },
                },
                contentCheckOk: true,
                racyCheckOk: true,
            }),
        }
    );

    const data = await response.json();

    if (data.playabilityStatus?.status !== "OK") {
        throw new Error(data.playabilityStatus?.reason || "Not playable");
    }

    const formats = [
        ...(data.streamingData?.adaptiveFormats || []),
        ...(data.streamingData?.formats || []),
    ];
    
    const audioFormats = formats.filter(f => f.mimeType?.startsWith("audio/") && f.url);
    const progressiveMp4Formats = (data.streamingData?.formats || [])
        .filter(f => f.url && typeof f.mimeType === 'string' && f.mimeType.startsWith('video/mp4'));
    if (!audioFormats.length && !progressiveMp4Formats.length) {
        throw new Error("No playable formats found");
    }

    // Preferred itags for high-quality audio
    const preferredItags = [140, 251, 141, 250, 139];
    audioFormats.sort((a, b) => {
        const aIdx = preferredItags.indexOf(a.itag);
        const bIdx = preferredItags.indexOf(b.itag);
        if (aIdx !== -1 && bIdx === -1) return -1;
        if (bIdx !== -1 && aIdx === -1) return 1;
        if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
        return (b.bitrate || 0) - (a.bitrate || 0);
    });

    const preferredProgressiveItags = [18, 22];
    progressiveMp4Formats.sort((a, b) => {
        const aIdx = preferredProgressiveItags.indexOf(a.itag);
        const bIdx = preferredProgressiveItags.indexOf(b.itag);
        if (aIdx !== -1 && bIdx === -1) return -1;
        if (bIdx !== -1 && aIdx === -1) return 1;
        if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
        return (b.bitrate || 0) - (a.bitrate || 0);
    });

    async function supportsRangeHops(format) {
        if (!format?.url) return false;
        const total = Number(format.contentLength || 0);
        const probes = [0];
        if (total > 1_500_000) probes.push(1_048_576);
        if (total > 2_800_000) probes.push(2_097_152);
        for (const start of probes) {
            const end = start + 1023;
            const resp = await fetch(format.url, {
                headers: { Range: `bytes=${start}-${end}` },
                redirect: 'follow'
            });
            if (resp.status !== 206) return false;
        }
        return true;
    }

    const candidates = [...progressiveMp4Formats, ...audioFormats];
    for (const candidate of candidates) {
        try {
            if (await supportsRangeHops(candidate)) return candidate.url;
        } catch {
            // Keep trying the next candidate.
        }
    }

    // Final fallback: return best-known audio URL even if probes fail.
    const fallback = (audioFormats[0] || progressiveMp4Formats[0])?.url;
    if (!fallback) throw new Error("No direct URL available for this video (possibly ciphered)");
    return fallback;
}

const PORT = process.env.PORT || 9090;
const HOST = '127.0.0.1';
const DEEPSEEK_PROXY_URL = process.env.DEEPSEEK_PROXY_URL || 'https://............/v1/chat/completions';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

let ytmusic = null;
let innertube = null;
async function getYTMusic() {
    try {
        if (!ytmusic) {
            const YTMusicClass = YTMusic.default || YTMusic;
            ytmusic = new YTMusicClass();
            await ytmusic.initialize();
        }
        return ytmusic;
    } catch (e) {
        logNonFatalError('ytmusic-init', e);
        throw e;
    }
}

async function getInnertube() {
    if (!innertube) {
        innertube = await Innertube.create({ retrieve_player: false });
    }
    return innertube;
}

const cache = new Map();
async function withCache(key, ttl, fn) {
    const hit = cache.get(key);
    if (hit && hit.expire > Date.now()) return hit.data;
    const data = await fn();
    cache.set(key, { data, expire: Date.now() + ttl });
    return data;
}

const DEFAULT_PROXY_CHUNK_BYTES = 1024 * 1024; // 1 MiB
const ADAPTIVE_CHUNK_STEPS = [1024 * 1024, 512 * 1024, 256 * 1024, 128 * 1024, 64 * 1024, 32 * 1024, 16 * 1024, 8 * 1024, 4 * 1024];
const streamChunkHint = new Map(); // videoId -> working chunk size for open-ended ranges

function cleanLyricText(text) {
    return String(text || '')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .replace(/\[[^\]]*music[^\]]*\]/ig, '')
        .trim();
}

function sanitizeLyricsText(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    const lowered = raw.toLowerCase();
    if (lowered === 'false' || lowered === 'not found' || lowered === 'null' || lowered === 'undefined') return '';
    return raw;
}

function fmtLrcTimestamp(totalSeconds) {
    const ms = Math.max(0, Math.round(Number(totalSeconds || 0) * 1000));
    const mm = Math.floor(ms / 60000);
    const ss = Math.floor((ms % 60000) / 1000);
    const cs = Math.floor((ms % 1000) / 10);
    return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function parseJson3ToLrc(jsonText) {
    let parsed;
    try {
        parsed = JSON.parse(jsonText);
    } catch {
        return '';
    }
    const events = Array.isArray(parsed?.events) ? parsed.events : [];
    const out = [];
    let prev = '';
    for (const ev of events) {
        const startMs = Number(ev?.tStartMs);
        if (!Number.isFinite(startMs)) continue;
        const segs = Array.isArray(ev?.segs) ? ev.segs : [];
        const text = cleanLyricText(segs.map((s) => s?.utf8 || '').join(''));
        if (!text) continue;
        if (text.toLowerCase() === prev.toLowerCase()) continue;
        prev = text;
        out.push(`[${fmtLrcTimestamp(startMs / 1000)}] ${text}`);
    }
    return out.join('\n');
}

function parseVttToLrc(vtt) {
    const lines = String(vtt || '').replace(/\r/g, '').split('\n');
    const out = [];
    let currentTime = null;
    let currentText = [];
    const timePattern = /(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})/;
    const flush = () => {
        if (currentTime === null) return;
        const text = cleanLyricText(currentText.join(' '));
        if (text) out.push(`[${fmtLrcTimestamp(currentTime)}] ${text}`);
        currentTime = null;
        currentText = [];
    };
    for (const line of lines) {
        const trimmed = line.trim();
        const m = trimmed.match(timePattern);
        if (m) {
            flush();
            const hh = Number(m[1]);
            const mm = Number(m[2]);
            const ss = Number(m[3]);
            const ms = Number(m[4]);
            currentTime = hh * 3600 + mm * 60 + ss + ms / 1000;
            continue;
        }
        if (!trimmed) {
            flush();
            continue;
        }
        if (trimmed === 'WEBVTT' || /^\d+$/.test(trimmed)) continue;
        if (currentTime !== null) currentText.push(trimmed);
    }
    flush();
    return out.join('\n');
}

function pickCaptionTracks(captionsRoot) {
    const list = captionsRoot?.caption_tracks
        || captionsRoot?.captionTracks
        || captionsRoot?.playerCaptionsTracklistRenderer?.captionTracks
        || [];
    if (!Array.isArray(list)) return [];
    const score = (track) => {
        const lang = String(track?.language_code || track?.languageCode || '').toLowerCase();
        const vss = String(track?.vss_id || track?.vssId || '').toLowerCase();
        let s = 0;
        if (!vss.includes('a.')) s += 20;
        if (lang.startsWith('en')) s += 10;
        if (lang.startsWith('hi')) s += 8;
        return s;
    };
    return [...list].sort((a, b) => score(b) - score(a));
}

function withFmt(baseUrl, fmt) {
    const u = new URL(baseUrl);
    u.searchParams.set('fmt', fmt);
    return u.toString();
}

async function getTimedLyricsFromCaptions(videoId) {
    const key = `timed-lyrics-r2:${videoId}`;
    return withCache(key, 20 * 60 * 1000, async () => {
        const tube = await getInnertube();
        const info = await tube.getBasicInfo(videoId);
        const tracks = pickCaptionTracks(info?.captions);
        for (const track of tracks) {
            const baseUrl = track?.base_url || track?.baseUrl || track?.url;
            if (!baseUrl) continue;
            try {
                const json3Res = await fetch(withFmt(baseUrl, 'json3'));
                if (json3Res.ok) {
                    const json3Text = await json3Res.text();
                    const lrc = parseJson3ToLrc(json3Text);
                    if (lrc) return lrc;
                }
            } catch {}
            try {
                const vttRes = await fetch(withFmt(baseUrl, 'vtt'));
                if (vttRes.ok) {
                    const vttText = await vttRes.text();
                    const lrc = parseVttToLrc(vttText);
                    if (lrc) return lrc;
                }
            } catch {}
        }
        return '';
    });
}

function extractPlainLyrics(rawLyrics) {
    if (Array.isArray(rawLyrics)) {
        return sanitizeLyricsText(rawLyrics.map((x) => String(x || '')).join('\n'));
    }
    if (typeof rawLyrics === 'string') {
        return sanitizeLyricsText(rawLyrics);
    }
    if (rawLyrics && typeof rawLyrics === 'object') {
        const candidates = [
            rawLyrics.lyrics,
            rawLyrics.description,
            rawLyrics.text,
            rawLyrics.content,
            rawLyrics.message
        ];
        for (const value of candidates) {
            if (typeof value === 'string' && sanitizeLyricsText(value)) return sanitizeLyricsText(value);
            if (Array.isArray(value)) {
                const joined = sanitizeLyricsText(value.join('\n'));
                if (joined) return joined;
            }
        }
    }
    return '';
}

async function getPlainLyricsFromYtMusic(videoId) {
    const api = await getYTMusic();
    try {
        const direct = await api.getLyrics(videoId);
        const plain = extractPlainLyrics(direct);
        if (plain) return plain;
    } catch {}
    try {
        if (typeof api.getSong === 'function') {
            const song = await api.getSong(videoId);
            const browseId = song?.lyrics?.browseId || song?.lyricsBrowseId || song?.lyrics?.id;
            if (browseId) {
                const byBrowse = await api.getLyrics(browseId);
                const plain = extractPlainLyrics(byBrowse);
                if (plain) return plain;
            }
        }
    } catch {}
    return '';
}

async function getLrcLibSyncedLyrics(title, artist) {
    const t = String(title || '').trim();
    const a = String(artist || '').trim();
    if (!t) return '';
    const url = new URL('https://lrclib.net/api/search');
    url.searchParams.set('track_name', t);
    if (a) url.searchParams.set('artist_name', a);
    const res = await fetch(url.toString());
    if (!res.ok) return '';
    const rows = await res.json();
    const best = Array.isArray(rows) ? rows.find((r) => r?.syncedLyrics) || rows[0] : null;
    const synced = sanitizeLyricsText(best?.syncedLyrics || '');
    return synced || '';
}

function getArtistName(value) {
    if (!value) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value.name === 'string') return value.name.trim();
    if (typeof value.artist === 'string') return value.artist.trim();
    if (value.artist && typeof value.artist.name === 'string') return value.artist.name.trim();
    return '';
}

function toArtistText(item) {
    const single = getArtistName(item?.artist);
    if (single) return single;
    if (typeof item?.artists === 'string') return item.artists.trim() || 'Unknown';
    if (Array.isArray(item?.artists)) {
        const names = item.artists.map(getArtistName).filter(Boolean);
        if (names.length) return names.join(', ');
    } else if (item?.artists && typeof item.artists === 'object') {
        const names = Object.values(item.artists).map(getArtistName).filter(Boolean);
        if (names.length) return names.join(', ');
    }
    return 'Unknown';
}

function toThumb(value) {
    if (Array.isArray(value)) return getHighResThumb(value);
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
        if (typeof value.url === 'string') return value.url;
        if (Array.isArray(value.thumbnails)) return getHighResThumb(value.thumbnails);
    }
    return '';
}

function normalizeTranslateProvider(value) {
    return String(value || '').trim().toLowerCase() === 'ai' ? 'ai' : 'google';
}

function normalizeTranslateMode(value) {
    return String(value || '').trim().toLowerCase() === 'transliterate' ? 'transliterate' : 'translate';
}

function normalizeTranslateLanguage(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'en' || normalized === 'english') return 'en';
    if (normalized === 'hi' || normalized === 'hindi') return 'hi';
    return 'hi';
}

function splitTimestampPrefix(line) {
    const match = String(line).match(/^(\s*(?:\[[^\]]+\]|<[^>]+>|(?:\d{1,2}:\d{2}(?:\.\d{1,3})?))\s*)(.*)$/);
    if (!match) return { prefix: '', text: String(line || '') };
    return { prefix: match[1] || '', text: match[2] || '' };
}

async function googleTranslateText(text, targetLang) {
    const url = new URL('https://translate.googleapis.com/translate_a/single');
    url.searchParams.set('client', 'gtx');
    url.searchParams.set('sl', 'auto');
    url.searchParams.set('tl', targetLang);
    url.searchParams.set('dt', 't');
    url.searchParams.set('q', String(text || ''));
    const response = await fetch(url.toString());
    if (!response.ok) throw new Error(`Google translate failed (${response.status})`);
    const payload = await response.json();
    const parts = Array.isArray(payload?.[0]) ? payload[0] : [];
    return parts.map((part) => (Array.isArray(part) ? String(part[0] || '') : '')).join('');
}

async function translateWithGoogle(rawText, targetLang) {
    const lines = String(rawText || '').replace(/\r/g, '').split('\n');
    if (!lines.length) return '';
    const out = new Array(lines.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(8, Math.max(2, lines.length)) }, async () => {
        while (true) {
            const idx = cursor++;
            if (idx >= lines.length) return;
            const line = lines[idx];
            const { prefix, text } = splitTimestampPrefix(line);
            if (!text.trim()) {
                out[idx] = prefix.trim() ? prefix.trimEnd() : '';
                continue;
            }
            const translated = await googleTranslateText(text, targetLang);
            out[idx] = `${prefix}${translated}`.trimEnd();
        }
    });
    await Promise.all(workers);
    return out.join('\n');
}

function parseDeepseekProxyStreamPayload(rawText) {
    const lines = String(rawText || '').replace(/\r/g, '').split('\n');
    let out = '';
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
            const parsed = JSON.parse(payload);
            if (typeof parsed?.v === 'string') {
                out += parsed.v;
                continue;
            }
            if (
                parsed?.o === 'APPEND' &&
                typeof parsed?.v === 'string' &&
                String(parsed?.p || '').includes('response/fragments/-1/content')
            ) {
                out += parsed.v;
                continue;
            }
            const fragments = parsed?.v?.response?.fragments;
            if (Array.isArray(fragments)) {
                out += fragments.map((frag) => String(frag?.content || '')).join('');
            }
        } catch {}
    }
    return out.trim();
}

async function translateWithAi(rawText, to, mode) {
    const task = mode === 'transliterate' ? 'transliterate' : 'translate';
    const prompt = `Task: ${task} to ${to}
Input is LRC lyrics.
Output rules:
- Return ONLY LRC lines.
- Every non-empty output line must begin with [mm:ss.xx] or [m:ss.xx].
- Keep exact timestamp order and line count.
- Do not add greetings, explanations, markdown, code fences, labels, or extra text.
- If a line is empty in input, keep it empty.
Lyrics:
${rawText}`;
    const response = await fetch(DEEPSEEK_PROXY_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: DEEPSEEK_MODEL,
            temperature: 0,
            stream: true,
            messages: [{ role: 'user', content: prompt }]
        })
    });
    if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(errText || `AI translation failed (${response.status})`);
    }
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/event-stream')) {
        const streamText = await response.text();
        const parsed = parseDeepseekProxyStreamPayload(streamText);
        if (!parsed) throw new Error('AI translation returned empty response');
        return parsed;
    }
    const json = await response.json().catch(() => ({}));
    const direct = String(
        json?.choices?.[0]?.message?.content
        || json?.output_text
        || json?.message
        || json?.content
        || ''
    ).trim();
    if (!direct) throw new Error('AI translation returned empty response');
    return direct;
}

async function translateLyricsText(rawText, targetLang, provider, mode) {
    const raw = String(rawText || '');
    if (!raw.trim()) return '';
    const digest = crypto.createHash('sha1').update(`${provider}:${mode}:${targetLang}\n${raw}`).digest('hex');
    const key = `lyrics-translate-r2:${digest}`;
    return withCache(key, 6 * 60 * 60 * 1000, async () => {
        if (provider === 'ai') return translateWithAi(raw, targetLang, mode);
        return translateWithGoogle(raw, targetLang);
    });
}

function extractSuggestionList(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return [];
    if (Array.isArray(payload.items)) return payload.items;
    if (Array.isArray(payload.results)) return payload.results;
    if (Array.isArray(payload.contents)) return payload.contents;
    if (Array.isArray(payload.tracks)) return payload.tracks;
    return [];
}

function normalizeUpstreamRange(inputRange, chunkSize = DEFAULT_PROXY_CHUNK_BYTES) {
    const raw = String(inputRange || '').trim();
    if (!raw) return `bytes=0-${chunkSize - 1}`;
    const m = /^bytes=(\d+)-(\d*)$/i.exec(raw);
    if (!m) return raw;
    const start = Number(m[1]);
    const endRaw = m[2];
    if (!Number.isFinite(start) || start < 0) return raw;
    if (endRaw) return raw;
    return `bytes=${start}-${start + chunkSize - 1}`;
}

function getOpenEndedStart(inputRange) {
    const raw = String(inputRange || '').trim();
    if (!raw) return 0;
    const m = /^bytes=(\d+)-(\d*)$/i.exec(raw);
    if (!m) return null;
    const start = Number(m[1]);
    if (!Number.isFinite(start) || start < 0) return null;
    const endRaw = m[2];
    return endRaw ? null : start;
}

function buildAdaptiveSizes(preferredSize) {
    const sizes = [];
    const seen = new Set();
    if (Number.isFinite(preferredSize) && preferredSize > 0) {
        sizes.push(preferredSize);
        seen.add(preferredSize);
    }
    for (const n of ADAPTIVE_CHUNK_STEPS) {
        if (seen.has(n)) continue;
        sizes.push(n);
        seen.add(n);
    }
    return sizes;
}

async function fetchUpstreamStream({ streamUrl, streamCacheKey, videoId, rangeHeader }) {
    let upstreamResponse = await fetch(streamUrl, {
        headers: { Range: rangeHeader },
        redirect: 'follow'
    });
    // Retry once with a freshly resolved signed URL if cached URL was invalidated.
    if (upstreamResponse.status === 403) {
        cache.delete(streamCacheKey);
        streamUrl = await withCache(streamCacheKey, 30 * 60 * 1000, () => resolveStreamUrl(videoId));
        upstreamResponse = await fetch(streamUrl, {
            headers: { Range: rangeHeader },
            redirect: 'follow'
        });
    }
    return { upstreamResponse, streamUrl };
}

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range',
};

function logNonFatalError(label, error) {
    const detail = error?.stack || error?.message || error;
    console.warn(`[${label}]`, detail);
}

function sendJsonError(res, statusCode, message) {
    if (res.headersSent) {
        if (!res.writableEnded) {
            try {
                res.end();
            } catch (endError) {
                logNonFatalError('response-end', endError);
            }
        }
        return;
    }
    res.writeHead(statusCode, { ...corsHeaders, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
}

async function handleRequest(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
    const pathname = url.pathname;

    if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders);
        res.end();
        return;
    }

    try {
        if (pathname === '/api/search') {
            const query = url.searchParams.get('q');
            const limit = Math.max(1, Math.min(80, parseInt(url.searchParams.get('limit') || '40')));
            if (!query) throw new Error('Missing query');

            const results = await withCache(`search-r6:${query}:${limit}`, 15 * 60 * 1000, async () => {
                const api = await getYTMusic();
                const searchResults = await api.searchSongs(query);
                let combined = Array.isArray(searchResults) ? [...searchResults] : [];
                if (combined.length < limit && typeof api.search === 'function') {
                    const mixed = await api.search(query).catch(() => []);
                    const songsFromMixed = (Array.isArray(mixed) ? mixed : [])
                        .filter((item) => item?.videoId && /song|video/i.test(String(item?.type || '')));
                    combined = combined.concat(songsFromMixed);
                }
                const dedup = [];
                const seen = new Set();
                for (const item of combined) {
                    const id = String(item?.videoId || '').trim();
                    if (!id || seen.has(id)) continue;
                    seen.add(id);
                    dedup.push(item);
                    if (dedup.length >= limit) break;
                }
                return dedup.map(s => ({
                    videoId: s.videoId,
                    title: s.name,
                    artist: toArtistText(s),
                    thumb: getHighResThumb(s.thumbnails),
                    duration: s.duration || 0
                }));
            });
            res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
            res.end(JSON.stringify(results));
            return;
        }

        if (pathname === '/api/trending') {
            const limit = Math.max(1, Math.min(250, parseInt(url.searchParams.get('limit') || '200')));
            const results = await withCache(`trending-r6:${limit}`, 60 * 60 * 1000, async () => {
                const api = await getYTMusic();
                const sections = await api.getHomeSections();
                
                let allItems = [];
                for (const section of sections) {
                    const isRelevant = /charts|trending|top|hit|popular|new/i.test(section.title);
                    if (section.contents && section.contents.length > 0) {
                        const formatted = section.contents
                            .filter(v => v.videoId)
                            .map(v => ({
                                videoId: v.videoId,
                                title: v.name || v.title,
                                artist: toArtistText(v),
                                thumb: getHighResThumb(v.thumbnails),
                                duration: v.duration || 0,
                                sourceSection: section.title,
                                priority: isRelevant ? 1 : 2
                            }));
                        allItems = allItems.concat(formatted);
                    }
                }

                if (allItems.length < limit) {
                    const fallbackQueries = [
                        'trending indian songs official',
                        'new hindi songs official audio',
                        'top bollywood songs',
                        'global trending songs official audio'
                    ];
                    const fallbackResults = await Promise.allSettled(
                        fallbackQueries.map((q) => api.searchSongs(q))
                    );
                    for (const result of fallbackResults) {
                        if (result.status !== 'fulfilled' || !Array.isArray(result.value)) continue;
                        const mapped = result.value.map((s) => ({
                            videoId: s.videoId,
                            title: s.name || s.title,
                            artist: toArtistText(s),
                            thumb: getHighResThumb(s.thumbnails),
                            duration: s.duration || 0,
                            sourceSection: 'Fallback',
                            priority: 3
                        }));
                        allItems = allItems.concat(mapped);
                    }
                }

                const seen = new Set();
                return allItems
                    .sort((a, b) => a.priority - b.priority)
                    .filter(item => {
                        if (seen.has(item.videoId)) return false;
                        seen.add(item.videoId);
                        return true;
                    })
                    .slice(0, limit);
            });
            res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
            res.end(JSON.stringify(results));
            return;
        }

        if (pathname === '/api/suggest') {
            const videoId = url.searchParams.get('videoId') || url.searchParams.get('current');
            const limit = Math.max(1, Math.min(80, parseInt(url.searchParams.get('limit') || '60')));
            if (!videoId) throw new Error('Missing videoId');

            const results = await withCache(`suggest-r5:${videoId}:${limit}`, 30 * 60 * 1000, async () => {
                const api = await getYTMusic();
                const suggestions = await api.getUpNexts(videoId);
                const list = extractSuggestionList(suggestions);
                return list.map(v => ({
                    videoId: v.videoId,
                    title: v.name || v.title,
                    artist: toArtistText(v),
                    thumb: toThumb(v.thumbnails || v.thumbnail || v.thumb),
                    duration: v.duration || 0
                })).filter(x => x.videoId && x.videoId !== videoId).slice(0, limit);
            });
            res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
            res.end(JSON.stringify(results));
            return;
        }

        if (pathname === '/api/lyrics') {
            const videoId = url.searchParams.get('videoId');
            const title = url.searchParams.get('title') || '';
            const artist = url.searchParams.get('artist') || '';
            if (!videoId) throw new Error('Missing videoId');
            const results = await withCache(`lyrics-final-ext-r6:${videoId}:${title}:${artist}`, 60 * 60 * 1000, async () => {
                const syncedFromCaptions = await getTimedLyricsFromCaptions(videoId).catch(() => '');
                const syncedFromLrcLib = syncedFromCaptions ? '' : await getLrcLibSyncedLyrics(title, artist).catch(() => '');
                const plain = await getPlainLyricsFromYtMusic(videoId).catch(() => '');
                const synced = sanitizeLyricsText(syncedFromCaptions || syncedFromLrcLib || '');
                return {
                    plainLyrics: plain || '',
                    syncedLyrics: synced || '',
                    hasTimestamps: Boolean(synced)
                };
            });
            res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
            res.end(JSON.stringify(results));
            return;
        }

        if (pathname.startsWith('/api/stream/')) {
            const videoId = pathname.split('/').pop();
            try {
                // Resolve direct YouTube CDN URL
                const streamCacheKey = `stream-v1:${videoId}`;
                let streamUrl = await withCache(streamCacheKey, 30 * 60 * 1000, () => resolveStreamUrl(videoId));

                // Playback Proxy Strategy:
                // Many YouTube CDN URLs reject large open-ended ranges (bytes=N-) with 403.
                // For open-ended ranges we adapt chunk size downward until a working size is found.
                const openEndedStart = getOpenEndedStart(req.headers.range);
                let upstreamResponse = null;
                let requestedRange = '';

                if (openEndedStart !== null) {
                    const preferred = streamChunkHint.get(videoId) || DEFAULT_PROXY_CHUNK_BYTES;
                    const sizes = buildAdaptiveSizes(preferred);
                    let lastStatus = 0;
                    for (const size of sizes) {
                        requestedRange = `bytes=${openEndedStart}-${openEndedStart + size - 1}`;
                        const result = await fetchUpstreamStream({ streamUrl, streamCacheKey, videoId, rangeHeader: requestedRange });
                        upstreamResponse = result.upstreamResponse;
                        streamUrl = result.streamUrl;
                        if (upstreamResponse.ok || upstreamResponse.status === 206) {
                            streamChunkHint.set(videoId, size);
                            break;
                        }
                        lastStatus = upstreamResponse.status;
                        if (upstreamResponse.status !== 403) break;
                    }
                    if (!upstreamResponse || (!upstreamResponse.ok && upstreamResponse.status !== 206)) {
                        throw new Error(`Upstream stream request failed (${lastStatus || upstreamResponse?.status || 0})`);
                    }
                } else {
                    requestedRange = normalizeUpstreamRange(req.headers.range);
                    const result = await fetchUpstreamStream({ streamUrl, streamCacheKey, videoId, rangeHeader: requestedRange });
                    upstreamResponse = result.upstreamResponse;
                    streamUrl = result.streamUrl;
                }

                if (!upstreamResponse.ok && upstreamResponse.status !== 206) {
                    throw new Error(`Upstream stream request failed (${upstreamResponse.status})`);
                }

                const responseHeaders = {
                    ...corsHeaders,
                    'Content-Type': upstreamResponse.headers.get('content-type') || 'audio/mpeg',
                    'Accept-Ranges': 'bytes',
                    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
                    'Pragma': 'no-cache',
                    'Expires': '0'
                };

                const contentLength = upstreamResponse.headers.get('content-length');
                const contentRange = upstreamResponse.headers.get('content-range');
                if (contentLength) responseHeaders['Content-Length'] = contentLength;
                if (contentRange) responseHeaders['Content-Range'] = contentRange;

                res.writeHead(upstreamResponse.status, responseHeaders);
                
                for await (const chunk of upstreamResponse.body) {
                    res.write(chunk);
                }
                res.end();

            } catch (e) {
                logNonFatalError('playback-proxy', e);
                res.writeHead(400, corsHeaders);
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        if (pathname === '/api/translate-lyrics' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk.toString(); });
            req.on('end', async () => {
                try {
                    const parsed = JSON.parse(body);
                    const syncedLyrics = String(parsed?.syncedLyrics || '');
                    const plainLyrics = String(parsed?.plainLyrics || '');
                    const to = normalizeTranslateLanguage(parsed?.to || parsed?.language);
                    const provider = normalizeTranslateProvider(parsed?.provider);
                    const mode = normalizeTranslateMode(parsed?.mode);

                    if (!syncedLyrics.trim() && !plainLyrics.trim()) {
                        res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Missing lyrics payload' }));
                        return;
                    }

                    if (provider === 'google' && mode === 'transliterate') {
                        res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Transliteration mode is available only with AI provider' }));
                        return;
                    }

                    const sourceSynced = syncedLyrics || '';
                    const sourcePlain = plainLyrics || '';
                    const [translatedSynced, translatedPlain] = await Promise.all([
                        translateLyricsText(sourceSynced, to, provider, mode),
                        translateLyricsText(sourcePlain, to, provider, mode)
                    ]);

                    res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        syncedLyrics: translatedSynced,
                        plainLyrics: translatedPlain,
                        hasTimestamps: Boolean(syncedLyrics),
                        language: to,
                        provider,
                        mode
                    }));
                } catch (e) {
                    const status = /api key/i.test(String(e?.message || '')) ? 400 : 500;
                    res.writeHead(status, { ...corsHeaders, 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }

        // Serve Static Assets
        const publicDir = path.join(__dirname, 'public');
        let filePath = path.join(publicDir, pathname === '/' ? 'index.html' : pathname);
        
        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
             filePath = path.join(publicDir, 'index.html');
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentTypes = {
            '.html': 'text/html',
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.json': 'application/json',
            '.png': 'image/png',
            '.jpg': 'image/jpg',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml'
        };

        const contentType = contentTypes[ext] || 'application/octet-stream';
        fs.readFile(filePath, (error, content) => {
            if (error) {
                sendJsonError(res, 500, 'Error loading static file');
            } else {
                res.writeHead(200, { 'Content-Type': contentType });
                res.end(content, 'utf-8');
            }
        });

    } catch (e) {
        logNonFatalError('request-error', e);
        sendJsonError(res, 500, e?.message || 'Internal server error');
    }
}

const server = http.createServer((req, res) => {
    req.on('error', (error) => logNonFatalError('request-stream-error', error));
    res.on('error', (error) => logNonFatalError('response-stream-error', error));

    handleRequest(req, res).catch((error) => {
        logNonFatalError('unhandled-request-error', error);
        sendJsonError(res, 500, error?.message || 'Internal server error');
    });
});

server.on('clientError', (error, socket) => {
    logNonFatalError('client-error', error);
    if (!socket.destroyed) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
});

process.on('unhandledRejection', (reason) => {
    logNonFatalError('unhandled-rejection', reason);
});

process.on('uncaughtException', (error) => {
    logNonFatalError('uncaught-exception', error);
});

server.listen(PORT, HOST, () => {
    console.log(`Server running at http://${HOST}:${PORT}/`);
});
