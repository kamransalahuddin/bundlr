import { promises as fs } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileSlug, safeName } from "./sanitize.mjs";

const MAX_UPLOAD_FILES = 20;
const TARGET_CHARS = 900000;

export async function createAiUploadSet({ binRoot, binName }) {
  const safe = safeName(binName);
  const binDir = join(binRoot, safe);
  const uploadDir = join(binDir, "_ai_upload");
  await fs.rm(uploadDir, { recursive: true, force: true });
  await fs.mkdir(uploadDir, { recursive: true });

  const course = await readJson(join(binDir, "canvas.json"), null);
  const media = await readJson(join(binDir, "media.json"), []);
  const files = [];

  await addFileIfExists(files, join(binDir, "context.md"), "01-context.md", uploadDir);
  await writeUploadFile(files, uploadDir, "02-file-index.txt", await fileIndex(binDir, course, media));

  const lectureEntries = transcriptEntries(media);
  const readingEntriesList = readingEntries(course);
  const canvasEntries = canvasEntriesForCourse(course);
  const remainingSlots = Math.max(1, MAX_UPLOAD_FILES - files.length);
  const readingSlots = readingEntriesList.length ? Math.max(1, Math.round(remainingSlots * 0.7)) : 0;
  const lectureSlots = lectureEntries.length ? Math.max(1, Math.round(remainingSlots * 0.2)) : 0;
  let canvasSlots = canvasEntries.length ? Math.max(1, remainingSlots - readingSlots - lectureSlots) : 0;

  const planned = [
    ...chunkEntries(readingEntriesList, readingSlots, "readings"),
    ...chunkEntries(lectureEntries, lectureSlots, "lectures"),
    ...chunkEntries(canvasEntries, canvasSlots, "canvas")
  ];
  while (files.length + planned.length > MAX_UPLOAD_FILES) {
    const last = planned.pop();
    if (!last) break;
    const previous = planned[planned.length - 1];
    if (previous && previous.prefix === last.prefix) previous.entries.push(...last.entries);
    else planned.push(last);
  }

  let counters = {};
  for (const chunk of planned) {
    counters[chunk.prefix] = (counters[chunk.prefix] || 0) + 1;
    const filename = `${String(files.length + 1).padStart(2, "0")}-${chunk.prefix}-part-${String(counters[chunk.prefix]).padStart(2, "0")}.txt`;
    await writeUploadFile(files, uploadDir, filename, groupedText(chunk.title, chunk.entries));
  }

  return {
    maxFiles: MAX_UPLOAD_FILES,
    fileCount: files.length,
    files
  };
}

async function addFileIfExists(files, sourcePath, filename, uploadDir) {
  try {
    await fs.access(sourcePath);
    const targetPath = join(uploadDir, filename);
    await fs.copyFile(sourcePath, targetPath);
    files.push(await uploadRecord(targetPath, filename));
  } catch {
    // Optional file.
  }
}

async function writeUploadFile(files, uploadDir, filename, text) {
  const targetPath = join(uploadDir, filename);
  await fs.writeFile(targetPath, text || "");
  files.push(await uploadRecord(targetPath, filename));
}

async function uploadRecord(path, filename) {
  const stat = await fs.stat(path);
  return {
    filename,
    path,
    size: stat.size,
    contentType: contentTypeFor(filename)
  };
}

