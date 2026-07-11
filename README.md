# 🎵 RP Vibe Music (Spotify) — SillyTavern Extension

An adaptive soundtrack for your roleplay. The extension watches the scene, asks your
connected LLM what the current atmosphere is, finds a matching track on Spotify by
itself, plays it on your Spotify device, and shows a **"Now playing" info block right
inside the chat** — with album art, mood label, and playback controls.

## Features

- 🧠 **Automatic mood detection** — every N character messages the LLM quietly analyzes
  the recent scene and produces a mood + a Spotify search query (e.g.
  `dark ambient tension drone` or `epic orchestral battle choir`).
- 🎶 **Self-directed music search** — the extension searches Spotify and starts playback
  on your active device. If the vibe hasn't changed, the current track keeps playing.
- 💬 **In-chat info block** — a compact card appears inside the latest character message:
  album art, mood ("♪ tense — the duel is starting"), track, artist, and buttons:
  play/pause ▸ another track for this vibe ▸ re-analyze the scene.
- ⌨️ **`/vibe` slash command** — `/vibe` re-analyzes the scene immediately;
  `/vibe cozy lo-fi rain` forces a manual vibe.
- ⚙️ Configurable: auto mode on/off, analysis frequency, instrumental preference,
  keep or move old music blocks.

## Installation

1. In SillyTavern open **Extensions → Install extension**.
2. Paste this repository URL and install:
   ```
   https://github.com/zhungliwife-del/SjsisjskdkxkxkzbzjzksbzjsoskanN
   ```

## Spotify setup (one time, ~2 minutes)

1. Go to <https://developer.spotify.com/dashboard> and **Create app**.
   - App name / description: anything.
   - **Redirect URI**: the exact address you open SillyTavern with, e.g.
     `http://127.0.0.1:8000/`
     (Spotify no longer accepts `localhost` — use `127.0.0.1`. The trailing slash matters.)
   - Check the **Web API** checkbox and save.
2. Copy the app's **Client ID**.
3. In SillyTavern: **Extensions → 🎵 RP Vibe Music (Spotify)** → paste the Client ID,
   verify the Redirect URI field matches step 1, press **Connect Spotify** and approve.
4. Open Spotify on any device (desktop, phone, web player) so there is an active device.
5. Roleplay. The music follows.

## Notes & limitations

- **Starting/pausing playback requires Spotify Premium** (Spotify API limitation).
  Without Premium the info block still appears — tap the track title to open it in Spotify.
- Mood analysis uses your currently connected LLM via a quiet prompt, so each analysis
  costs one small generation. Tune "Analyze every N character messages" to taste.
- The Spotify refresh token is stored in your SillyTavern user settings on your machine.
- If playback fails with "No active Spotify device", just open Spotify anywhere and hit ▶
  on the in-chat block.

## Files

- `manifest.json` — extension manifest
- `index.js` — mood engine, Spotify PKCE auth + Web API client, in-chat block UI
- `style.css` — styling for the info block and settings panel
