const HELPER = "http://127.0.0.1:8765";
const ALARM_NAME = "bundlr-auto-sync";
const JOB_KEY = "bundlrActiveJob";

chrome.runtime.onInstalled.addListener(async () => {
  const { autoSyncEnabled, syncIntervalMinutes } = await chrome.storage.local.get([
    "autoSyncEnabled",
    "syncIntervalMinutes"
  ]);
  if (autoSyncEnabled) configureAlarm(syncIntervalMinutes || 30);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CONFIGURE_AUTO_SYNC") {
    if (message.enabled) configureAlarm(message.intervalMinutes || 30);
    else chrome.alarms.clear(ALARM_NAME);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "BUNDLR_START_DOWNLOAD") {
    startJob("download", "Starting course download...", () => runCourseDownload(message))
      .catch(() => undefined);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "BUNDLR_START_LECTURE") {
    startJob("lecture", "Starting lecture capture...", () => runOpenLectureCapture(message))
      .catch(() => undefined);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "BUNDLR_GET_JOB") {
    chrome.storage.local.get(JOB_KEY)
      .then(async (data) => {
        await refreshHelperMediaJob(data[JOB_KEY]).catch(() => undefined);
        const refreshed = await chrome.storage.local.get(JOB_KEY);
        sendResponse({ ok: true, job: refreshed[JOB_KEY] || null });
      });
    return true;
  }

  return false;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  await runAutoSync();
});

async function startJob(type, message, runner) {
  const current = (await chrome.storage.local.get(JOB_KEY))[JOB_KEY];
  if (current?.status === "running") {
    await setJob({
      ...current,
      message: "Bundlr is already working",
      detail: current.message || "Let the current download finish first."
    });
    return;
  }

  const job = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type,
    status: "running",
    message,
    detail: "",
    activeBinNames: [],
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await setJob(job);
  try {
    await runner(job);
  } catch (error) {
    await setJob({
      ...job,
      ...(await currentJobPatch(job.id)),
      status: "error",
      message: "Bundlr hit a snag",
      detail: error.message,
      updatedAt: new Date().toISOString()
    });
  }
}

async function currentJobPatch(id) {
  const current = (await chrome.storage.local.get(JOB_KEY))[JOB_KEY];
  return current?.id === id ? current : {};
}

async function setJob(patch) {
  const current = (await chrome.storage.local.get(JOB_KEY))[JOB_KEY] || {};
  await chrome.storage.local.set({
    [JOB_KEY]: {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString()
    }
  });
}

async function setProgress(job, message, detail = "", activeBinNames = null) {
  await setJob({
    id: job.id,
    status: "running",
    message,
    detail,
    ...(activeBinNames ? { activeBinNames } : {})
  });
}