async function fileIndex(binDir, course, media) {
  const diskFiles = await walk(binDir, {
    skipDirs: new Set(["_ai_upload", "_bundles"]),
    prefix: binDir
  });
  return [
    "Bundlr Upload Set",
    "=================",
    "",
    `This course folder has ${diskFiles.length} local file(s). Chat apps often allow only ${MAX_UPLOAD_FILES} uploads, so Bundlr grouped readable Canvas, readings, and lecture transcript text into this upload set.`,
    "",
    "Full Local Folder Contents",
    "--------------------------",
    ...diskFiles.map((file) => `- ${file}`),
    "",
    "Canvas File Records",
    "-------------------",
    ...(course?.files || []).map((file) => [
      `- ${file.displayName || file.filename || file.id || "file"}`,
      file.localPath ? `  Local: ${file.localPath}` : null,
      file.contentType ? `  Type: ${file.contentType}` : null,
      file.binaryStatus ? `  Status: ${file.binaryStatus}` : null
    ].filter(Boolean).join("\n")),
    "",
    "Lecture Records",
    "---------------",
    ...(media || []).map((item) => [
      `- ${item.title || item.pageTitle || item.id || "lecture"}`,
      item.transcriptPath ? `  Transcript: ${item.transcriptPath}` : null,
      item.mp4Path ? `  Media: ${item.mp4Path}` : null,
      item.status ? `  Status: ${item.status}` : null
    ].filter(Boolean).join("\n")),
    ""
  ].join("\n");
}

function readingEntries(course) {
  return (course?.files || [])
    .filter((file) => file.extractedText || file.text)
    .map((file) => ({
      title: file.displayName || file.filename || file.id || "reading",
      text: file.extractedText || file.text,
      meta: [
        file.localPath ? `Local file: ${file.localPath}` : null,
        file.contentType ? `Type: ${file.contentType}` : null,
        file.url ? `Canvas URL: ${file.url}` : null
      ].filter(Boolean)
    }));
}

function transcriptEntries(media) {
  return (media || [])
    .filter((item) => item.transcriptText || item.captionText)
    .map((item) => ({
      title: item.title || item.pageTitle || item.id || "lecture",
      text: item.transcriptText || item.captionText,
      meta: [
        item.pageUrl ? `Page: ${item.pageUrl}` : null,
        item.transcriptPath ? `Transcript file: ${item.transcriptPath}` : null,
        item.mp4Path ? `Media file: ${item.mp4Path}` : null
      ].filter(Boolean)
    }));
}

function canvasEntriesForCourse(course) {
  if (!course) return [];
  return [
    { title: "Assignments", text: JSON.stringify(course.assignments || [], null, 2), meta: [] },
    { title: "Discussions", text: JSON.stringify(course.discussions || [], null, 2), meta: [] },
    { title: "Modules", text: JSON.stringify(course.modules || [], null, 2), meta: [] },
    { title: "Pages", text: JSON.stringify(course.pages || [], null, 2), meta: [] }
  ].filter((entry) => entry.text && entry.text !== "[]");
}

function chunkEntries(entries, slots, prefix) {
  if (!entries.length || slots <= 0) return [];
  const chunks = [];
  let current = [];
  let currentChars = 0;
  const target = Math.max(TARGET_CHARS, Math.ceil(totalChars(entries) / slots));
  for (const entry of entries) {
    const size = String(entry.text || "").length;
    if (current.length && currentChars + size > target && chunks.length < slots - 1) {
      chunks.push({ prefix, title: `${prefix} part ${chunks.length + 1}`, entries: current });
      current = [];
      currentChars = 0;
    }
    current.push(entry);
    currentChars += size;
  }
  if (current.length) chunks.push({ prefix, title: `${prefix} part ${chunks.length + 1}`, entries: current });
  return chunks;
}

function groupedText(title, entries) {
  return [
    title,
    "=".repeat(title.length),
    "",
    ...entries.map((entry) => sectionText(entry))
  ].join("\n\n");
}

function sectionText(entry) {
  return [
    `# ${entry.title}`,
    ...(entry.meta || []).map((line) => `- ${line}`),
    "",
    String(entry.text || "").trim(),
    ""
  ].join("\n");
}

function totalChars(entries) {
  return entries.reduce((sum, entry) => sum + String(entry.text || "").length, 0);
}

async function walk(dir, { skipDirs, prefix }) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      out.push(...await walk(path, { skipDirs, prefix }));
    } else if (entry.isFile()) {
      out.push(path.slice(prefix.length + 1));
    }
  }
  return out.sort();
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

function contentTypeFor(filename) {
  const ext = extname(filename).toLowerCase();
  if (ext === ".md") return "text/markdown";
  if (ext === ".json") return "application/json";
  return "text/plain";
}
