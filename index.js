// RP Vibe Music — Spotify-powered adaptive soundtrack for SillyTavern roleplay.
// Watches the scene, asks the LLM for the current mood, finds a matching track
// on Spotify, plays it, and renders a "now playing" info block inside the chat.

const MODULE = 'rp_vibe_music';
const LOG = '[RP Vibe Music]';
const AUTH_STATE = 'rvm_spotify_auth';
const VERIFIER_KEY = 'rvm_pkce_verifier';
const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing';

const defaultSettings = {
    enabled: true,
    autoMode: true,
    inlineBlock: true,
    keepOldBlocks: false,
    preferInstrumental: true,
    moodEngine: 'auto', // 'auto' (LLM → keyword fallback) | 'llm' | 'keywords'
    messageInterval: 2,
    minSecondsBetween: 45,
    clientId: '',
    redirectUri: '',
    refreshToken: '',
};

let settings = {};
let accessToken = '';
let tokenExpiresAt = 0;
let aiMessageCounter = 0;
let lastAnalysisAt = 0;
let analyzing = false;
let isPlaying = false;
let currentTrack = null;   // { uri, name, artists, album, image, url }
let currentMood = null;    // { mood, energy, query, reason }
let searchResults = [];
let searchIndex = 0;

function getCtx() {
    return SillyTavern.getContext();
}

function getSettings() {
    const ctx = getCtx();
    if (!ctx.extensionSettings[MODULE]) {
        ctx.extensionSettings[MODULE] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (ctx.extensionSettings[MODULE][key] === undefined) {
            ctx.extensionSettings[MODULE][key] = defaultSettings[key];
        }
    }
    return ctx.extensionSettings[MODULE];
}

function save() {
    getCtx().saveSettingsDebounced();
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function status(text) {
    console.log(LOG, text);
    $('#rvm_status').text(text);
}

// ------------------------------------------------------------------ auth ---

function defaultRedirectUri() {
    return `${window.location.origin}${window.location.pathname}`;
}

function randomString(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const values = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(values, v => chars[v % chars.length]).join('');
}

async function sha256base64url(input) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function connectSpotify() {
    if (!settings.clientId) {
        status('Enter your Spotify Client ID first (developer.spotify.com → Dashboard → Create app).');
        return;
    }
    const verifier = randomString(64);
    localStorage.setItem(VERIFIER_KEY, verifier);
    const challenge = await sha256base64url(verifier);
    const params = new URLSearchParams({
        client_id: settings.clientId,
        response_type: 'code',
        redirect_uri: settings.redirectUri || defaultRedirectUri(),
        scope: SCOPES,
        code_challenge_method: 'S256',
        code_challenge: challenge,
        state: AUTH_STATE,
    });
    window.location.assign(`https://accounts.spotify.com/authorize?${params}`);
}

function disconnectSpotify() {
    settings.refreshToken = '';
    accessToken = '';
    tokenExpiresAt = 0;
    save();
    updateConnectionUi();
    status('Disconnected from Spotify.');
}

async function handleAuthCallback() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('state') !== AUTH_STATE) return;
    const code = params.get('code');
    const error = params.get('error');
    window.history.replaceState({}, document.title, window.location.pathname);
    if (error) {
        status(`Spotify authorization failed: ${error}`);
        return;
    }
    if (!code) return;
    const verifier = localStorage.getItem(VERIFIER_KEY);
    if (!verifier) {
        status('Spotify authorization failed: missing PKCE verifier. Press "Connect Spotify" again.');
        return;
    }
    try {
        const body = new URLSearchParams({
            client_id: settings.clientId,
            grant_type: 'authorization_code',
            code,
            redirect_uri: settings.redirectUri || defaultRedirectUri(),
            code_verifier: verifier,
        });
        const res = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
        if (!res.ok) {
            status(`Spotify authorization failed (HTTP ${res.status}). Check that the Redirect URI in your Spotify app matches exactly.`);
            return;
        }
        const data = await res.json();
        accessToken = data.access_token;
        tokenExpiresAt = Date.now() + data.expires_in * 1000;
        settings.refreshToken = data.refresh_token;
        save();
        localStorage.removeItem(VERIFIER_KEY);
        updateConnectionUi();
        status('Connected to Spotify ✔');
    } catch (err) {
        console.error(LOG, err);
        status(`Spotify authorization failed: ${err.message}`);
    }
}

