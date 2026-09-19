import { createWriteStream, existsSync, promises as fs } from "node:fs";
import { basename, join } from "node:path";
import archiver from "archiver";
import { safeName } from "./sanitize.mjs";

export async function createZipBundle({ binRoot, binName }) {
  const safe = safeName(binName);
  const binDir = join(binRoot, safe);
  const bundleDir = join(binRoot, "_bundles");
  await fs.mkdir(bundleDir, { recursive: true });
  const outputPath = join(bundleDir, `${safe}.zip`);

  await new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);

    archive.append(readmeForBundle(safe), { name: `${safe}/README.txt` });
    addIfExists(archive, join(binDir, "context.md"), `${safe}/Canvas/context.md`);
    addIfExists(archive, join(binDir, "all-context.txt"), `${safe}/Canvas/all-context.txt`);
    addIfExists(archive, join(binDir, "canvas.json"), `${safe}/Canvas/canvas.json`);
    addIfExists(archive, join(binDir, "manifest.json"), `${safe}/manifest.json`);
    addIfExists(archive, join(binDir, "media.json"), `${safe}/lectures/media.json`);

    addDirectory(archive, join(binDir, "canvas"), `${safe}/Canvas/api`);
    addDirectory(archive, join(binDir, "raw"), `${safe}/Canvas/raw`);
    addDirectory(archive, join(binDir, "readings"), `${safe}/readings`);
    addDirectory(archive, join(binDir, "transcripts"), `${safe}/lectures/transcripts`);
    addDirectory(archive, join(binDir, "media"), `${safe}/lectures/media`);

    archive.finalize();
  });

  return outputPath;
}

function readmeForBundle(binName) {
  return [
    `${binName} full Bundlr archive`,
    "",
    "This ZIP includes the full local bin for the course.",
    "Canvas/context.md and Canvas/all-context.txt contain the readable combined course context.",
    "Canvas/canvas.json, Canvas/api, and Canvas/raw contain Canvas captures and raw snapshots.",
    "readings contains downloaded Canvas reading files plus extracted readable text where available.",
    "lectures/transcripts contains captured captions or local Whisper transcripts.",
    "lectures/media contains saved lecture media/audio artifacts when Bundlr can access and convert them.",
    "Nothing is intentionally removed from this ZIP to shrink it for AI upload.",
    ""
  ].join("\n");
}

function addIfExists(archive, path, name) {
  if (!existsSync(path)) return;
  archive.file(path, { name });
}

function addDirectory(archive, path, name) {
  if (!existsSync(path)) return;
  archive.directory(path, name, (entry) => {
    if (!entry.name || basename(entry.name).startsWith(".")) return false;
    return entry;
  });
}
