const HELPER = "http://127.0.0.1:8765";

const $ = (id) => document.getElementById(id);
const logEl = $("log");
const binsList = $("binsList");
const courseButton = $("downloadCourseContent");
const refreshButton = $("refreshBins");

const CUSTOM_DROP_TYPE = "application/x-bundlr-upload-set";
const TEXT_DROP_PREFIX = "BUNDLR_UPLOAD_SET:";
let dragPayload = null;
let activeJob = null;

function log(message, detail = "") {
  const status = activeJob?.status || "idle";
  logEl.className = `status-panel ${status}`;
  logEl.innerHTML = `
    <div class="status-orb" aria-hidden="true"></div>
    <div>
      <strong>${escapeHtml(message)}</strong>
      <span>${escapeHtml(detail)}</span>
    </div>
  `;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found.");
  return tab;
}

async function askTab(type, payload = {}) {
  const tab = await activeTab();
  await injectLatestContentScript(tab.id, type);
  return chrome.tabs.sendMessage(tab.id, { type, ...payload });
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
  try {
    const response = await helper("/health");
    const data = await response.json();
    if (activeJob?.status === "running") return;
    log("Bundlr is connected", `Bins: ${data.binRoot}`);
    if (!data.localWhisper) log("Caption-only mode", "Local Whisper was not found, so uncaptioned lectures need setup first.");
  } catch {
    log("Bundlr helper is offline", "Start it with: npm run helper");
  }
}

async function downloadCourseContent({ refresh = false } = {}) {
  courseButton.disabled = true;
  refreshButton.disabled = true;
  try {
    const tab = await activeTab();
    const saved = await chrome.storage.local.get(["bundlrLectureSources", "bundlrLectureLinksByBin"]);
    const savedLinks = saved.bundlrLectureLinksByBin || {};
    const savedSources = saved.bundlrLectureSources || linksMapToSources(savedLinks);
    const lectureInput = refresh
      ? linksToPromptText(savedSources)
      : window.prompt(
        "Paste lecture/podcast links if you want transcripts. One class or index link per line is fine. Labels help, e.g. COGS 18 = https://podcast...",
        ""
      );
    const lectureLinks = parseLectureLinks(lectureInput || "");
    log("Starting in the background", "You can close this popup or switch tabs.");
    await chrome.runtime.sendMessage({
      type: "BUNDLR_START_DOWNLOAD",
      refresh,
      tab: pickTab(tab),
      lectureSources: lectureLinks.length ? lectureLinks : savedSources
    });
    await syncJobUi();
  } catch (error) {
    log(error.message);
  } finally {
    await syncJobUi();
  }
}

async function scrapeCoursesForTab(tab) {
  const url = new URL(tab.url);
  if (/\/courses\/\d+/i.test(url.pathname)) {
    const result = await askTab("SCRAPE_CANVAS_COURSE_V2", { maxFileTextBytes: 300000 });
    if (!result?.ok) throw new Error(result?.error || "Canvas scrape failed.");
    return [result.course];
  }
  const result = await askTab("SCRAPE_CANVAS_DASHBOARD_V1", {
    maxFileTextBytes: 300000,
    maxCourses: 20
  });
  if (!result?.ok) throw new Error(result?.error || "Canvas dashboard scrape failed.");
  return result.courses || [];
}

async function syncCourseToBin(binName, course) {
  for (const warning of (course.warnings || []).slice(0, 4)) log(`Warning: ${warning}`);
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

  if (downloadableFiles.length) {
    log(`Saving ${downloadableFiles.length} reading/file(s) for ${binName}...`);
    const uploadResult = await askTab("UPLOAD_CANVAS_FILES_V1", {
      helperUrl: HELPER,
      binName,
      files: downloadableFiles,
      maxBytes: 75000000
    });
    if (!uploadResult?.ok) throw new Error(uploadResult?.error || "File upload failed.");
    log(`Saved ${uploadResult.uploaded.length}; ${uploadResult.failed.length} skipped.`);
  }
}

