import { promises as fs } from "node:fs";
import { basename, join, relative } from "node:path";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { safeName, fileSlug } from "./sanitize.mjs";
import { renderContext } from "./render-context.mjs";
import { captureYouTubeTranscript, convertToMp4, downloadFile, downloadMedia, extractAudio, hasFfmpeg, hasLocalWhisper, hasYtDlp, transcribeWithLocalWhisper } from "./media-tools.mjs";
import { vttToText } from "./text.mjs";
import { extractReadableText } from "./file-text.mjs";
import { createZipBundle } from "./bundle.mjs";
import { createAiUploadSet } from "./upload-set.mjs";
import { getKalturaCaptions } from "./kaltura.mjs";

export class BinStore {
  constructor({ root }) {
    this.root = root;
    this.uploads = new Map();
    this.mediaJobs = new Map();
  }

  async info() {
    await fs.mkdir(this.root, { recursive: true });
    return {
      binRoot: this.root,
      ffmpeg: await hasFfmpeg(),
      localWhisper: await hasLocalWhisper(),
      ytDlp: await hasYtDlp()
    };
  }

  binPath(binName) {
    return join(this.root, safeName(binName));
  }

  async syncCanvas(binName, course) {
    const dir = this.binPath(binName || course?.name);
    await this.ensureBin(dir);
    await fs.mkdir(join(dir, "raw"), { recursive: true });
    await this.writeCanvasArtifacts(dir, course);
    await fs.writeFile(join(dir, "raw", `canvas-${Date.now()}.json`), JSON.stringify(course, null, 2));
    await pruneDirectory(join(dir, "raw"), { keep: 3, match: /^canvas-\d+\.json$/ });
    await fs.writeFile(join(dir, "canvas.json"), JSON.stringify(course, null, 2));
    const contextPath = await this.rebuildContext(binName || course?.name);
    return {
      binPath: dir,
      contextPath
    };
  }

  async downloadCanvasFiles(binName, files = []) {
    const dir = this.binPath(binName);
    await this.ensureBin(dir);
    const fileDir = join(dir, "readings", "files");
    await fs.mkdir(fileDir, { recursive: true });
    const course = await this.readJson(join(dir, "canvas.json"), null);
    const existingFiles = course?.files || [];
    const byIdentity = new Map(existingFiles.map((file) => [String(file.id || file.url || file.filename), file]));
    const downloaded = [];
    const failed = [];

    for (const file of files) {
      const key = String(file.id || file.url || file.filename);
      const record = { ...(byIdentity.get(key) || file) };
      if (!file.url) {
        record.binaryStatus = "missing-url";
        failed.push(record);
        byIdentity.set(key, record);
        continue;
      }
      try {
        const savedPath = await downloadFile(file.url, fileDir, file.filename || file.displayName || `canvas-file-${file.id || Date.now()}`);
        record.localPath = relative(dir, savedPath);
        record.binaryStatus = "saved";
        record.extractedText = await extractReadableText(savedPath, {
          contentType: file.contentType,
          maxChars: 250000
        }).catch((error) => {
          record.textStatus = `extract-failed: ${error.message}`;
          return "";
        });
        if (record.extractedText) record.textStatus = "extracted";
        downloaded.push(record);
      } catch (error) {
        record.binaryStatus = `download-failed: ${error.message}`;
        failed.push(record);
      }
      byIdentity.set(key, record);
    }

    if (course) {
      course.files = [...byIdentity.values()];
      await fs.writeFile(join(dir, "canvas.json"), JSON.stringify(course, null, 2));
      await fs.writeFile(join(dir, "canvas", "files.json"), JSON.stringify(course.files, null, 2));
      await this.rebuildContext(binName);
    }

    return { downloaded, failed };
  }