async function runCourseDownload(message) {
  const job = (await chrome.storage.local.get(JOB_KEY))[JOB_KEY];
  const tab = message.tab;
  const lectureSources = message.refresh
    ? await savedLectureSources()
    : message.lectureSources || [];
  if (!tab?.id || !/^https?:\/\//i.test(tab.url || "")) throw new Error("Open Canvas in Chrome first.");

  await checkHelper();
  await setProgress(job, "Reading Canvas", "Finding your course content, files, and readings.");
  const courses = await scrapeCoursesForTab(tab);
  if (!courses.length) throw new Error("No Canvas courses found. Open a Canvas course or your Canvas dashboard.");

  const updatedBins = [];
  for (const [index, course] of courses.entries()) {
    const binName = binNameForCourse(course);
    await setProgress(job, "Downloading Canvas content", `${index + 1}/${courses.length}: ${binName}`, [binName]);
    await syncCourseToBin(tab.id, binName, course, job);
    const canvasLectureMedia = lectureMediaFromCanvasCourse(course);
    if (canvasLectureMedia.length) {
      await setProgress(job, "Capturing Canvas lectures", `${canvasLectureMedia.length} lecture link(s) found in ${binName}.`, [binName]);
      await runMediaCaptureJob({
        job,
        binName,
        page: {
          title: course.name || course.courseCode || binName,
          url: course.url || tab.url,
          capturedAt: new Date().toISOString(),
          source: "Canvas modules"
        },
        media: canvasLectureMedia
      });
    }
    updatedBins.push({ name: binName, updatedAt: new Date().toISOString() });
    await saveBins(updatedBins, { merge: true });
  }

  const sourcesToUse = lectureSources.length ? lectureSources : await savedLectureSources();
  if (sourcesToUse.length) {
    await syncLectureSourcesToMatchingBins(courses, sourcesToUse, tab, job);
  }

  for (const bin of updatedBins) {
    await setProgress(job, "Preparing folder", `Opening ${bin.name} in Downloads.`, [bin.name]);
    await exportFolder(bin.name);
  }

  await chrome.storage.local.set({
    bundlrLectureSources: sourcesToUse,
    bundlrLectureLinksByBin: sourcesToLegacyMap(sourcesToUse)
  });
  if (updatedBins[0]) await setDragPayload(updatedBins[0].name);

  await setJob({
    id: job.id,
    status: "done",
    message: "Course content is ready",
    detail: `Updated ${updatedBins.length} course folder${updatedBins.length === 1 ? "" : "s"}.`,
    activeBinNames: [],
    finishedAt: new Date().toISOString()
  });
}

async function runOpenLectureCapture(message) {
  const job = (await chrome.storage.local.get(JOB_KEY))[JOB_KEY];
  const tab = message.tab;
  const binName = message.binName;
  if (!binName) throw new Error("Choose a course bin first.");
  if (!tab?.id || !/^https?:\/\//i.test(tab.url || "")) throw new Error("Open the lecture/podcast page in Chrome first.");

  await checkHelper();
  await setProgress(job, "Scanning lecture page", `Finding every lecture on the open page for ${binName}.`, [binName]);
  const result = await askTabIn(tab.id, "CAPTURE_ALL_LECTURES_V1");
  if (!result?.ok) throw new Error(result?.error || "Lecture scan failed.");
  if (!result.media?.length) {
    throw new Error("No lecture media found. If this is a login page, log in there first, then click Lecture again.");
  }

  const media = await attachAuthHeaders(result.media || [], result.page?.url);
  await setProgress(job, "Starting lecture downloads", `${media.length} lecture item(s) found for ${binName}.`, [binName]);
  await runMediaCaptureJob({ job, binName, page: result.page, media });
  await exportFolder(binName);
  await saveBins([{ name: binName, updatedAt: new Date().toISOString() }], { merge: true });
  await setDragPayload(binName);

  await setJob({
    id: job.id,
    status: "done",
    message: "Lecture transcripts are ready",
    detail: `${binName} has been updated in Downloads.`,
    activeBinNames: [],
    finishedAt: new Date().toISOString()
  });
}

async function scrapeCoursesForTab(tab) {
  const url = new URL(tab.url);
  if (/\/courses\/\d+/i.test(url.pathname)) {
    const result = await askTabIn(tab.id, "SCRAPE_CANVAS_COURSE_V2", { maxFileTextBytes: 300000 });
    if (!result?.ok) throw new Error(result?.error || "Canvas scrape failed.");
    return [result.course];
  }
  const result = await askTabIn(tab.id, "SCRAPE_CANVAS_DASHBOARD_V1", {
    maxFileTextBytes: 300000,
    maxCourses: 20
  });
  if (!result?.ok) throw new Error(result?.error || "Canvas dashboard scrape failed.");
  return result.courses || [];
}

async function syncCourseToBin(tabId, binName, course, job) {
  await helper("/api/canvas/sync", {
    method: "POST",
    body: JSON.stringify({ binName, course })
  });

  const downloadableFiles = (course.files || [])
    .filter((file) => (file.url || file.downloadUrlCandidates?.length) && Number(file.size || 0) <= 75000000)
    .slice(0, 80)
    .map((file) => ({
      id: file.id,
      displayName: file.displayName,
      filename: file.filename,
      contentType: file.contentType,
      size: file.size,
      url: file.url,
      htmlUrl: file.htmlUrl,
      sourceUrl: file.sourceUrl,
      downloadUrlCandidates: file.downloadUrlCandidates,
      updatedAt: file.updatedAt
    }));

  if (!downloadableFiles.length) return;
  await setProgress(job, "Saving readings and files", `${downloadableFiles.length} file(s) for ${binName}.`, [binName]);
  const uploadResult = await askTabIn(tabId, "UPLOAD_CANVAS_FILES_V1", {
    helperUrl: HELPER,
    binName,
    files: downloadableFiles,
    maxBytes: 75000000
  });
  if (!uploadResult?.ok) throw new Error(uploadResult?.error || "File upload failed.");
  await setProgress(job, "Readings saved", `${uploadResult.uploaded.length} saved, ${uploadResult.failed.length} skipped for ${binName}.`, [binName]);
}

async function syncLectureSourcesToMatchingBins(courses, lectureSources, currentTab, job) {
  for (const source of lectureSources) {
    await setProgress(job, "Scanning lecture site", source.label ? `${source.label}: ${source.url}` : source.url);
    const result = await captureLectureSource(source.url, currentTab);
    if (!result.media?.length) continue;
    const media = await attachAuthHeaders(result.media || [], result.page?.url);
    const groups = groupLectureMediaByCourse(media, result.page, courses, source);
    if (!groups.size && courses.length === 1) groups.set(binNameForCourse(courses[0]), media);
    for (const [binName, items] of groups) {
      await setProgress(job, "Starting lecture downloads", `${items.length} lecture item(s) for ${binName}.`, [binName]);
      await runMediaCaptureJob({ job, binName, page: result.page, media: items });
    }
  }
}

async function captureLectureSource(lectureUrl, currentTab) {
  const useCurrentTab = stripHash(currentTab.url) === stripHash(lectureUrl);
  const lectureTab = useCurrentTab ? currentTab : await chrome.tabs.create({ url: lectureUrl, active: false });
  try {
    await waitForTabReady(lectureTab.id);
    const result = await askTabIn(lectureTab.id, "CAPTURE_ALL_LECTURES_V1");
    if (!result?.ok) throw new Error(result?.error || "Lecture scan failed.");
    return result;
  } finally {
    if (!useCurrentTab && lectureTab.id) await chrome.tabs.remove(lectureTab.id).catch(() => undefined);
  }
}

async function runMediaCaptureJob({ job, binName, page, media }) {
  const response = await helper("/api/media/capture/start", {
    method: "POST",
    body: JSON.stringify({ binName, page, media, all: true, keepMp4: false })
  });
  const mediaJob = await response.json();
  await setJob({
    id: job.id,
    helperMediaJobId: mediaJob.id,
    helperMediaBinName: binName,
    activeBinNames: [binName]
  });
  await pollMediaJob(job, mediaJob.id, binName);
}

async function refreshHelperMediaJob(job) {
  if (job?.status !== "running" || !job.helperMediaJobId || !job.helperMediaBinName) return;
  const response = await helper(`/api/media/capture/job/${encodeURIComponent(job.helperMediaJobId)}`);
  const mediaJob = await response.json();
  if (mediaJob.status === "done") {
    await exportFolder(job.helperMediaBinName);
    await saveBins([{ name: job.helperMediaBinName, updatedAt: new Date().toISOString() }], { merge: true });
    await setDragPayload(job.helperMediaBinName);
    await setJob({
      id: job.id,
      status: "done",
      message: "Lecture transcripts are ready",
      detail: `${job.helperMediaBinName} has been updated in Downloads.`,
      activeBinNames: [],
      finishedAt: new Date().toISOString()
    });
    return;
  }
  if (mediaJob.status === "error") {
    await setJob({
      id: job.id,
      status: "error",
      message: "Lecture capture failed",
      detail: mediaJob.error || "The helper reported an error.",
      activeBinNames: []
    });
    return;
  }
  if (mediaJob.message) {
    const friendly = friendlyMediaMessage(mediaJob.message);
    await setJob({
      id: job.id,
      status: "running",
      message: friendly.message,
      detail: friendly.detail || job.helperMediaBinName,
      activeBinNames: [job.helperMediaBinName]
    });
  }
}

async function pollMediaJob(job, id, binName) {
  let lastMessage = "";
  for (let attempt = 0; attempt < 720; attempt += 1) {
    await sleep(2500);
    const response = await helper(`/api/media/capture/job/${encodeURIComponent(id)}`);
    const mediaJob = await response.json();
    if (mediaJob.message && mediaJob.message !== lastMessage) {
      lastMessage = mediaJob.message;
      const friendly = friendlyMediaMessage(mediaJob.message);
      await setProgress(job, friendly.message, friendly.detail || binName, [binName]);
    }
    if (mediaJob.status === "done") return mediaJob;
    if (mediaJob.status === "error") throw new Error(mediaJob.error || "Lecture capture failed.");
  }
  throw new Error("Lecture capture is still running after 30 minutes.");
}

function friendlyMediaMessage(message) {
  const lecture = String(message).match(/Lecture\s+(\d+\/\d+):\s*(.*)/i);
  const prefix = lecture ? `Lecture ${lecture[1]}` : "";
  const text = lecture ? lecture[2] : String(message);
  if (/real transcript|already captured|skipping/i.test(text)) {
    return { message: "Skipping completed lecture", detail: prefix || "Already captured." };
  }
  if (/Checking for exposed captions/i.test(text)) {
    return { message: "Checking for captions", detail: prefix };
  }
  if (/Checking YouTube captions/i.test(text)) {
    return { message: "Checking YouTube captions", detail: prefix };
  }
  if (/Converting lecture stream/i.test(text)) {
    return { message: "Downloading lecture video", detail: prefix };
  }
  if (/Extracting lecture audio/i.test(text)) {
    return { message: "Extracting lecture audio", detail: prefix };
  }
  if (/Generating transcript/i.test(text)) {
    return { message: "Transcribing lecture", detail: prefix };
  }
  if (/Found \d+ lecture/i.test(text)) {
    return { message: "Preparing lecture transcripts", detail: text };
  }
  if (/finished/i.test(text)) {
    return { message: "Lecture transcripts ready", detail: "" };
  }
  return { message: text, detail: prefix };
}

async function askTabIn(tabId, type, payload = {}) {
  await injectLatestContentScript(tabId, type);
  return chrome.tabs.sendMessage(tabId, { type, ...payload });
}

async function injectLatestContentScript(tabId, type) {
  const files = [];
  if (type.startsWith("SCRAPE_CANVAS")) files.push("src/content/canvas.js");
  if (type.startsWith("UPLOAD_CANVAS_FILES")) files.push("src/content/canvas.js");
  if (type.startsWith("CAPTURE_ALL_LECTURES")) files.push("src/content/media.js");
  if (!files.length) return;
  await chrome.scripting.executeScript({ target: { tabId }, files });
}

async function helper(path, options = {}) {
  const response = await fetch(`${HELPER}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!response.ok) throw new Error(await response.text() || `Helper returned ${response.status}`);
  return response;
}

async function checkHelper() {
  await helper("/health");
}

async function exportFolder(binName) {
  const response = await helper(`/api/bin/${encodeURIComponent(binName)}/export-folder`, { method: "POST" });
  return response.json();
}

async function saveBins(bins, { merge = false } = {}) {
  const saved = await chrome.storage.local.get(["bundlrBins"]);
  const byName = new Map((merge ? saved.bundlrBins || [] : []).map((bin) => [bin.name, bin]));
  for (const bin of bins) byName.set(bin.name, { ...(byName.get(bin.name) || {}), ...bin });
  await chrome.storage.local.set({ bundlrBins: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)) });
}

async function setDragPayload(binName) {
  const filename = `${safeFile(binName)}-upload-set`;
  await chrome.storage.local.set({
    lastBinName: binName,
    dropReadyBinName: binName,
    dropReadyFilename: filename,
    dropReadyAt: Date.now()
  });
}

async function savedLectureSources() {
  const saved = await chrome.storage.local.get(["bundlrLectureSources", "bundlrLectureLinksByBin"]);
  return saved.bundlrLectureSources || linksMapToSources(saved.bundlrLectureLinksByBin || {});
}

async function attachAuthHeaders(mediaItems, pageUrl) {
  return Promise.all(mediaItems.map(async (item) => {
    const referer = item.pageUrl || pageUrl;
    const url = item.sources?.[0] || item.captions?.[0]?.src || referer;
    const headers = await authHeadersForUrl(url, referer).catch(() => ({
      referer,
      userAgent: globalThis.navigator?.userAgent || "Bundlr"
    }));
    return { ...item, requestHeaders: headers };
  }));
}

async function authHeadersForUrl(url, pageUrl) {
  const cookies = await chrome.cookies.getAll({ url });
  return {
    cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
    referer: pageUrl || url,
    userAgent: globalThis.navigator?.userAgent || "Bundlr"
  };
}

function configureAlarm(intervalMinutes) {
  chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: Math.max(1, Number(intervalMinutes) || 30),
    periodInMinutes: Math.max(1, Number(intervalMinutes) || 30)
  });
}

async function runAutoSync() {
  const { lastCanvasSync } = await chrome.storage.local.get("lastCanvasSync");
  if (!lastCanvasSync?.courseUrl) {
    await notify("Bundlr", "Open a Canvas course once before auto-sync can run.");
    return;
  }

  const tabs = await chrome.tabs.query({ url: `${lastCanvasSync.origin}/*` });
  const tab = tabs.find((candidate) => candidate.url?.includes(`/courses/${lastCanvasSync.courseId}`));
  if (!tab?.id) {
    await notify("Bundlr", "Auto-sync skipped because the Canvas course is not open.");
    return;
  }

  try {
    const result = await askTabIn(tab.id, "SCRAPE_CANVAS_COURSE_V2", { maxFileTextBytes: 300000 });
    if (!result?.ok) throw new Error(result?.error || "Canvas scrape failed.");
    await helper("/api/canvas/sync", {
      method: "POST",
      body: JSON.stringify({ binName: lastCanvasSync.binName, course: result.course })
    });
  } catch (error) {
    await notify("Bundlr", `Auto-sync failed: ${error.message}`);
  }
}

async function notify(title, message) {
  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: "icon.svg",
      title,
      message
    });
  } catch {
    // Notifications are helpful but not critical to the sync loop.
  }
}

function groupLectureMediaByCourse(media, page, courses, source) {
  const groups = new Map();
  for (const item of media) {
    const course = matchLectureMediaToCourse(item, page, courses, source);
    if (!course) continue;
    const binName = binNameForCourse(course);
    if (!groups.has(binName)) groups.set(binName, []);
    groups.get(binName).push(item);
  }
  return groups;
}

function lectureMediaFromCanvasCourse(course) {
  const media = [];
  let lectureIndex = 1;
  for (const module of course.modules || []) {
    for (const item of module.items || []) {
      const title = item.title || "";
      const url = item.external_url || item.externalUrl || item.url || item.html_url || item.htmlUrl;
      if (!url || !isCanvasLectureItem(title, url, item)) continue;
      media.push({
        kind: isYouTubeUrl(url) ? "youtube" : "canvas-lecture",
        title,
        pageTitle: module.name || course.name,
        pageUrl: item.html_url || item.htmlUrl || course.url,
        lectureIndex,
        lectureLabel: title,
        sources: [url],
        captions: [],
        canvasModuleItemId: item.id,
        canvasModuleId: item.module_id || module.id,
        youtube: isYouTubeUrl(url) ? { videoId: youtubeVideoId(url) } : null
      });
      lectureIndex += 1;
    }
  }
  return media;
}

function isCanvasLectureItem(title, url, item = {}) {
  const text = normalizeMatchText(`${title} ${url} ${item.type || ""}`);
  if (!/\b(lecture|recording|course capture|class capture|video)\b/i.test(text)) return false;
  if (isYouTubeUrl(url)) return true;
  if (/\.(mp4|m4v|mov|m3u8|mp3|m4a|wav|webm|vtt|srt)(\?|#|$)/i.test(url)) return true;
  if (/kaltura|panopto|podcast|zoom|media_objects|external_tools|module_item_redirect/i.test(url)) return true;
  return /\/courses\/\d+\/(?:modules\/items\/\d+|pages\/[^?#]+|files\/\d+)/i.test(url);
}

function matchLectureMediaToCourse(item, page, courses, source) {
  const haystack = normalizeMatchText([
    item.title,
    item.pageTitle,
    item.lectureLabel,
    item.pageUrl,
    page?.title,
    page?.url,
    source?.label,
    source?.url
  ].filter(Boolean).join(" "));
  const compactHaystack = haystack.replace(/\s+/g, "");
  let best = null;
  let bestScore = 0;
  for (const course of courses) {
    const code = normalizeMatchText(course.courseCode || "");
    const name = normalizeMatchText(course.name || "");
    const compactCode = compactCourseCode(course.courseCode || course.name || "");
    let score = 0;
    if (code && haystack.includes(code)) score += 80;
    if (compactCode && compactHaystack.includes(compactCode)) score += 120;
    if (name && haystack.includes(name)) score += 60;
    for (const token of courseTokens(course)) {
      if (haystack.includes(token)) score += 20;
    }
    if (score > bestScore) {
      bestScore = score;
      best = course;
    }
  }
  return bestScore >= 40 ? best : null;
}

function courseTokens(course) {
  return normalizeMatchText(`${course.courseCode || ""} ${course.name || ""}`)
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !/^(spring|winter|fall|summer|sp|wi|fa|su|section|lecture|course|introduction|intro)$/i.test(token));
}

function compactCourseCode(value) {
  const match = String(value || "").match(/\b([A-Z]{2,5})\s*[- ]?\s*(\d+[A-Z]?)\b/i);
  return match ? normalizeMatchText(`${match[1]}${match[2]}`) : "";
}

function normalizeMatchText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function isYouTubeUrl(value = "") {
  try {
    const parsed = new URL(value);
    return /(^|\.)youtube\.com$/i.test(parsed.hostname) || /^youtu\.be$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

function youtubeVideoId(value = "") {
  try {
    const parsed = new URL(value);
    if (/^youtu\.be$/i.test(parsed.hostname)) return parsed.pathname.split("/").filter(Boolean)[0] || null;
    if (parsed.searchParams.get("v")) return parsed.searchParams.get("v");
    return parsed.pathname.match(/\/(?:embed|shorts|watch)\/([^/?#]+)/i)?.[1] || null;
  } catch {
    return null;
  }
}

function binNameForCourse(course) {
  return course.name || course.courseCode || `Course ${course.id}`;
}

function linksMapToSources(map) {
  return Object.entries(map || {}).map(([label, url]) => ({ label, url })).filter((item) => item.url);
}

function sourcesToLegacyMap(sources) {
  const out = {};
  for (const source of sources || []) out[source.label || source.url] = source.url;
  return out;
}

function stripHash(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return value || "";
  }
}

function safeFile(value) {
  return String(value || "course").replace(/[^a-z0-9]+/gi, "-");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTabReady(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 30000);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error(chrome.runtime.lastError.message));
      } else if (tab.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}
