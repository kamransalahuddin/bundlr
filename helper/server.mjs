import "dotenv/config";
import express from "express";
import cors from "cors";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BinStore } from "./lib/bin-store.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 8765);
const binRoot = resolve(process.env.BIN_ROOT || resolve(__dirname, "..", "bins"));

const store = new BinStore({
  root: binRoot
});

app.use(cors({ origin: true }));
app.use(express.json({ limit: "50mb" }));

app.get("/health", async (_request, response) => {
  response.json(await store.info());
});

app.post("/api/canvas/sync", async (request, response, next) => {
  try {
    const { binName, course } = request.body || {};
    if (!course?.id) response.status(400).send("Missing Canvas course payload.");
    else response.json(await store.syncCanvas(binName || course.name, course));
  } catch (error) {
    next(error);
  }
});

app.post("/api/canvas/download-files", async (request, response, next) => {
  try {
    const { binName, files } = request.body || {};
    if (!binName) response.status(400).send("Missing binName.");
    else response.json(await store.downloadCanvasFiles(binName, files || []));
  } catch (error) {
    next(error);
  }
});

app.post("/api/canvas/upload-file/start", async (request, response, next) => {
  try {
    const { binName, file } = request.body || {};
    if (!binName || !file) response.status(400).send("Missing binName or file.");
    else response.json(await store.startCanvasFileUpload(binName, file));
  } catch (error) {
    next(error);
  }
});

app.post("/api/canvas/upload-file/chunk/:uploadId", express.raw({ type: "*/*", limit: "2mb" }), async (request, response, next) => {
  try {
    response.json(await store.appendCanvasFileUpload(request.params.uploadId, request.body));
  } catch (error) {
    next(error);
  }
});

app.post("/api/canvas/upload-file/finish/:uploadId", async (request, response, next) => {
  try {
    response.json(await store.finishCanvasFileUpload(request.params.uploadId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/media/capture", async (request, response, next) => {
  try {
    const { binName, page, media, all, keepMp4 } = request.body || {};
    if (!binName) response.status(400).send("Missing binName.");
    else response.json(await store.captureMedia(binName, page, media || [], undefined, { all, keepMp4 }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/media/capture/start", async (request, response, next) => {
  try {
    const { binName, page, media, all, keepMp4 } = request.body || {};
    if (!binName) response.status(400).send("Missing binName.");
    else response.json(store.startMediaCaptureJob(binName, page, media || [], { all, keepMp4 }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/media/capture/job/:id", async (request, response, next) => {
  try {
    response.json(store.getMediaJob(request.params.id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/bin/:binName/rebuild", async (request, response, next) => {
  try {
    const contextPath = await store.rebuildContext(request.params.binName);
    response.json({ contextPath });
  } catch (error) {
    next(error);
  }
});

app.get("/api/bin/:binName/context", async (request, response, next) => {
  try {
    const context = await store.readContext(request.params.binName);
    response.type("text/markdown").send(context);
  } catch (error) {
    next(error);
  }
});

app.get("/api/bin/:binName/all-context", async (request, response, next) => {
  try {
    const { textPath } = await store.createAllContext(request.params.binName);
    response.download(textPath, `${request.params.binName}-all-context.txt`);
  } catch (error) {
    next(error);
  }
});

app.get("/api/bin/:binName/upload-set", async (request, response, next) => {
  try {
    response.json(await store.createUploadSet(request.params.binName));
  } catch (error) {
    next(error);
  }
});

app.get("/api/bin/:binName/upload-set/file/:filename", async (request, response, next) => {
  try {
    const file = await store.readUploadSetFile(request.params.binName, request.params.filename);
    response.type(file.contentType || "text/plain").download(file.path, file.filename);
  } catch (error) {
    next(error);
  }
});

app.post("/api/bin/:binName/export-folder", async (request, response, next) => {
  try {
    response.json(await store.exportFolder(request.params.binName));
  } catch (error) {
    next(error);
  }
});

app.get("/api/bin/:binName/bundle", async (request, response, next) => {
  try {
    const { bundlePath } = await store.createBundle(request.params.binName);
    response.download(bundlePath);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/bin/:binName", async (request, response, next) => {
  try {
    response.json(await store.deleteBin(request.params.binName));
  } catch (error) {
    next(error);
  }
});

app.post("/api/bin/:binName/reveal", async (request, response, next) => {
  try {
    response.json(await store.revealBundle(request.params.binName));
  } catch (error) {
    next(error);
  }
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).send(error.message || "Unexpected helper error.");
});

app.listen(port, "127.0.0.1", async () => {
  const info = await store.info();
  console.log(`Bundlr helper listening on http://127.0.0.1:${port}`);
  console.log(`Writing bins to ${info.binRoot}`);
  console.log(info.ffmpeg ? "ffmpeg detected for MP4 conversion." : "ffmpeg not detected; install it for MP4 conversion.");
});