async function ensureToken() {
    if (accessToken && Date.now() < tokenExpiresAt - 10_000) return accessToken;
    if (!settings.refreshToken) throw new Error('Not connected to Spotify');
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: settings.refreshToken,
        client_id: settings.clientId,
    });
    const res = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });
    if (!res.ok) {
        if (res.status === 400 || res.status === 401) {
            settings.refreshToken = '';
            save();
            updateConnectionUi();
        }
        throw new Error(`Spotify session expired — reconnect (HTTP ${res.status})`);
    }
    const data = await res.json();
    accessToken = data.access_token;
    tokenExpiresAt = Date.now() + data.expires_in * 1000;
    if (data.refresh_token) {
        settings.refreshToken = data.refresh_token;
        save();
    }
    return accessToken;
}

async function api(path, options = {}) {
    const token = await ensureToken();
    return fetch(`https://api.spotify.com/v1${path}`, {
        ...options,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(options.headers || {}),
        },
    });
}

// --------------------------------------------------------------- spotify ---

async function searchTracks(query) {
    const res = await api(`/search?type=track&limit=8&q=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error(`Spotify search failed (HTTP ${res.status})`);
    const data = await res.json();
    return (data.tracks?.items || []).map(t => ({
        uri: t.uri,
        name: t.name,
        artists: (t.artists || []).map(a => a.name).join(', '),
        album: t.album?.name || '',
        image: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || '',
        url: t.external_urls?.spotify || '',
    }));
}

async function playTrack(track) {
    let res = await api('/me/player/play', { method: 'PUT', body: JSON.stringify({ uris: [track.uri] }) });
    if (res.status === 404) {
        // No active device — try to grab any available one.
        const devRes = await api('/me/player/devices');
        const devices = devRes.ok ? (await devRes.json()).devices || [] : [];
        const device = devices.find(d => !d.is_restricted);
        if (!device) {
            isPlaying = false;
            return { ok: false, note: 'No active Spotify device. Open Spotify on any device, then press ▶ here.' };
        }
        res = await api(`/me/player/play?device_id=${encodeURIComponent(device.id)}`, {
            method: 'PUT',
            body: JSON.stringify({ uris: [track.uri] }),
        });
    }
    if (res.status === 403) {
        isPlaying = false;
        return { ok: false, note: 'Playback control requires Spotify Premium — tap the track title to open it in Spotify.' };
    }
    if (!res.ok && res.status !== 204) {
        isPlaying = false;
        return { ok: false, note: `Spotify playback error (HTTP ${res.status}).` };
    }
    isPlaying = true;
    return { ok: true };
}

async function togglePlayback() {
    try {
        if (isPlaying) {
            const res = await api('/me/player/pause', { method: 'PUT' });
            if (!res.ok && res.status !== 204) throw new Error(`Spotify pause failed (HTTP ${res.status})`);
            isPlaying = false;
        } else if (currentTrack) {
            const res = await api('/me/player/play', { method: 'PUT' });
            if (!res.ok && res.status !== 204) {
                const retry = await playTrack(currentTrack);
                if (!retry.ok) status(retry.note);
            } else {
                isPlaying = true;
            }
        }
        $('.rvm-btn-toggle')
            .toggleClass('fa-play', !isPlaying)
            .toggleClass('fa-pause', isPlaying);
    } catch (err) {
        status(`Error: ${err.message}`);
    }
}

async function nextTrack() {
    if (!searchResults.length) return;
    searchIndex = (searchIndex + 1) % searchResults.length;
    currentTrack = searchResults[searchIndex];
    const result = await playTrack(currentTrack);
    renderBlock(result.ok ? '' : result.note);
    status(result.ok ? `Now playing: ${currentTrack.name} — ${currentTrack.artists}` : result.note);
}

// ------------------------------------------------------------ mood engine ---

function getSceneText(maxMessages = 8) {
    const chat = getCtx().chat ?? [];
    const messages = chat.filter(m => !m.is_system && m.mes).slice(-maxMessages);
    return messages
        .map(m => `${m.name}: ${String(m.mes).replace(/<[^>]*>/g, ' ').slice(0, 600)}`)
        .join('\n');
}

function buildPrompt(sceneText) {
    const instrumental = settings.preferInstrumental
        ? 'Prefer instrumental, soundtrack, or ambient music unless lyrics strongly fit the scene.'
        : '';
    return `[Pause the roleplay.] You are a film music supervisor. Read the recent roleplay scene below and choose background music that matches its atmosphere.

SCENE:
${sceneText}

Respond with ONLY a single JSON object and nothing else, in exactly this shape:
{"mood":"1-3 word mood label","energy":5,"query":"Spotify track search query","reason":"very short explanation"}

Rules for "query": describe MUSIC, not the plot — genre + adjectives + optional era/style keywords (e.g. "dark ambient tension drone", "upbeat swing jazz playful", "epic orchestral battle choir"). Never mention character names. ${instrumental}`;
}

async function runQuiet(prompt) {
    const ctx = getCtx();
    const fn = ctx.generateQuietPrompt;
    if (!fn) throw new Error('generateQuietPrompt is not available in this SillyTavern version');
    // Newer ST versions take a params object; older ones take positional args.
    if (fn.length <= 1) {
        return await fn({ quietPrompt: prompt, quietToLoud: false, skipWIAN: true });
    }
    return await fn(prompt, false, true);
}

async function runLLM(prompt) {
    const ctx = getCtx();
    // Prefer generateRaw: it sends ONLY our short prompt (no character card, no chat
    // history), which is much faster and far less likely to hit gateway timeouts.
    const raw = ctx.generateRaw;
    if (typeof raw === 'function') {
        try {
            if (raw.length <= 1) {
                return await raw({ prompt, systemPrompt: '' });
            }
            return await raw(prompt, null, false, false);
        } catch (err) {
            console.warn(LOG, 'generateRaw failed, falling back to quiet prompt:', err);
        }
    }
    return runQuiet(prompt);
}

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
    ]);
}

// Offline mood detection — no LLM calls at all. English + Russian keywords.
const VIBE_RULES = [
    { mood: 'epic battle', query: 'epic orchestral battle intense drums choir', words: ['battle', 'fight', 'sword', 'blade', 'gun', 'attack', 'war', 'enemy', 'strike', 'clash', 'punch', 'shoot', 'бой', 'битв', 'драк', 'сраж', 'меч', 'клин', 'оруж', 'атак', 'войн', 'удар', 'враг', 'выстрел'] },
    { mood: 'horror', query: 'dark ambient horror tension drone', words: ['fear', 'horror', 'terror', 'shadow', 'monster', 'scream', 'creep', 'dread', 'nightmare', 'страх', 'ужас', 'тьм', 'тень', 'монстр', 'крик', 'жутк', 'кошмар', 'мрак'] },
    { mood: 'passionate', query: 'sensual slow smooth saxophone r&b', words: ['moan', 'passion', 'desire', 'lust', 'undress', 'sensual', 'стон', 'страст', 'желани', 'вожделен', 'постел', 'соблазн'] },
    { mood: 'romantic', query: 'romantic tender piano strings soft', words: ['kiss', 'love', 'embrace', 'tender', 'blush', 'heart', 'caress', 'gentle', 'поцелу', 'любл', 'любов', 'обним', 'объят', 'нежн', 'сердц', 'ласк', 'романт'] },
    { mood: 'sorrowful', query: 'sad melancholic piano emotional', words: ['tears', 'cry', 'crying', 'grief', 'loss', 'mourn', 'sorrow', 'weep', 'слез', 'плакал', 'плач', 'горе', 'печал', 'утрат', 'скорб', 'груст'] },
    { mood: 'mysterious', query: 'suspense noir mysterious tension strings', words: ['mystery', 'secret', 'investigate', 'clue', 'whisper', 'suspicion', 'hidden', 'тайн', 'загадк', 'секрет', 'улик', 'шепот', 'шёпот', 'подозр', 'скрыт'] },
    { mood: 'magical', query: 'fantasy magical ethereal orchestral mystical', words: ['magic', 'spell', 'wizard', 'ritual', 'arcane', 'enchant', 'маги', 'заклинан', 'волшеб', 'ритуал', 'чар', 'колд'] },
    { mood: 'adventurous', query: 'cinematic adventure journey folk orchestral', words: ['journey', 'travel', 'forest', 'road', 'mountain', 'explore', 'quest', 'путешеств', 'дорог', 'лес', 'гор', 'странств', 'поход', 'путь'] },
    { mood: 'festive', query: 'upbeat fun swing dance party', words: ['dance', 'party', 'laugh', 'festival', 'celebrate', 'drink', 'tavern', 'танц', 'вечеринк', 'смех', 'смея', 'праздник', 'весел', 'таверн'] },
    { mood: 'cozy', query: 'cozy calm acoustic warm lo-fi', words: ['cozy', 'warm', 'tea', 'coffee', 'fireplace', 'rain', 'blanket', 'calm', 'quiet', 'уют', 'тепл', 'чай', 'кофе', 'камин', 'дожд', 'плед', 'спокой', 'тиш'] },
];

function keywordMood(sceneText) {
    const text = sceneText.toLowerCase();
    let best = null;
    let bestScore = 0;
    for (const rule of VIBE_RULES) {
        let score = 0;
        for (const word of rule.words) {
            let idx = -1;
            while ((idx = text.indexOf(word, idx + 1)) !== -1) score++;
        }
        if (score > bestScore) {
            bestScore = score;
            best = rule;
        }
    }
    if (!best) {
        return { mood: 'ambient', energy: 4, query: 'cinematic ambient atmospheric instrumental', reason: 'keyword engine · default' };
    }
    return { mood: best.mood, energy: 5, query: best.query, reason: 'keyword engine' };
}

function parseMood(raw) {
    if (!raw) return null;
    const text = String(raw).replace(/```(?:json)?/gi, '');
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
        try {
            const parsed = JSON.parse(match[0]);
            if (parsed && typeof parsed.query === 'string' && parsed.query.trim()) {
                return {
                    mood: String(parsed.mood || 'vibe').slice(0, 60),
                    energy: Number(parsed.energy) || 5,
                    query: parsed.query.trim().slice(0, 120),
                    reason: String(parsed.reason || '').slice(0, 140),
                };
            }
        } catch { /* fall through */ }
    }
    // Fallback: use the raw reply as a search query.
    const fallback = text.trim().split('\n')[0].slice(0, 100);
    return fallback ? { mood: 'vibe', energy: 5, query: fallback, reason: '' } : null;
}

