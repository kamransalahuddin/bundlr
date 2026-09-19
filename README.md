# Bundlr

This project is a local-first Chrome extension plus helper server for turning Canvas course data and lecture/podcast pages into an AI-ready course bin.

The bin is a real folder on disk, for example `bins/Math 60`, with:

- `context.md`: the main drag-and-drop context file for ChatGPT, Gemini, Claude, or another AI.
- `canvas.json` and `canvas/*.json`: raw Canvas API captures.
- `media/*.mp4`: downloaded and converted lecture media when `ffmpeg` can access the source.
- `transcripts/*.txt`: captions from the page or local Whisper transcription output.

## What Works Now

- Scrapes the active Canvas course through your logged-in browser session.
- Captures assignments, discussion topics and posts, pages, modules, file metadata, and text-readable Canvas files.
- Saves Canvas readings/files into the bin through chunked authenticated browser uploads.
- Extracts PDF/text/notebook reading text into `context.md` when possible.
- Scans the active lecture/podcast page for video, audio, linked media, and caption tracks.
- Scans loaded page resources, iframes, and page source for HLS streams such as `index.m3u8`.
- Converts downloaded media to MP4 when local `ffmpeg` is installed.
- Pulls transcripts from page captions. If no captions are available, it can use local Whisper when installed.
- Builds a drag-ready organized context ZIP containing only AI-useful files.
- Keeps a named bin updated and can auto-sync an already-open Canvas course on a timer while Chrome is running.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Optional but recommended: install `ffmpeg` for MP4 conversion.

   ```bash
   brew install ffmpeg
   ```

3. Optional local transcription for media with no captions:

   ```bash
   brew install whisper-cpp
   mkdir -p models
   curl -L -o models/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
   ```

4. Start the helper:

   ```bash
   npm run helper
   ```

5. Load the Chrome extension:

   - Open `chrome://extensions`.
   - Enable Developer mode.
   - Click Load unpacked.
   - Select the `extension` folder in this project.

## Use

1. Log into Canvas in Chrome and open a course page like `/courses/12345`.
2. Open the extension popup.
3. Set a bin name such as `Math 60`.
4. Click `Sync Canvas course`.
5. Open each protected lecture or podcast page after logging in.
6. Click `Capture lecture page`.
7. Use `Download context` and drag the ZIP into your AI chat, or drag/upload `bins/Math 60/context.md` plus any files from the bin.

For UCSD podcast pages, press play and let the lecture run for a few seconds before clicking `Capture lecture transcript`. Some players only expose their `index.m3u8` stream after playback starts.

## Important Limits

Canvas and lecture platforms rely on your login session. The extension can read what your browser session can read, but protected media downloads may still fail if a site uses short-lived DRM, HLS playlists with protected segments, or cookies that cannot be replayed by the local helper. In that case, captions and source links are still added to the bin, and the item is marked as needing manual auth/download.

Chrome extensions also cannot silently maintain arbitrary folders forever without a local component. That is why the helper exists: it writes the durable bin, runs `ffmpeg`, and optionally calls speech-to-text.

## Development

Run tests:

```bash
npm test
```

Run helper:

```bash
npm run helper
```