  async startCanvasFileUpload(binName, file) {
    const dir = this.binPath(binName);
    await this.ensureBin(dir);
    const uploadId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const fileDir = join(dir, "readings", "files");
    await fs.mkdir(fileDir, { recursive: true });
    const targetName = `${fileSlug(file.id || "file")}-${fileSlug(file.filename || file.displayName || basename(file.url || "canvas-file"))}`;
    const targetPath = join(fileDir, targetName);
    await fs.writeFile(targetPath, Buffer.alloc(0));
    this.uploads.set(uploadId, {
      binName,
      dir,
      file,
      targetPath,
      receivedBytes: 0
    });
    return { uploadId, targetPath: relative(dir, targetPath) };
  }

  async appendCanvasFileUpload(uploadId, chunk) {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw new Error("Unknown upload session.");
    await fs.appendFile(upload.targetPath, chunk);
    upload.receivedBytes += chunk.length;
    return { receivedBytes: upload.receivedBytes };
  }

  async finishCanvasFileUpload(uploadId) {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw new Error("Unknown upload session.");
    this.uploads.delete(uploadId);

    const coursePath = join(upload.dir, "canvas.json");
    const course = await this.readJson(coursePath, null);
    const record = {
      ...upload.file,
      localPath: relative(upload.dir, upload.targetPath),
      binaryStatus: "saved",
      size: upload.file.size || upload.receivedBytes
    };
    record.extractedText = await extractReadableText(upload.targetPath, {
      contentType: record.contentType,
      maxChars: 250000
    }).catch((error) => {
      record.textStatus = `extract-failed: ${error.message}`;
      return "";
    });
    if (record.extractedText) record.textStatus = "extracted";

    if (course) {
      const files = course.files || [];
      const key = String(record.id || record.url || record.filename);
      const nextFiles = files.filter((file) => String(file.id || file.url || file.filename) !== key);
      nextFiles.push(record);
      course.files = nextFiles;
      await fs.writeFile(coursePath, JSON.stringify(course, null, 2));
      await fs.writeFile(join(upload.dir, "canvas", "files.json"), JSON.stringify(course.files, null, 2));
      await this.rebuildContext(upload.binName);
    }

    return record;
  }

  async createBundle(binName) {
    const dir = this.binPath(binName);
    const course = await this.readJson(join(dir, "canvas.json"), null);
    const media = await this.readJson(join(dir, "media.json"), []);
    await this.rebuildContext(binName);
    const bundlePath = await createZipBundle({ binRoot: this.root, binName, course, media });
    return { bundlePath };
  }

  async createUploadSet(binName) {
    return createAiUploadSet({ binRoot: this.root, binName });
  }

  async readUploadSetFile(binName, relativePath) {
    const uploadSet = await this.createUploadSet(binName);
    const record = uploadSet.files.find((file) => file.filename === relativePath);
    if (!record) throw new Error("Upload set file not found.");
    return record;
  }

  async exportFolder(binName) {
    const safe = safeName(binName);
    const source = this.binPath(safe);
    const target = join(homedir(), "Downloads", safe);
    await this.createUploadSet(safe);
    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(target, { recursive: true });
    await fs.cp(source, target, {
      recursive: true,
      force: true,
      filter: (path) => !path.includes(`${join("_bundles")}`)
    });
    await this.cleanExportFolder(target);
    spawn("open", [target], { stdio: "ignore", detached: true }).unref();
    return { folderPath: target };
  }

  async cleanExportFolder(target) {
    await Promise.all([
      fs.rm(join(target, "canvas"), { recursive: true, force: true }),
      fs.rm(join(target, "raw"), { recursive: true, force: true }),
      fs.rm(join(target, "canvas.json"), { force: true }),
      fs.rm(join(target, "media.json"), { force: true }),
      fs.rm(join(target, "manifest.json"), { force: true })
    ]);
  }

  async deleteBin(binName) {
    const safe = safeName(binName);
    const dir = this.binPath(safe);
    const bundlePath = join(this.root, "_bundles", `${safe}.zip`);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(bundlePath, { force: true });
    return { deleted: true, binName: safe };
  }