async function analyzeAndPlay({ force = false, hint = '' } = {}) {
    if (analyzing) return;
    if (!settings.enabled) return;
    if (!settings.refreshToken) {
        status('Connect Spotify first (Extensions → RP Vibe Music).');
        return;
    }
    analyzing = true;
    try {
        let mood;
        if (hint) {
            mood = { mood: hint.slice(0, 60), energy: 5, query: hint, reason: 'manual override' };
        } else {
            const scene = getSceneText();
            if (!scene) {
                status('No messages to analyze yet.');
                return;
            }
            const engine = settings.moodEngine || 'auto';
            if (engine !== 'keywords') {
                status('Analyzing the scene mood…');
                try {
                    const raw = await withTimeout(runLLM(buildPrompt(scene)), 90_000, 'LLM analysis timed out');
                    mood = parseMood(raw);
                } catch (err) {
                    console.warn(LOG, 'LLM mood analysis failed:', err);
                    if (engine === 'llm') {
                        status(`Mood analysis failed: ${err.message}`);
                        return;
                    }
                }
            }
            if (!mood?.query) {
                mood = keywordMood(scene);
            }
        }
        if (!mood?.query) {
            status('Could not determine a vibe from the scene.');
            return;
        }
        if (!force && currentTrack && currentMood?.query &&
            mood.query.toLowerCase() === currentMood.query.toLowerCase()) {
            lastAnalysisAt = Date.now();
            aiMessageCounter = 0;
            status(`Vibe unchanged (${mood.mood}) — keeping the current track.`);
            return;
        }
        status(`Searching Spotify: "${mood.query}"…`);
        const results = await searchTracks(mood.query);
        if (!results.length) {
            status(`No tracks found for "${mood.query}".`);
            return;
        }
        currentMood = mood;
        searchResults = results;
        searchIndex = 0;
        currentTrack = results[0];
        const result = await playTrack(currentTrack);
        lastAnalysisAt = Date.now();
        aiMessageCounter = 0;
        renderBlock(result.ok ? '' : result.note);
        status(result.ok
            ? `Now playing: ${currentTrack.name} — ${currentTrack.artists} (${mood.mood})`
            : result.note);
    } catch (err) {
        console.error(LOG, err);
        status(`Error: ${err.message}`);
    } finally {
        analyzing = false;
    }
}

