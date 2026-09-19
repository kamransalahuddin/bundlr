(() => {
  const SCRIPT_VERSION = "2026-05-02-dashboard-courses";
  if (window.__canvasContextBinCanvasVersion === SCRIPT_VERSION) return;
  window.__canvasContextBinCanvasVersion = SCRIPT_VERSION;

  const API_PREFIX = "/api/v1";

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "SCRAPE_CANVAS_COURSE_V2") {
      scrapeCanvasCourse({
        maxFileTextBytes: message.maxFileTextBytes || 300000
      })
        .then((course) => sendResponse({ ok: true, course }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === "SCRAPE_CANVAS_DASHBOARD_V1") {
      scrapeCanvasDashboard({
        maxFileTextBytes: message.maxFileTextBytes || 300000,
        maxCourses: message.maxCourses || 20
      })
        .then((payload) => sendResponse({ ok: true, ...payload }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === "UPLOAD_CANVAS_FILES_V1") {
      uploadCanvasFiles(message)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    return false;
  });

  async function scrapeCanvasCourse({ maxFileTextBytes }) {
    const courseId = detectCourseId();
    if (!courseId) {
      throw new Error("Open a Canvas course page first. I need a /courses/<id> URL.");
    }
    return scrapeCanvasCourseById(courseId, { maxFileTextBytes });
  }

  async function scrapeCanvasDashboard({ maxFileTextBytes, maxCourses }) {
    const courses = await firstPaginate([
      `${API_PREFIX}/courses?enrollment_state=active&include[]=term&per_page=100`,
      `${API_PREFIX}/courses?per_page=100`
    ], "courses", []);
    const activeCourses = courses
      .filter((course) => course?.id && !course.access_restricted_by_date)
      .filter((course) => course.workflow_state !== "unpublished")
      .slice(0, maxCourses);
    if (!activeCourses.length) throw new Error("No active Canvas courses found on this dashboard.");

    const scraped = await limitMap(activeCourses, 2, (course) => scrapeCanvasCourseById(course.id, {
      maxFileTextBytes,
      courseSeed: course
    }));
    return {
      dashboard: {
        origin: location.origin,
        url: location.href,
        syncedAt: new Date().toISOString(),
        courseCount: scraped.length
      },
      courses: scraped
    };
  }

  async function scrapeCanvasCourseById(courseId, { maxFileTextBytes, courseSeed = null }) {
    const warnings = [];
    const course = await getJson(`${API_PREFIX}/courses/${courseId}`).catch((error) => {
      warnings.push(`Course metadata API blocked: ${error.message}`);
      return courseSeed || {
        id: courseId,
        name: detectCourseName(),
        course_code: ""
      };
    });

    const [assignments, modules, pagesList, discussions, files] = await Promise.all([
      firstPaginate([
        `${API_PREFIX}/courses/${courseId}/assignments?include[]=description&per_page=100`,
        `${API_PREFIX}/courses/${courseId}/assignments?per_page=100`
      ], "assignments", warnings),
      firstPaginate([
        `${API_PREFIX}/courses/${courseId}/modules?include[]=items&per_page=100`,
        `${API_PREFIX}/courses/${courseId}/modules?per_page=100`
      ], "modules", warnings),
      firstPaginate([`${API_PREFIX}/courses/${courseId}/pages?per_page=100`], "pages", warnings),
      firstPaginate([
        `${API_PREFIX}/courses/${courseId}/discussion_topics?include[]=all_dates&per_page=100`,
        `${API_PREFIX}/courses/${courseId}/discussion_topics?per_page=100`
      ], "discussion topics", warnings),
      firstPaginate([`${API_PREFIX}/courses/${courseId}/files?per_page=100`], "files", warnings)
    ]);

    const [pages, discussionDetails, fileDetails] = await Promise.all([
      limitMap(pagesList, 5, async (page) => getJson(`${API_PREFIX}/courses/${courseId}/pages/${encodeURIComponent(page.url)}`)
        .catch((error) => {
          warnings.push(`Page detail blocked for ${page.title || page.url}: ${error.message}`);
          return page;
        })),
      limitMap(discussions, 3, async (topic) => getDiscussion(courseId, topic, warnings)),
      captureFileText(files, { maxFileTextBytes })
    ]);

    const htmlFallback = await scrapeCanvasHtml(courseId, warnings);
    const mergedAssignments = assignments.length ? assignments : htmlFallback.assignments;
    const mergedDiscussions = discussionDetails.length ? discussionDetails : htmlFallback.discussions;
    const mergedFiles = fileDetails.length ? fileDetails : htmlFallback.files;
    const mergedModules = modules.length ? modules : htmlFallback.modules;
    const mergedPages = mergeByUrl([...pages, ...htmlFallback.pages]);

    if (!mergedAssignments.length && !mergedModules.length && !mergedPages.length && !mergedDiscussions.length && !mergedFiles.length) {
      warnings.push("Canvas API returned no course sections, so I captured the visible page text as a fallback.");
      mergedPages.push(scrapeVisiblePage());
    }

    return {
      id: courseId,
      name: course.name || course.course_code || `Course ${courseId}`,
      courseCode: course.course_code,
      origin: location.origin,
      htmlUrl: `${location.origin}/courses/${courseId}`,
      syncedAt: new Date().toISOString(),
      summary: {
        assignmentCount: mergedAssignments.length,
        discussionCount: mergedDiscussions.length,
        fileCount: mergedFiles.length,
        moduleCount: mergedModules.length,
        pageCount: mergedPages.length
      },
      assignments: mergedAssignments,
      discussions: mergedDiscussions,
      files: mergedFiles,
      modules: mergedModules,
      pages: mergedPages,
      warnings
    };
  }

  function detectCourseId() {
    const match = location.pathname.match(/\/courses\/(\d+)/);
    return match?.[1] || null;
  }

  function detectCourseName() {
    return document.querySelector("h1")?.textContent?.trim() ||
      document.querySelector(".course-title")?.textContent?.trim() ||
      document.title.replace(/\s*:\s*Canvas.*$/i, "").trim() ||
      `Course ${detectCourseId()}`;
  }

  function scrapeVisiblePage() {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll("script, style, nav, header, footer, button, input, select, textarea").forEach((node) => node.remove());
    const text = cleanCanvasText(clone.textContent);
    return {
      title: document.title,
      html_url: location.href,
      body: `<pre>${escapeHtml(text.slice(0, 50000))}</pre>`
    };
  }

  async function scrapeCanvasHtml(courseId, warnings) {
    const base = `${location.origin}/courses/${courseId}`;
    const sections = [
      { key: "home", url: base, title: "Home" },
      { key: "assignments", url: `${base}/assignments`, title: "Assignments" },
      { key: "discussion_topics", url: `${base}/discussion_topics`, title: "Discussions" },
      { key: "modules", url: `${base}/modules`, title: "Modules" },
      { key: "pages", url: `${base}/pages`, title: "Pages" },
      { key: "files", url: `${base}/files`, title: "Files" }
    ];

    const result = {
      assignments: [],
      discussions: [],
      files: [],
      modules: [],
      pages: []
    };
    const detailUrls = new Set();

    for (const section of sections) {
      const snapshot = await fetchCanvasHtml(section.url, `Canvas ${section.title}`, warnings);
      if (!snapshot) continue;
      result.pages.push({
        title: `Canvas HTML: ${section.title}`,
        html_url: section.url,
        body: snapshot.body
      });
      for (const href of snapshot.links) {
        if (isCourseDetailUrl(href, courseId)) detailUrls.add(href);
      }
    }

    const detailSnapshots = await limitMap([...detailUrls].slice(0, 120), 5, (url) => fetchCanvasHtml(url, "Canvas Detail", warnings));
    for (const snapshot of detailSnapshots.filter(Boolean)) {
      if (/\/assignments\/\d+/.test(snapshot.url)) {
        result.assignments.push({
          id: snapshot.url,
          name: snapshot.title,
          html_url: snapshot.url,
          description: snapshot.body
        });
      } else if (/\/discussion_topics\/\d+/.test(snapshot.url)) {
        result.discussions.push({
          id: snapshot.url,
          title: snapshot.title,
          html_url: snapshot.url,
          message: snapshot.body,
          entries: []
        });
      } else if (/\/pages\//.test(snapshot.url)) {
        result.pages.push({
          title: snapshot.title,
          html_url: snapshot.url,
          body: snapshot.body
        });
      } else if (/\/files\/\d+/.test(snapshot.url)) {
        const fileId = snapshot.url.match(/\/files\/(\d+)/)?.[1] || snapshot.url;
        result.files.push({
          id: fileId,
          displayName: snapshot.title,
          filename: snapshot.title,
          contentType: "Canvas HTML file page",
          size: null,
          url: snapshot.url,
          downloadUrlCandidates: canvasFileDownloadCandidates({
            id: fileId,
            url: snapshot.url,
            html_url: snapshot.url
          }, courseId),
          updatedAt: null,
          text: htmlBodyToPlain(snapshot.body),
          textStatus: "captured-html-page",
          binaryStatus: "not-captured"
        });
      } else if (/\/modules(\/items\/\d+)?/.test(snapshot.url)) {
        result.modules.push({
          id: snapshot.url,
          name: snapshot.title,
          items: [{ title: snapshot.title, type: "Canvas HTML", html_url: snapshot.url }]
        });
        result.pages.push({
          title: snapshot.title,
          html_url: snapshot.url,
          body: snapshot.body
        });
      }
    }

    if (result.assignments.length || result.discussions.length || result.files.length || result.modules.length || result.pages.length) {
      warnings.push("Used Canvas HTML fallback in addition to API capture.");
    }

    result.assignments = mergeByUrl(result.assignments, "html_url");
    result.discussions = mergeByUrl(result.discussions, "html_url");
    result.files = mergeByUrl(result.files, "url");
    result.modules = mergeByUrl(result.modules, "id");
    result.pages = mergeByUrl(result.pages);
    return result;
  }

  async function fetchCanvasHtml(url, fallbackTitle, warnings) {
    try {
      const response = await fetch(url, {
        credentials: "include",
        headers: { accept: "text/html,application/xhtml+xml" }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      doc.querySelectorAll("script, style, noscript, svg, canvas, nav, header, footer, button, input, select, textarea").forEach((node) => node.remove());
      const title = doc.querySelector("h1")?.textContent?.trim() ||
        doc.querySelector("title")?.textContent?.replace(/\s*:\s*Canvas.*$/i, "").trim() ||
        fallbackTitle;
      const main = doc.querySelector("#content, #main, main, [role='main'], .ic-Layout-contentMain, body") || doc.body;
      const text = cleanCanvasText(main.textContent);
      const links = [...doc.querySelectorAll("a[href]")]
        .map((anchor) => new URL(anchor.getAttribute("href"), location.origin).href)
        .filter((href) => href.startsWith(`${location.origin}/courses/`));
      const linkText = [...new Set(links)].slice(0, 200).map((href) => `- ${href}`).join("\n");
      return {
        url,
        title,
        body: `<pre>${escapeHtml(text.slice(0, 100000))}</pre>${linkText ? `\n\nLinks:\n${escapeHtml(linkText)}` : ""}`,
        links: [...new Set(links)]
      };
    } catch (error) {
      warnings.push(`HTML fallback blocked for ${url}: ${error.message}`);
      return null;
    }
  }

  function isCourseDetailUrl(url, courseId) {
    const escapedCourse = String(courseId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`/courses/${escapedCourse}/(assignments/\\d+|discussion_topics/\\d+|pages/[^?#]+|files/\\d+|modules/items/\\d+)`).test(url);
  }

  function htmlBodyToPlain(body) {
    const doc = new DOMParser().parseFromString(body, "text/html");
    return cleanCanvasText(doc.body.textContent);
  }

  function mergeByUrl(items, key = "html_url") {
    const seen = new Set();
    const merged = [];
    for (const item of items) {
      const identity = item?.[key] || item?.url || item?.title || JSON.stringify(item).slice(0, 100);
      if (seen.has(identity)) continue;
      seen.add(identity);
      merged.push(item);
    }
    return merged;
  }

  function escapeHtml(value) {
    return value.replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    })[char]);
  }

  function cleanCanvasText(text = "") {
    const exactNoise = new Set([
      "Score at least",
      "Scored at least",
      "Score at least %",
      "Scored at least %",
      "View",
      "Viewed",
      "Mark done",
      "Marked done",
      "Submit",
      "Submitted",
      "Contribute",
      "Contributed",
      "Must score at least to complete this module item",
      "Module item has been completed by scoring at least",
      "Must score at least % to complete this module item",
      "Module item has been completed by scoring at least %",
      "Must view in order to complete this module item",
      "Module item has been viewed and is complete",
      "Must mark this module item done in order to complete",
      "Module item marked as done and is complete",
      "Must submit the assignment to complete this module item",
      "Module item has been submitted and is complete",
      "Must contribute to the page to complete this module item",
      "Module item has been contributed to and is complete"
    ]);
    const patternNoise = [
      /^Previous Module$/,
      /^Next Module$/,
      /^Collapse All$/,
      /^Expand All$/,
      /^Requirements?$/,
      /^Prerequisites?$/,
      /^Complete All Items$/,
      /^Complete One Item$/,
      /^Choose a path$/,
      /^This page is part of the module .+$/i,
      /^This assignment is part of the module .+$/i,
      /^This discussion is part of the module .+$/i,
      /^Must .+ to complete this module item$/i,
      /^Module item .+ is complete$/i,
      /^Module item has been .+ and is complete$/i
    ];
    const seen = new Map();
    const lines = [];
    for (const rawLine of String(text)
      .replace(/[ \t]+\n/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) {
        if (lines.at(-1) !== "") lines.push("");
        continue;
      }
      if (exactNoise.has(line)) continue;
      if (patternNoise.some((pattern) => pattern.test(line))) continue;
      const count = seen.get(line) || 0;
      seen.set(line, count + 1);
      if (line.length < 120 && count >= 1) continue;
      lines.push(line);
    }
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  async function getDiscussion(courseId, topic, warnings) {
    const [detail, view] = await Promise.all([
      getJson(`${API_PREFIX}/courses/${courseId}/discussion_topics/${topic.id}`).catch((error) => {
        warnings.push(`Discussion detail blocked for ${topic.title || topic.id}: ${error.message}`);
        return topic;
      }),
      getJson(`${API_PREFIX}/courses/${courseId}/discussion_topics/${topic.id}/view?include_new_entries=1`).catch((error) => {
        warnings.push(`Discussion posts blocked for ${topic.title || topic.id}: ${error.message}`);
        return null;
      })
    ]);
    return {
      ...topic,
      detail,
      entries: flattenDiscussionEntries(view)
    };
  }

  function flattenDiscussionEntries(view) {
    if (!view) return [];
    const participantsById = new Map((view.participants || []).map((person) => [person.id, person]));
    const entries = [];
    const visit = (entry, depth = 0) => {
      const author = participantsById.get(entry.user_id);
      entries.push({
        id: entry.id,
        parentId: entry.parent_id || null,
        depth,
        author: author?.display_name || author?.name || entry.user_name || "Unknown",
        createdAt: entry.created_at,
        updatedAt: entry.updated_at,
        message: entry.message || ""
      });
      (entry.replies || []).forEach((reply) => visit(reply, depth + 1));
    };
    (view.view || []).forEach((entry) => visit(entry, 0));
    return entries;
  }

  async function captureFileText(files, limits) {
    return limitMap(files, 3, (file) => getFileCapture(file, limits));
  }

  async function getFileCapture(file, { maxFileTextBytes }) {
    const result = {
      id: file.id,
      displayName: file.display_name || file.filename,
      filename: file.filename,
      contentType: file["content-type"] || file.content_type,
      size: file.size,
      url: file.url,
      htmlUrl: file.html_url,
      downloadUrlCandidates: canvasFileDownloadCandidates(file),
      updatedAt: file.updated_at,
      text: null,
      textStatus: "not-text",
      binaryStatus: "available-by-url"
    };
    const type = `${result.contentType || ""}`.toLowerCase();
    const name = `${result.filename || ""}`.toLowerCase();
    const looksText = type.startsWith("text/") || /\.(md|txt|csv|json|html|htm|xml|vtt|srt)$/.test(name);
    const canCaptureText = looksText && Number(result.size || 0) <= maxFileTextBytes;
    try {
      if (!canCaptureText) {
        if (looksText) result.textStatus = "too-large";
        return result;
      }
      const response = await fetchFirstOk(result.downloadUrlCandidates, { accept: "*/*" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      result.text = (await response.text()).slice(0, maxFileTextBytes);
      result.textStatus = "captured";
    } catch (error) {
      if (looksText) result.textStatus = `failed: ${error.message}`;
      result.binaryStatus = `failed: ${error.message}`;
    }
    return result;
  }

  async function uploadCanvasFiles({ helperUrl, binName, files = [], maxBytes = 75000000, chunkBytes = 524288 }) {
    const uploaded = [];
    const failed = [];
    for (const file of files) {
      const candidates = canvasFileDownloadCandidates(file);
      if (!candidates.length) {
        failed.push({ file, error: "missing-url" });
        continue;
      }
      if (Number(file.size || 0) > maxBytes) {
        failed.push({ file, error: `too-large: ${file.size} bytes` });
        continue;
      }
      try {
        const response = await fetchFirstOk(candidates, { accept: "*/*" });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        const finalUrl = response.url || candidates[0];
        const metadata = {
          id: file.id,
          displayName: file.displayName || file.filename,
          filename: filenameFromResponse(response, file) || file.filename || file.displayName || `canvas-file-${file.id || Date.now()}`,
          contentType: file.contentType || response.headers.get("content-type") || "application/octet-stream",
          size: Number(file.size || response.headers.get("content-length") || 0),
          url: finalUrl,
          sourceUrl: file.url,
          htmlUrl: file.htmlUrl,
          downloadUrlCandidates: candidates,
          updatedAt: file.updatedAt || null
        };
        const start = await postJson(`${helperUrl}/api/canvas/upload-file/start`, { binName, file: metadata });
        await streamToHelper(response.body, `${helperUrl}/api/canvas/upload-file/chunk/${encodeURIComponent(start.uploadId)}`, chunkBytes);
        const finished = await postJson(`${helperUrl}/api/canvas/upload-file/finish/${encodeURIComponent(start.uploadId)}`, {});
        uploaded.push(finished);
      } catch (error) {
        failed.push({ file, error: error.message });
      }
    }
    return { uploaded, failed };
  }

  async function postJson(url, payload) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }

  async function fetchFirstOk(urls, { accept = "*/*" } = {}) {
    const errors = [];
    for (const url of urls) {
      try {
        const response = await fetch(url, {
          credentials: "include",
          redirect: "follow",
          headers: { accept }
        });
        if (response.ok) return response;
        errors.push(`${url}: HTTP ${response.status}`);
      } catch (error) {
        errors.push(`${url}: ${error.message}`);
      }
    }
    throw new Error(errors.join(" | ") || "No download URL worked.");
  }

  function canvasFileDownloadCandidates(file, courseId = null) {
    const candidates = [];
    const push = (value) => {
      if (!value) return;
      try {
        const href = new URL(value, location.origin).href;
        if (!candidates.includes(href)) candidates.push(href);
      } catch {
        // Ignore malformed Canvas links.
      }
    };
    const id = file.id || String(file.url || file.html_url || "").match(/\/files\/(\d+)/)?.[1];
    push(file.url);
    push(file.download_url);
    push(file.html_url);
    if (id) {
      const courseMatch = String(file.url || file.html_url || location.pathname).match(/\/courses\/(\d+)/);
      const resolvedCourseId = courseId || courseMatch?.[1] || detectCourseId();
      if (resolvedCourseId) push(`/courses/${resolvedCourseId}/files/${id}/download?download_frd=1`);
      push(`/files/${id}/download?download_frd=1`);
    }
    return candidates;
  }

  function filenameFromResponse(response, file) {
    const disposition = response.headers.get("content-disposition") || "";
    const utf = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    if (utf) return decodeURIComponent(utf.replace(/^"|"$/g, ""));
    const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1];
    if (plain) return plain;
    try {
      const urlName = decodeURIComponent(new URL(response.url).pathname.split("/").pop() || "");
      if (urlName && !/download/i.test(urlName)) return urlName;
    } catch {
      // Fall through.
    }
    return file.filename || file.displayName || "";
  }

  async function streamToHelper(stream, chunkUrl, chunkBytes) {
    const reader = stream.getReader();
    let pending = new Uint8Array(0);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending = concatBytes(pending, value);
      while (pending.length >= chunkBytes) {
        await postChunk(chunkUrl, pending.slice(0, chunkBytes));
        pending = pending.slice(chunkBytes);
      }
    }
    if (pending.length) await postChunk(chunkUrl, pending);
  }

  async function postChunk(url, bytes) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: bytes
    });
    if (!response.ok) throw new Error(await response.text());
  }

  function concatBytes(left, right) {
    const merged = new Uint8Array(left.length + right.length);
    merged.set(left, 0);
    merged.set(right, left.length);
    return merged;
  }

  async function paginate(url) {
    const items = [];
    let next = url;
    while (next) {
      const response = await fetch(next, {
        credentials: "include",
        headers: { accept: "application/json" }
      });
      if (!response.ok) throw new Error(`Canvas API failed: ${response.status} ${response.statusText} (${next})`);
      const data = await response.json();
      items.push(...(Array.isArray(data) ? data : [data]));
      next = parseNext(response.headers.get("link"));
    }
    return items;
  }

  async function getJson(url) {
    const response = await fetch(url, {
      credentials: "include",
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw new Error(`Canvas API failed: ${response.status} ${response.statusText} (${url})`);
    return response.json();
  }

  async function firstPaginate(urls, label, warnings) {
    const errors = [];
    for (const url of urls) {
      try {
        return await paginate(url);
      } catch (error) {
        errors.push(error.message);
      }
    }
    warnings.push(`Could not capture ${label}: ${errors.join(" | ")}`);
    return [];
  }

  function parseNext(linkHeader) {
    if (!linkHeader) return null;
    const link = linkHeader.split(",").find((part) => part.includes('rel="next"'));
    const match = link?.match(/<([^>]+)>/);
    return match?.[1] || null;
  }

  async function limitMap(values, concurrency, mapper) {
    const results = new Array(values.length);
    let index = 0;
    const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (index < values.length) {
        const current = index++;
        results[current] = await mapper(values[current], current);
      }
    });
    await Promise.all(workers);
    return results;
  }
})();