  async createAllContext(binName) {
    const contextPath = await this.rebuildContext(binName);
    const dir = this.binPath(binName);
    return {
      contextPath,
      textPath: join(dir, "all-context.txt")
    };
  }

  async revealBundle(binName) {
    const { bundlePath } = await this.createBundle(binName);
    spawn("open", ["-R", bundlePath], { stdio: "ignore", detached: true }).unref();
    return { bundlePath };
  }

  startMediaCaptureJob(binName, page, mediaItems, options = {}) {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const job = {
      id,
      status: "running",
      message: "Starting lecture conversion...",
      startedAt: new Date().toISOString(),
      result: null,
      error: null
    };
    this.mediaJobs.set(id, job);
    this.captureMedia(binName, page, mediaItems, (message) => {
      job.message = message;
      job.updatedAt = new Date().toISOString();
    }, options)
      .then((result) => {
        job.status = "done";
        job.message = "Lecture capture finished.";
        job.result = result;
        job.updatedAt = new Date().toISOString();
      })
      .catch((error) => {
        job.status = "error";
        job.message = "Lecture capture failed.";
        job.error = error.message;
        job.updatedAt = new Date().toISOString();
      });
    return job;
  }

  getMediaJob(id) {
    const job = this.mediaJobs.get(id);
    if (!job) throw new Error("Unknown media job.");
    return job;
  }