// ------------------------------------------------------------- chat block ---

function renderBlock(note = '') {
    if (!settings.keepOldBlocks) {
        $('#chat .rvm-block').remove();
    }
    if (!settings.inlineBlock || !currentTrack) return;
    const target = $('#chat .mes[is_user="false"]').not('[is_system="true"]').last().find('.mes_text');
    if (!target.length) return;
    target.find('.rvm-block').remove();
    const t = currentTrack;
    const m = currentMood;
    const html = `
    <div class="rvm-block">
        ${t.image ? `<img class="rvm-art" src="${esc(t.image)}" alt="">` : ''}
        <div class="rvm-meta">
            <div class="rvm-mood">♪ ${esc(m?.mood || 'vibe')}${m?.reason ? ` — ${esc(m.reason)}` : ''}</div>
            <a class="rvm-title" href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.name)}</a>
            <div class="rvm-artist">${esc(t.artists)}</div>
            ${note ? `<div class="rvm-note">${esc(note)}</div>` : ''}
        </div>
        <div class="rvm-controls">
            <div class="rvm-btn rvm-btn-toggle fa-solid ${isPlaying ? 'fa-pause' : 'fa-play'}" title="Play / Pause"></div>
            <div class="rvm-btn rvm-btn-next fa-solid fa-forward" title="Another track for this vibe"></div>
            <div class="rvm-btn rvm-btn-reroll fa-solid fa-arrows-rotate" title="Re-analyze the scene"></div>
        </div>
    </div>`;
    target.append(html);
}