async function syncLectureSourcesToMatchingBins(courses, lectureSources, currentTab) {
  for (const source of lectureSources) {
    log(`Scanning lecture source: ${source.label ? `${source.label} ` : ""}${source.url}`);
    const result = await captureLectureSource(source.url, currentTab);
    if (!result.media?.length) {
      log(`No lecture media found at ${source.url}. If it opened a login page, log in there and run refresh.`);
      continue;
    }
    const media = await attachAuthHeaders(result.media || [], result.page?.url);
    const groups = groupLectureMediaByCourse(media, result.page, courses, source);
    if (!groups.size && courses.length === 1) {
      groups.set(binNameForCourse(courses[0]), media);
    }
    for (const [binName, items] of groups) {
      log(`Adding ${items.length} lecture item(s) to ${binName}...`);
      const response = await helper("/api/media/capture/start", {
        method: "POST",
        body: JSON.stringify({ binName, page: result.page, media: items, all: true, keepMp4: true })
      });
      const job = await response.json();
      await pollMediaJob(job.id);
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

function setDragPayload(binName) {
  const filename = `${safeFile(binName)}-upload-set`;
  dragPayload = { binName, filename };
  chrome.storage.local.set({
    lastBinName: binName,
    dropReadyBinName: binName,
    dropReadyFilename: filename,
    dropReadyAt: Date.now()
  });
  injectDropBridgeIntoActiveTab().catch(() => undefined);
  return dragPayload;
}

async function exportFolder(binName) {
  const response = await helper(`/api/bin/${encodeURIComponent(binName)}/export-folder`, { method: "POST" });
  return response.json();
}

async function addOpenLectureTabToBin(binName) {
  log("Starting lecture capture", `${binName} will keep working in the background.`);
  const tab = await activeTab();
  await chrome.runtime.sendMessage({
    type: "BUNDLR_START_LECTURE",
    binName,
    tab: pickTab(tab)
  });
  await syncJobUi();
}

function startDrag(event) {
  const binName = event.currentTarget?.dataset?.binName || dragPayload?.binName;
  if (!binName) {
    event.preventDefault();
    log("Download course content first.");
    return;
  }
  const payload = setDragPayload(binName);
  const encoded = btoa(JSON.stringify(payload));
  injectDropBridgeIntoActiveTab().catch(() => undefined);
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData(CUSTOM_DROP_TYPE, encoded);
  event.dataTransfer.setData("text/plain", `${TEXT_DROP_PREFIX}${encoded}`);
}

async function injectDropBridgeIntoActiveTab() {
  const tab = await activeTab();
  if (!tab?.id || !/^https?:\/\//i.test(tab.url || "")) return;
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["src/content/drop.js"]
  });
}

async function saveBins(bins, { merge = false } = {}) {
  const saved = await chrome.storage.local.get(["bundlrBins"]);
  const byName = new Map((merge ? saved.bundlrBins || [] : []).map((bin) => [bin.name, bin]));
  for (const bin of bins) byName.set(bin.name, { ...(byName.get(bin.name) || {}), ...bin });
  await chrome.storage.local.set({ bundlrBins: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)) });
}

async function deleteBin(binName) {
  const confirmed = window.confirm(`Delete "${binName}" from Bundlr?\n\nThis removes the local course bin folder and its ZIP from this computer.`);
  if (!confirmed) return;
  await helper(`/api/bin/${encodeURIComponent(binName)}`, { method: "DELETE" });
  const saved = await chrome.storage.local.get(["bundlrBins", "bundlrLectureLinksByBin", "dropReadyBinName"]);
  const nextBins = (saved.bundlrBins || []).filter((bin) => bin.name !== binName);
  const nextLinks = { ...(saved.bundlrLectureLinksByBin || {}) };
  delete nextLinks[binName];
  const nextStorage = {
    bundlrBins: nextBins,
    bundlrLectureLinksByBin: nextLinks
  };
  if (saved.dropReadyBinName === binName) {
    dragPayload = null;
    nextStorage.dropReadyBinName = "";
    nextStorage.dropReadyFilename = "";
    nextStorage.lastBinName = "";
  }
  await chrome.storage.local.set(nextStorage);
  await renderBins();
  log(`Deleted ${binName}.`);
}

async function renderBins() {
  const saved = await chrome.storage.local.get(["bundlrBins", "bundlrActiveJob"]);
  const bins = saved.bundlrBins || [];
  const job = saved.bundlrActiveJob || null;
  const busyBins = new Set(job?.status === "running" ? job.activeBinNames || [] : []);
  binsList.innerHTML = "";
  if (!bins.length) {
    binsList.innerHTML = `<div class="empty-bin">No bins yet</div>`;
    return;
  }
  for (const bin of bins) {
    const item = document.createElement("div");
    const isBusy = busyBins.has(bin.name);
    item.className = `bin-row${isBusy ? " is-busy" : ""}`;
    item.draggable = true;
    item.dataset.binName = bin.name;
    item.innerHTML = `
      <button class="bin-main" type="button" aria-label="Open ${escapeHtml(bin.name)} in Downloads">
        <span>${escapeHtml(bin.name)}</span>
        <small>${isBusy ? "Working in the background" : `Click to open folder • drag to AI • ${bin.updatedAt ? new Date(bin.updatedAt).toLocaleString() : "Not synced"}`}</small>
      </button>
      <button class="bin-lecture" type="button" aria-label="Add open lecture tab to ${escapeHtml(bin.name)}">
        ${isBusy ? `<span class="mini-spinner" aria-hidden="true"></span>Loading` : "Lecture"}
      </button>
      <button class="bin-delete" type="button" aria-label="Delete ${escapeHtml(bin.name)}">Delete</button>
    `;
    item.querySelector(".bin-lecture").disabled = isBusy;
    item.querySelector(".bin-main").addEventListener("click", (event) => {
      event.stopPropagation();
      openBinFolder(bin.name).catch((error) => log(error.message));
    });
    item.querySelector(".bin-delete").addEventListener("click", (event) => {
      event.stopPropagation();
      deleteBin(bin.name).catch((error) => log(error.message));
    });
    item.querySelector(".bin-lecture").addEventListener("click", (event) => {
      event.stopPropagation();
      addOpenLectureTabToBin(bin.name).catch((error) => log(error.message));
    });
    item.addEventListener("click", () => {
      openBinFolder(bin.name).catch((error) => log(error.message));
    });
    item.addEventListener("dragstart", startDrag);
    binsList.appendChild(item);
  }
}