  async captureMedia(binName, page, mediaItems, update = () => undefined, options = {}) {
    const dir = this.binPath(binName);
    await this.ensureBin(dir);
    const mediaDir = join(dir, "media");
    const transcriptDir = join(dir, "transcripts");
    await fs.mkdir(mediaDir, { recursive: true });
    await fs.mkdir(transcriptDir, { recursive: true });
    const existing = cleanMediaRecords(await this.readJson(join(dir, "media.json"), []));
    const saved = [];
    const needsAttention = [];
    const ffmpeg = await hasFfmpeg();
    const keepMp4 = false;
    const captureAll = options.all === true;

    const itemsToProcess = selectMediaItems(mediaItems, { all: captureAll });
    const existingKeys = new Set(existing
      .filter(isCompleteMediaRecord)
      .flatMap(recordDedupeKeys));
    update(captureAll
      ? `Found ${itemsToProcess.length} lecture(s); transcribing them one by one.`
      : `Found ${mediaItems?.length || 0} media candidate(s); using best lecture candidate.`);
    for (const [index, item] of itemsToProcess.entries()) {
      const incomingKeys = mediaItemDedupeKeys(item);
      if (captureAll && incomingKeys.some((key) => existingKeys.has(key))) {
        update(`Lecture ${index + 1}/${itemsToProcess.length}: real transcript/no-audio status already captured, skipping.`);
        continue;
      }
      const source = item.sources?.[0] || item.captions?.[0]?.src || null;
      const title = item.title || item.pageTitle || page?.title || "Lecture media";
      const requestHeaders = item.requestHeaders || {};
      const record = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        title,
        pageTitle: item.pageTitle || page?.title,
        pageUrl: item.pageUrl || page?.url,
        lectureIndex: item.lectureIndex || (captureAll ? index + 1 : undefined),
        lectureLabel: item.lectureLabel,
        kalturaEntryId: item.kaltura?.entryId,
        capturedAt: page?.capturedAt || new Date().toISOString(),
        source,
        status: "saved"
      };

      update(`${captureAll ? `Lecture ${index + 1}/${itemsToProcess.length}: ` : ""}Checking for exposed captions...`);
      const kalturaCaptions = item.kaltura ? await getKalturaCaptions(item.kaltura).catch((error) => {
        record.status = `kaltura caption lookup failed: ${error.message}`;
        return [];
      }) : [];
      if (kalturaCaptions.length) {
        item.captions = [...(item.captions || []), ...kalturaCaptions];
      }

      const caption = (item.captions || [])
        .map((candidate) => ({
          ...candidate,
          transcriptText: transcriptFromCaption(candidate)
        }))
        .find((candidate) => candidate.transcriptText);
      if (caption?.transcriptText) {
        const transcriptPath = join(transcriptDir, `${fileSlug(title)}-${Date.now()}.txt`);
        const transcriptText = caption.transcriptText;
        await fs.writeFile(transcriptPath, transcriptText);
        record.captionText = caption.text;
        record.transcriptText = transcriptText;
        record.transcriptPath = relative(dir, transcriptPath);
        record.status = "caption transcript captured";
      } else if ((item.captions || []).some((candidate) => candidate.text)) {
        record.status = "caption track was empty; trying lecture audio";
      }

      const youtubeSource = (item.sources || []).find(isYouTubeUrl);
      if (youtubeSource && !record.transcriptText) {
        update(`${captureAll ? `Lecture ${index + 1}/${itemsToProcess.length}: ` : ""}Checking YouTube captions...`);
        const transcriptText = await captureYouTubeTranscript(youtubeSource, transcriptDir, title).catch(() => null);
        if (hasUsefulTranscript(transcriptText)) {
          const transcriptPath = join(transcriptDir, `${fileSlug(title)}-${Date.now()}.txt`);
          await fs.writeFile(transcriptPath, transcriptText);
          record.transcriptText = transcriptText;
          record.transcriptPath = relative(dir, transcriptPath);
          record.status = "YouTube caption transcript captured";
        } else {
          record.status = await hasYtDlp()
            ? "YouTube lecture found; no usable captions exposed"
            : "YouTube lecture found; install yt-dlp to capture captions";
          needsAttention.push(record);
        }
      }

      if (youtubeSource && !record.transcriptText) {
        // YouTube pages are not direct media files; yt-dlp handles those separately above.
      } else if (item.sources?.length && ffmpeg && (!record.transcriptText || keepMp4)) {
        update(`${captureAll ? `Lecture ${index + 1}/${itemsToProcess.length}: ` : ""}Converting lecture stream...`);
        const converted = await convertFirstWorkingSource({
          item,
          title,
          dir,
          mediaDir,
          requestHeaders,
          record
        });
        if (!converted.ok) {
          record.status = `needs manual auth/download: ${converted.errors.join(" | ")}`;
          needsAttention.push(record);
        } else {
          const mp4 = converted.mp4;
          if (keepMp4) record.mp4Path = relative(dir, mp4);
          if (!record.transcriptText) {
            update(`${captureAll ? `Lecture ${index + 1}/${itemsToProcess.length}: ` : ""}Extracting lecture audio...`);
            const audio = await extractAudio(mp4, join(mediaDir, "audio"), title).catch(() => null);
            if (audio) {
              record.audioPath = relative(dir, audio);
              update(`${captureAll ? `Lecture ${index + 1}/${itemsToProcess.length}: ` : ""}Generating transcript locally with Whisper...`);
              const transcriptText = await transcribeAudio(audio, {
                targetDir: transcriptDir,
                title
              });
              if (transcriptText) {
                const transcriptPath = join(transcriptDir, `${fileSlug(title)}-${Date.now()}.txt`);
                await fs.writeFile(transcriptPath, transcriptText);
                record.transcriptText = transcriptText;
                record.transcriptPath = relative(dir, transcriptPath);
                record.status = "transcribed with local Whisper";
                if (!keepMp4) {
                  await removeFile(audio);
                  delete record.audioPath;
                }
              } else {
                record.status = "video captured; no audible lecture speech detected";
              }
            } else {
              record.status = "lecture stream found; audio extraction failed";
            }
          }
          if (!keepMp4) await removeFile(mp4);
        }
      } else if (item.sources?.length && !ffmpeg) {
        record.status = "media found, but ffmpeg is required to convert lectures to mp4";
        needsAttention.push(record);
      }

      if (!keepMp4) {
        await removeRelativeFile(dir, record.downloadedPath);
        delete record.downloadedPath;
        if (record.transcriptText || record.transcriptPath) delete record.mp4Path;
      }

      saved.push(record);
      if (isCompleteMediaRecord(record)) {
        for (const key of recordDedupeKeys(record)) existingKeys.add(key);
      }
    }