// ----------------------------------------------------------------- events ---

function onCharacterMessage() {
    if (!settings.enabled || !settings.autoMode || !settings.refreshToken) return;
    aiMessageCounter++;
    if (aiMessageCounter < Math.max(1, Number(settings.messageInterval) || 1)) return;
    if (Date.now() - lastAnalysisAt < (Number(settings.minSecondsBetween) || 0) * 1000) return;
    setTimeout(() => analyzeAndPlay(), 800);
}

// -------------------------------------------------------------- settings UI ---

const settingsHtml = `
<div class="rvm-ext-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>🎵 RP Vibe Music (Spotify)</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label"><input id="rvm_enabled" type="checkbox"><span>Enabled</span></label>
            <label class="checkbox_label"><input id="rvm_auto" type="checkbox"><span>Auto mode — adapt music to the scene</span></label>
            <label class="checkbox_label"><input id="rvm_inline" type="checkbox"><span>Show "Now playing" block in chat</span></label>
            <label class="checkbox_label"><input id="rvm_keep" type="checkbox"><span>Keep old music blocks in chat</span></label>
            <label class="checkbox_label"><input id="rvm_instr" type="checkbox"><span>Prefer instrumental / soundtrack music</span></label>
            <label>Mood engine
                <select id="rvm_engine" class="text_pole">
                    <option value="auto">LLM with keyword fallback (default)</option>
                    <option value="llm">LLM only</option>
                    <option value="keywords">Keywords only — no LLM calls</option>
                </select>
            </label>
            <label>Analyze every N character messages
                <input id="rvm_interval" type="number" min="1" max="20" class="text_pole">
            </label>
            <hr>
            <label>Spotify Client ID
                <input id="rvm_client_id" type="text" class="text_pole" placeholder="from developer.spotify.com">
            </label>
            <label>Redirect URI (must match your Spotify app exactly)
                <input id="rvm_redirect" type="text" class="text_pole">
            </label>
            <div class="rvm-btnrow">
                <div id="rvm_connect" class="menu_button">Connect Spotify</div>
                <div id="rvm_disconnect" class="menu_button">Disconnect</div>
                <div id="rvm_analyze" class="menu_button">Analyze now</div>
            </div>
            <div id="rvm_status" class="rvm-status">Not connected.</div>
            <small>Playback control needs Spotify Premium. Use <code>/vibe</code> to re-analyze the scene, or <code>/vibe dark epic orchestral</code> to force a vibe.</small>
        </div>
    </div>
</div>`;