async function openBinFolder(binName) {
  log(`Opening ${binName} in Downloads...`);
  const result = await exportFolder(binName);
  setDragPayload(binName);
  log(`Folder opened: ${result.folderPath}`);
}

function parseLectureLinks(input) {
  return String(input || "").split(/\n+/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const eq = line.indexOf("=");
    if (eq > -1) return { label: line.slice(0, eq).trim(), url: normalizeUrl(line.slice(eq + 1).trim()) };
    return { label: "", url: normalizeUrl(line) };
  }).filter((item) => item.url);
}

function matchLectureLink(course, links, { singleCourse = false } = {}) {
  if (!links.length) return "";
  if (singleCourse && links.length === 1 && !links[0].label) return links[0].url;
  const haystack = `${course.name || ""} ${course.courseCode || ""}`.toLowerCase();
  return links.find((link) => link.label && (haystack.includes(link.label.toLowerCase()) || link.label.toLowerCase().includes(String(course.courseCode || "").toLowerCase())))?.url || "";
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

function binNameForCourse(course) {
  return course.name || course.courseCode || `Course ${course.id}`;
}

function linksToPromptText(sources) {
  return (Array.isArray(sources) ? sources : linksMapToSources(sources))
    .map((source) => source.label ? `${source.label} = ${source.url}` : source.url)
    .join("\n");
}

function linksMapToSources(map) {
  return Object.entries(map || {}).map(([label, url]) => ({ label, url })).filter((item) => item.url);
}

function sourcesToLegacyMap(sources) {
  const out = {};
  for (const source of sources || []) {
    out[source.label || source.url] = source.url;
  }
  return out;
}

async function pollMediaJob(id) {
  let lastMessage = "";
  for (let attempt = 0; attempt < 720; attempt++) {
    await sleep(2500);
    const response = await helper(`/api/media/capture/job/${encodeURIComponent(id)}`);
    const job = await response.json();
    if (job.message && job.message !== lastMessage) {
      lastMessage = job.message;
      log(job.message);
    }
    if (job.status === "done") return job;
    if (job.status === "error") throw new Error(job.error || "Lecture capture failed.");
  }
  throw new Error("Lecture capture is still running after 30 minutes.");
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

async function attachAuthHeaders(mediaItems, pageUrl) {
  return Promise.all(mediaItems.map(async (item) => {
    const referer = item.pageUrl || pageUrl;
    const url = item.sources?.[0] || item.captions?.[0]?.src || referer;
    const headers = await authHeadersForUrl(url, referer).catch(() => ({ referer, userAgent: navigator.userAgent }));
    return { ...item, requestHeaders: headers };
  }));
}

async function authHeadersForUrl(url, pageUrl) {
  const cookies = await chrome.cookies.getAll({ url });
  return {
    cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
    referer: pageUrl || url,
    userAgent: navigator.userAgent
  };
}

function normalizeUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  try {
    return new URL(trimmed).href;
  } catch {
    try {
      return new URL(`https://${trimmed}`).href;
    } catch {
      return "";
    }
  }
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

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

document.addEventListener("DOMContentLoaded", async () => {
  const saved = await chrome.storage.local.get(["dropReadyBinName", "dropReadyFilename"]);
  if (saved.dropReadyBinName && saved.dropReadyFilename) {
    dragPayload = { binName: saved.dropReadyBinName, filename: saved.dropReadyFilename };
  }
  await syncJobUi();
  checkHelper();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.bundlrActiveJob || changes.bundlrBins) syncJobUi();
});

async function syncJobUi() {
  const response = await chrome.runtime.sendMessage({ type: "BUNDLR_GET_JOB" }).catch(() => null);
  activeJob = response?.job || (await chrome.storage.local.get("bundlrActiveJob")).bundlrActiveJob || null;
  const isRunning = activeJob?.status === "running";
  courseButton.disabled = isRunning;
  refreshButton.disabled = isRunning;
  if (activeJob?.message) log(activeJob.message, activeJob.detail || "");
  else log("Ready when you are", "Open Canvas or a lecture page, then start a download.");
  await renderBins();
}

function pickTab(tab) {
  return {
    id: tab.id,
    url: tab.url,
    title: tab.title,
    windowId: tab.windowId
  };
}

courseButton.addEventListener("click", () => downloadCourseContent());
refreshButton.addEventListener("click", () => downloadCourseContent({ refresh: true }));
