import { createWriteStream, promises as fs } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileSlug } from "./sanitize.mjs";
import { vttToText } from "./text.mjs";

export async function hasFfmpeg() {
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

export async function hasLocalWhisper() {
  const command = await findWhisperCommand();
  return Boolean(command);
}

export async function hasYtDlp() {
  const command = await findYtDlpCommand();
  return Boolean(command);
}

export async function downloadMedia(url, targetDir, nameHint, requestHeaders = {}) {
  await fs.mkdir(targetDir, { recursive: true });
  const parsed = new URL(url);
  const sourceName = basename(parsed.pathname) || nameHint || "media";
  const extension = extname(sourceName) || ".bin";
  const target = join(targetDir, `${fileSlug(nameHint || sourceName)}-${Date.now()}${extension}`);
  const response = await fetch(url, {
    redirect: "follow",
    headers: fetchHeaders(requestHeaders)
  });
  if (!response.ok || !response.body) {
    throw new Error(`download failed: HTTP ${response.status}`);
  }
  await streamToFile(response.body, target);
  return target;
}

export async function downloadFile(url, targetDir, nameHint, requestHeaders = {}) {
  return downloadMedia(url, targetDir, nameHint, requestHeaders);
}

export async function convertToMp4(inputPath, targetDir, nameHint, requestHeaders = {}) {
  await fs.mkdir(targetDir, { recursive: true });
  const outputPath = join(targetDir, `${fileSlug(nameHint || basename(inputPath))}.mp4`);
  const partialPath = join(targetDir, `${fileSlug(nameHint || basename(inputPath))}-${Date.now()}.partial.mp4`);
  if (!isRemoteUrl(inputPath) && extname(inputPath).toLowerCase() === ".mp4") {
    await fs.copyFile(inputPath, partialPath);
    await validateMp4(partialPath);
    await fs.rename(partialPath, outputPath);
    return outputPath;
  }
  const args = [
    "-y",
    "-user_agent",
    requestHeaders.userAgent || "Mozilla/5.0 Bundlr",
    ...ffmpegHeaderArgs(requestHeaders),
    "-i",
    inputPath,
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    partialPath
  ];
  try {
    await run("ffmpeg", args);
    await validateMp4(partialPath);
    await fs.rename(partialPath, outputPath);
  } catch (error) {
    await fs.rm(partialPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return outputPath;
}

export async function extractAudio(inputPath, targetDir, nameHint) {
  await fs.mkdir(targetDir, { recursive: true });
  const outputPath = join(targetDir, `${fileSlug(nameHint || basename(inputPath))}.wav`);
  await run("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-af",
    "volume=50dB,alimiter=limit=0.95",
    "-acodec",
    "pcm_s16le",
    outputPath
  ]);
  return outputPath;
}

export async function transcribeWithLocalWhisper(inputPath, targetDir, nameHint) {
  const command = await findWhisperCommand();
  if (!command) return null;
  await fs.mkdir(targetDir, { recursive: true });
  const outputBase = join(targetDir, fileSlug(nameHint || basename(inputPath)));

  if (command === "whisper") {
    await run("whisper", [inputPath, "--model", "base", "--output_format", "txt", "--output_dir", targetDir]);
    const expected = join(targetDir, `${basename(inputPath, extname(inputPath))}.txt`);
    return readIfExists(expected);
  }

  const args = ["-f", inputPath, "-otxt", "-of", outputBase];
  const modelPath = resolve("models", "ggml-base.en.bin");
  if (await fileExists(modelPath)) args.push("-m", modelPath);
  await run(command, args);
  return readIfExists(`${outputBase}.txt`);
}

export async function captureYouTubeTranscript(url, targetDir, nameHint) {
  const command = await findYtDlpCommand();
  if (!command) return null;
  await fs.mkdir(targetDir, { recursive: true });
  const slug = `${fileSlug(nameHint || "youtube-lecture")}-${Date.now()}`;
  const before = new Set(await fs.readdir(targetDir).catch(() => []));
  const outputTemplate = join(targetDir, `${slug}.%(ext)s`);
  const args = [
    "--skip-download",
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs",
    "en.*,en",
    "--sub-format",
    "vtt/srt/best",
    "--output",
    outputTemplate,
    url
  ];
  await runYtDlp(command, args);
  const after = await fs.readdir(targetDir).catch(() => []);
  const captionFiles = after
    .filter((name) => !before.has(name) && name.startsWith(slug) && /\.(vtt|srt)$/i.test(name))
    .sort((left, right) => captionPreference(right) - captionPreference(left));
  let bestTranscript = null;
  for (const name of captionFiles) {
    const text = await fs.readFile(join(targetDir, name), "utf8").catch(() => "");
    const transcript = vttToText(text || "");
    if (!bestTranscript && transcript) bestTranscript = transcript;
  }
  await Promise.all(captionFiles.map((name) => fs.rm(join(targetDir, name), { force: true }).catch(() => undefined)));
  return bestTranscript;
}

async function streamToFile(webStream, path) {
  await pipeline(Readable.fromWeb(webStream), createWriteStream(path));
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(-1000)}`));
    });
  });
}

function runYtDlp(command, args) {
  if (Array.isArray(command)) return run(command[0], [...command.slice(1), ...args]);
  return run(command, args);
}

async function validateMp4(path) {
  await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=nw=1:nk=1",
    path
  ]);
}

async function findWhisperCommand() {
  for (const command of ["whisper", "whisper-cli", "whisper-cpp", "main"]) {
    const exists = await new Promise((resolve) => {
      const child = spawn("which", [command], { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    });
    if (exists) return command;
  }
  return null;
}

async function findYtDlpCommand() {
  for (const command of ["yt-dlp", "youtube-dl"]) {
    const exists = await commandExists(command);
    if (exists) return command;
  }
  for (const python of ["python3", "python"]) {
    const exists = await commandExists(python);
    if (!exists) continue;
    const ok = await new Promise((resolve) => {
      const child = spawn(python, ["-m", "yt_dlp", "--version"], { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    });
    if (ok) return [python, "-m", "yt_dlp"];
  }
  return null;
}

function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn("which", [command], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function readIfExists(path) {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function fileExists(path) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

function isRemoteUrl(value) {
  return /^https?:\/\//i.test(String(value));
}

function fetchHeaders(requestHeaders = {}) {
  const headers = {
    "user-agent": requestHeaders.userAgent || "Bundlr/0.1"
  };
  if (requestHeaders.cookie) headers.cookie = requestHeaders.cookie;
  if (requestHeaders.referer) headers.referer = requestHeaders.referer;
  return headers;
}

function ffmpegHeaderArgs(requestHeaders = {}) {
  const lines = [];
  if (requestHeaders.cookie) lines.push(`Cookie: ${requestHeaders.cookie}`);
  if (requestHeaders.referer) lines.push(`Referer: ${requestHeaders.referer}`);
  if (!lines.length) return [];
  return ["-headers", `${lines.join("\r\n")}\r\n`];
}

function captionPreference(name = "") {
  let score = 0;
  if (/\.en(?:[-.][a-z]+)?\./i.test(name)) score += 20;
  if (/\.vtt$/i.test(name)) score += 10;
  if (/auto/i.test(name)) score -= 1;
  return score;
}