function addSettingsUi() {
    const container = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    container.append(settingsHtml);

    $('#rvm_enabled').prop('checked', settings.enabled).on('change', function () { settings.enabled = this.checked; save(); });
    $('#rvm_auto').prop('checked', settings.autoMode).on('change', function () { settings.autoMode = this.checked; save(); });
    $('#rvm_inline').prop('checked', settings.inlineBlock).on('change', function () { settings.inlineBlock = this.checked; save(); if (!this.checked) $('#chat .rvm-block').remove(); });
    $('#rvm_keep').prop('checked', settings.keepOldBlocks).on('change', function () { settings.keepOldBlocks = this.checked; save(); });
    $('#rvm_instr').prop('checked', settings.preferInstrumental).on('change', function () { settings.preferInstrumental = this.checked; save(); });
    $('#rvm_engine').val(settings.moodEngine || 'auto').on('change', function () { settings.moodEngine = this.value; save(); });
    $('#rvm_interval').val(settings.messageInterval).on('input', function () { settings.messageInterval = Math.max(1, Number(this.value) || 1); save(); });
    $('#rvm_client_id').val(settings.clientId).on('input', function () { settings.clientId = this.value.trim(); save(); });
    $('#rvm_redirect').val(settings.redirectUri).on('input', function () { settings.redirectUri = this.value.trim(); save(); });

    $('#rvm_connect').on('click', connectSpotify);
    $('#rvm_disconnect').on('click', disconnectSpotify);
    $('#rvm_analyze').on('click', () => analyzeAndPlay({ force: true }));

    // Inline block controls (delegated — blocks are created dynamically).
    $(document).on('click', '.rvm-btn-toggle', togglePlayback);
    $(document).on('click', '.rvm-btn-next', nextTrack);
    $(document).on('click', '.rvm-btn-reroll', () => analyzeAndPlay({ force: true }));
}

function updateConnectionUi() {
    const connected = !!settings.refreshToken;
    $('#rvm_connect').toggle(!connected);
    $('#rvm_disconnect').toggle(connected);
    if (connected) status('Connected to Spotify.');
}

// --------------------------------------------------------- slash commands ---

function registerCommands() {
    const ctx = getCtx();
    const handler = (_namedArgs, text) => {
        const hint = typeof text === 'string' ? text.trim() : '';
        analyzeAndPlay({ force: true, hint });
        return '';
    };
    try {
        if (ctx.SlashCommandParser?.addCommandObject && ctx.SlashCommand?.fromProps) {
            const unnamedArgumentList = ctx.SlashCommandArgument?.fromProps
                ? [ctx.SlashCommandArgument.fromProps({
                    description: 'optional manual vibe / music search query',
                    typeList: ['string'],
                    isRequired: false,
                })]
                : [];
            ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
                name: 'vibe',
                callback: handler,
                unnamedArgumentList,
                helpString: 'Adapt Spotify music to the current RP scene. Optionally force a vibe: /vibe dark epic orchestral',
            }));
            return;
        }
    } catch (err) {
        console.warn(LOG, 'Modern slash command registration failed, falling back.', err);
    }
    try {
        ctx.registerSlashCommand?.('vibe', handler, [], '– adapt Spotify music to the current RP scene', true, true);
    } catch (err) {
        console.warn(LOG, 'Slash command registration failed.', err);
    }
}

// ------------------------------------------------------------------- init ---

jQuery(async () => {
    settings = getSettings();
    if (!settings.redirectUri) {
        settings.redirectUri = defaultRedirectUri();
    }
    addSettingsUi();
    await handleAuthCallback();
    updateConnectionUi();

    const ctx = getCtx();
    ctx.eventSource.on(ctx.eventTypes.CHARACTER_MESSAGE_RENDERED, onCharacterMessage);
    ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => { aiMessageCounter = 0; });

    registerCommands();
    console.log(LOG, 'loaded');
});