    await fs.writeFile(join(dir, "media.json"), JSON.stringify(mergeMediaRecords(existing, saved), null, 2));
    await this.rebuildContext(binName);
    return { saved, needsAttention };
  }

  async rebuildContext(binName) {
    const dir = this.binPath(binName);
    await this.ensureBin(dir);
    await this.cleanTranscriptArtifacts(dir);
    const course = await this.readJson(join(dir, "canvas.json"), null);
    const mediaPath = join(dir, "media.json");
    const existingMedia = await this.readJson(mediaPath, []);
    const media = cleanMediaRecords([
      ...(await this.readTranscriptRecords(dir, existingMedia)),
      ...existingMedia
    ]);
    await fs.writeFile(mediaPath, JSON.stringify(media, null, 2)).catch(() => undefined);
    await this.pruneUnreferencedTranscripts(dir, media);
    const context = renderContext({ binName: safeName(binName), course, media });
    const contextPath = join(dir, "context.md");
    const allContextPath = join(dir, "all-context.txt");
    await fs.writeFile(contextPath, context);
    await fs.writeFile(allContextPath, context);
    await fs.writeFile(join(dir, "manifest.json"), JSON.stringify({
      binName: safeName(binName),
      updatedAt: new Date().toISOString(),
      contextPath,
      allContextPath,
      bundleHint: join(this.root, "_bundles", `${safeName(binName)}.zip`),
      canvas: Boolean(course),
      mediaCount: media.length
    }, null, 2));
    return contextPath;
  }

  async readContext(binName) {
    const dir = this.binPath(binName);
    const path = join(dir, "context.md");
    try {
      return await fs.readFile(path, "utf8");
    } catch {
      await this.rebuildContext(binName);
      return fs.readFile(path, "utf8");
    }
  }

  async ensureBin(dir) {
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(join(dir, "canvas"), { recursive: true });
    await fs.mkdir(join(dir, "media"), { recursive: true });
    await fs.mkdir(join(dir, "readings", "files"), { recursive: true });
    await fs.mkdir(join(dir, "transcripts"), { recursive: true });
  }

  async writeCanvasArtifacts(dir, course) {
    const canvasDir = join(dir, "canvas");
    const fileDir = join(canvasDir, "files");
    await fs.mkdir(canvasDir, { recursive: true });
    await fs.mkdir(fileDir, { recursive: true });
    const files = [];
    for (const file of course.files || []) {
      const cleaned = { ...file };
      delete cleaned.binary;
      files.push(cleaned);
    }
    course.files = files;
    await fs.writeFile(join(canvasDir, "assignments.json"), JSON.stringify(course.assignments || [], null, 2));
    await fs.writeFile(join(canvasDir, "discussions.json"), JSON.stringify(course.discussions || [], null, 2));
    await fs.writeFile(join(canvasDir, "files.json"), JSON.stringify(files, null, 2));
    await fs.writeFile(join(canvasDir, "modules.json"), JSON.stringify(course.modules || [], null, 2));
    await fs.writeFile(join(canvasDir, "pages.json"), JSON.stringify(course.pages || [], null, 2));
  }

  async readTranscriptRecords(dir, existingMedia = []) {
    const transcriptDir = join(dir, "transcripts");
    const referenced = new Set((existingMedia || [])
      .map((record) => record.transcriptPath)
      .filter(Boolean));
    const records = [];
    for (const name of await fs.readdir(transcriptDir).catch(() => [])) {
      if (!name.endsWith(".txt")) continue;
      const transcriptPath = join("transcripts", name);
      if (referenced.has(transcriptPath)) continue;
      const text = await fs.readFile(join(transcriptDir, name), "utf8").catch(() => "");
      if (!hasUsefulTranscript(text)) continue;
      records.push({
        id: `transcript-${name}`,
        title: titleFromTranscriptFile(name),
        capturedAt: new Date().toISOString(),
        transcriptText: text,
        transcriptPath,
        status: "transcript file recovered"
      });
    }
    return records;
  }

  async cleanTranscriptArtifacts(dir) {
    const transcriptDir = join(dir, "transcripts");
    for (const name of await fs.readdir(transcriptDir).catch(() => [])) {
      if (!name.endsWith(".txt")) continue;
      const path = join(transcriptDir, name);
      const text = await fs.readFile(path, "utf8").catch(() => "");
      if (!hasUsefulTranscript(text)) await removeFile(path);
    }
  }

  async pruneUnreferencedTranscripts(dir, media = []) {
    const transcriptDir = join(dir, "transcripts");
    const referenced = new Set(media.map((record) => record.transcriptPath).filter(Boolean));
    for (const name of await fs.readdir(transcriptDir).catch(() => [])) {
      if (!name.endsWith(".txt")) continue;
      const relativePath = join("transcripts", name);
      if (!referenced.has(relativePath)) await removeFile(join(transcriptDir, name));
    }
  }

  async readJson(path, fallback) {
    try {
      return JSON.parse(await fs.readFile(path, "utf8"));
    } catch {
      return fallback;
    }
  }
}

function prioritizeMediaItems(items = []) {
  return [...items].sort((left, right) => scoreMedia(right) - scoreMedia(left));
}

function selectMediaItems(items = [], { all = false } = {}) {
  const prioritized = prioritizeMediaItems(items);
  if (!all) return prioritized.slice(0, 1);
  const byKey = new Map();
  for (const item of prioritized) {
    const key = item.kaltura?.entryId ||
      item.pageUrl ||
      item.sources?.find((source) => !/\.(vtt|srt)(\?|#|$)/i.test(source)) ||
      item.title;
    if (!key || byKey.has(key)) continue;
    byKey.set(key, item);
  }
  return [...byKey.values()].sort((left, right) => Number(left.lectureIndex || 9999) - Number(right.lectureIndex || 9999));
}

function cleanMediaRecords(records = []) {
  return mergeMediaRecords([], records);
}

function mergeMediaRecords(existingRecords = [], newRecords = []) {
  const byKey = new Map();
  for (const record of [...existingRecords, ...newRecords]) {
    if (record.transcriptText && !hasUsefulTranscript(record.transcriptText)) {
      delete record.captionText;
      delete record.transcriptText;
      delete record.transcriptPath;
    }
    if (record.transcriptText || record.transcriptPath) {
      delete record.mp4Path;
      delete record.downloadedPath;
      delete record.audioPath;
    }
    const text = `${record.title || ""}\n${record.transcriptText || ""}\n${record.captionText || ""}\n${record.status || ""}`;
    const hasUsefulArtifact = Boolean(record.transcriptPath || record.transcriptText || record.mp4Path || record.audioPath || isNoTranscriptStatus(record.status));
    if (/visible text/i.test(record.title || "")) continue;
    if (/^index\.php/i.test(record.title || "")) continue;
    if (/UC San Diego\s+Educational Technology Services/i.test(text)) continue;
    if (/kWidget\.embed|TimeManager|Keyboard shortcuts/i.test(text)) continue;
    if (!hasUsefulArtifact) continue;
    const keys = recordDedupeKeys(record);
    const key = keys.find((candidate) => byKey.has(candidate)) || keys[0];
    const existing = byKey.get(key);
    if (!existing || mediaQuality(record) >= mediaQuality(existing)) byKey.set(key, record);
  }
  return [...byKey.values()];
}

function isCompleteMediaRecord(record = {}) {
  if (record.transcriptText && hasUsefulTranscript(record.transcriptText)) return true;
  if (record.transcriptPath) return true;
  return isNoTranscriptStatus(record.status);
}

function isNoTranscriptStatus(status = "") {
  return /no audible lecture (audio|speech) detected|transcript rejected|no useful transcript/i.test(status || "");
}

function mediaDedupeKey(record) {
  const entryId = record.kalturaEntryId || entryIdFromValue(record.source);
  if (entryId) return `kaltura:${entryId}`;
  const transcript = normalizeTranscript(record.transcriptText || record.captionText || "");
  if (transcript.length > 200) return `transcript:${transcript.slice(0, 4000)}`;
  return `lecture:${record.title || ""}:${record.pageUrl || ""}:${record.source || ""}`;
}

function recordDedupeKeys(record = {}) {
  return uniqueStrings([
    lectureTitleKey(record.title || record.pageTitle || ""),
    record.kalturaEntryId ? `kaltura:${record.kalturaEntryId}` : null,
    entryIdFromValue(record.source) ? `kaltura:${entryIdFromValue(record.source)}` : null,
    mediaDedupeKey(record)
  ]);
}

function mediaItemDedupeKeys(item = {}) {
  const source = item.sources?.[0] || "";
  const entryId = item.kaltura?.entryId || entryIdFromValue(source);
  return uniqueStrings([
    lectureTitleKey(item.title || item.pageTitle || ""),
    entryId ? `kaltura:${entryId}` : null,
    `lecture:${item.title || ""}:${item.pageUrl || ""}:${source}`
  ]);
}

function lectureTitleKey(value = "") {
  const text = String(value);
  const lecture = text.match(/\blecture\s+(\d+)\b/i)?.[1];
  if (!lecture) return null;
  const course = text.match(/\b([a-z]{2,5})\s*[- ]?\s*(\d+[a-z]?)\b/i);
  const courseKey = course ? `${course[1].toLowerCase()}${course[2].toLowerCase()}` : normalizeTranscript(text).slice(0, 80);
  return `lecture-title:${courseKey}:${lecture}`;
}

function uniqueStrings(values = []) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function entryIdFromValue(value = "") {
  return String(value).match(/entryId\/([^/?#]+)/i)?.[1] ||
    String(value).match(/[?&]entry_id=([^&#]+)/i)?.[1] ||
    null;
}

function isYouTubeUrl(value = "") {
  try {
    const parsed = new URL(String(value));
    return /(^|\.)youtube\.com$/i.test(parsed.hostname) || /^youtu\.be$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

function mediaQuality(record) {
  let score = 0;
  if (record.transcriptText) score += 100000 + record.transcriptText.length;
  if (record.transcriptPath) score += 50000;
  if (record.mp4Path) score += 1000;
  if (record.audioPath) score += 500;
  if (record.status === "saved" || /transcribed|caption/i.test(record.status || "")) score += 100;
  return score;
}

function normalizeTranscript(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function titleFromTranscriptFile(name) {
  return name
    .replace(/\.txt$/i, "")
    .replace(/-\d{10,}(?:\.\d+)?$/i, "")
    .replace(/-\d+\.\d+$/i, "")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "Lecture transcript";
}

function transcriptFromCaption(caption = {}) {
  const candidates = [
    caption.transcriptText,
    caption.text
  ];
  for (const candidate of candidates) {
    const text = vttToText(candidate);
    if (hasUsefulTranscript(text)) return text;
  }
  return "";
}

function hasUsefulTranscript(text) {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const noiseLines = lines.filter((line) => /^(\[?blank[_\s-]*audio\]?|[♪\s]+|[\[(]?(?:silence|music|upbeat music|applause|laughter|engine revving|inaudible)[\])]?\.?)$/i.test(line)).length;
  if (lines.length && noiseLines / lines.length > 0.5) return false;
  if (isRepetitiveTranscript(lines)) return false;
  const normalized = normalizeTranscript(text);
  if (normalized.length < 20) return false;
  const words = normalized.split(" ").filter((word) => /[a-z]/.test(word));
  if (words.length < 5) return false;
  if (new Set(words).size < 4) return false;
  if (words.length > 100 && new Set(words).size / words.length < 0.04) return false;
  if (/UC San Diego\s+Educational Technology Services/i.test(text)) return false;
  if (/kWidget\.embed|TimeManager|Keyboard shortcuts/i.test(text)) return false;
  return true;
}

function isRepetitiveTranscript(lines = []) {
  if (lines.length < 8) return false;
  const normalizedLines = lines.map((line) => normalizeTranscript(line)).filter(Boolean);
  if (!normalizedLines.length) return false;
  const counts = new Map();
  for (const line of normalizedLines) counts.set(line, (counts.get(line) || 0) + 1);
  const dominant = Math.max(...counts.values());
  if (dominant >= 8 && dominant / normalizedLines.length > 0.35) return true;

  const joined = normalizedLines.join(" ");
  const words = joined.split(" ").filter(Boolean);
  if (words.length < 80) return false;
  const phraseCounts = new Map();
  for (let index = 0; index <= words.length - 6; index += 1) {
    const phrase = words.slice(index, index + 6).join(" ");
    phraseCounts.set(phrase, (phraseCounts.get(phrase) || 0) + 1);
  }
  const repeatedPhrase = Math.max(0, ...phraseCounts.values());
  return repeatedPhrase >= 12 && repeatedPhrase / Math.max(1, words.length - 5) > 0.12;
}

function scoreMedia(item) {
  let score = 0;
  if (item.kind === "kaltura") score += 100;
  if (item.kind === "youtube" || item.sources?.some(isYouTubeUrl)) score += 90;
  if (item.kaltura?.entryId) score += 80;
  if (item.captions?.some((caption) => caption.text)) score += 70;
  if (item.sources?.some((source) => /\.m3u8(\?|#|$)/i.test(source))) score += 40;
  if (item.sources?.some((source) => /\.(mp4|m4v|mov)(\?|#|$)/i.test(source))) score += 30;
  if (item.sources?.length) score += 10;
  return score;
}

async function convertFirstWorkingSource({ item, title, dir, mediaDir, requestHeaders, record }) {
  const errors = [];
  for (const source of item.sources || []) {
    if (/\.(vtt|srt)(\?|#|$)/i.test(source)) continue;
    try {
      let conversionInput = source;
      if (!/\.m3u8(\?|#|$)/i.test(source)) {
        const downloaded = await downloadMedia(source, join(mediaDir, "source"), title, requestHeaders);
        record.downloadedPath = relative(dir, downloaded);
        conversionInput = downloaded;
      } else {
        record.downloadedPath = "HLS stream";
      }
      const mp4 = await convertToMp4(conversionInput, mediaDir, title, requestHeaders);
      record.source = source;
      return { ok: true, mp4 };
    } catch (error) {
      errors.push(`${source}: ${error.message}`.slice(0, 500));
    }
  }
  return { ok: false, errors };
}

async function transcribeAudio(audioPath, { targetDir, title }) {
  const transcript = await transcribeWithLocalWhisper(audioPath, targetDir, title).catch(() => null);
  if (hasUsefulTranscript(transcript)) return transcript;
  await removeFile(join(targetDir, `${fileSlug(title)}.txt`));
  return null;
}

async function removeRelativeFile(dir, path) {
  if (!path || path === "HLS stream") return;
  await removeFile(join(dir, path));
}

async function removeFile(path) {
  if (!path) return;
  await fs.unlink(path).catch(() => undefined);
}

async function pruneDirectory(dir, { keep, match }) {
  const entries = await fs.readdir(dir).catch(() => []);
  const files = [];
  for (const name of entries) {
    if (match && !match.test(name)) continue;
    const path = join(dir, name);
    const stat = await fs.stat(path).catch(() => null);
    if (stat?.isFile()) files.push({ path, mtimeMs: stat.mtimeMs });
  }
  files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const file of files.slice(keep)) {
    await fs.unlink(file.path).catch(() => undefined);
  }
}
