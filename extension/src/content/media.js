(() => {
  const SCRIPT_VERSION = "2026-05-04-ethn-canvas-lectures";
  if (window.__canvasContextBinMediaVersion === SCRIPT_VERSION) return;
  window.__canvasContextBinMediaVersion = SCRIPT_VERSION;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "CAPTURE_MEDIA_PAGE_V2") {
      captureMediaPage()
        .then((payload) => sendResponse({ ok: true, ...payload }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === "CAPTURE_ALL_LECTURES_V1") {
      captureAllLecturePages()
        .then((payload) => sendResponse({ ok: true, ...payload }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    return false;
  });

  async function captureMediaPage() {
    const mediaElements = [...document.querySelectorAll("video, audio")];
    const anchorMedia = [...document.querySelectorAll("a[href]")]
      .map((anchor) => anchor.href)
      .filter(isMediaLikeUrl);
    const resourceMedia = performance.getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter(isMediaLikeUrl);
    const pageUrls = extractMediaUrlsFromText(document.documentElement.outerHTML);
    const kalturaItems = extractKalturaItems(document.documentElement.outerHTML, location.href, currentPageTitle());
    const frameUrls = [...document.querySelectorAll("iframe[src]")]
      .map((frame) => frame.src)
      .filter(Boolean);

    const media = [];
    for (const element of mediaElements) {
      const sources = [
        element.currentSrc,
        element.src,
        ...[...element.querySelectorAll("source[src]")].map((source) => source.src)
      ].filter(Boolean);
      const captions = await Promise.all(
        [...element.querySelectorAll("track[kind='captions'], track[kind='subtitles'], track[src]")]
          .map((track) => readTrack(track))
      );
      media.push({
        kind: element.tagName.toLowerCase(),
        title: mediaTitle(element),
        sources: unique(sources),
        captions: captions.filter(Boolean),
        duration: Number.isFinite(element.duration) ? element.duration : null,
        poster: element.poster || null
      });
    }

    for (const href of unique(anchorMedia)) {
      media.push(await mediaFromUrl(href, "link"));
    }

    for (const href of unique([...resourceMedia, ...pageUrls])) {
      media.push(await mediaFromUrl(href, "page-scan"));
    }

    media.push(...kalturaItems);

    for (const frameUrl of frameUrls.slice(0, 8)) {
      const frameMedia = await scanFrameUrl(frameUrl);
      media.push(...frameMedia);
    }

    return {
      page: {
        title: document.title,
        url: location.href,
        capturedAt: new Date().toISOString()
      },
      media: dedupeMedia(media).filter((item) => item.sources.length || item.captions.length)
    };
  }

  async function captureAllLecturePages() {
    const links = collectLectureLinks();
    const pages = [];
    const media = [];
    for (let index = 0; index < links.length; index += 1) {
      const link = links[index];
      if (isYouTubeUrl(link.url)) {
        const title = link.label || `Lecture ${index + 1}`;
        pages.push({
          title,
          url: link.url,
          capturedAt: new Date().toISOString(),
          index: index + 1,
          label: link.label
        });
        media.push(youtubeMediaItem(link.url, title, link, index + 1));
        continue;
      }

      let html = "";
      try {
        html = link.url === location.href ? document.documentElement.outerHTML : await fetchText(link.url);
      } catch (error) {
        pages.push({
          title: link.label || `Lecture ${index + 1}`,
          url: link.url,
          capturedAt: new Date().toISOString(),
          index: index + 1,
          label: link.label,
          error: error.message
        });
        continue;
      }
      const title = titleFromHtml(html) || link.label || `Lecture ${index + 1}`;
      const page = {
        title,
        url: link.url,
        capturedAt: new Date().toISOString(),
        index: index + 1,
        label: link.label
      };
      pages.push(page);
      const pageMedia = await scanHtmlForMedia(html, link.url, title);
      for (const item of pageMedia) {
        media.push({
          ...item,
          title: titleWithLabel(title, link.label),
          pageTitle: title,
          pageUrl: link.url,
          lectureIndex: index + 1,
          lectureLabel: link.label
        });
      }
    }

    return {
      page: {
        title: currentPageTitle(),
        url: location.href,
        capturedAt: new Date().toISOString(),
        lectureCount: pages.length
      },
      pages,
      media: dedupeMedia(media).filter((item) => item.sources.length || item.captions.length)
    };
  }

  function collectLectureLinks() {
    const anchors = [...document.querySelectorAll("a[href]")];
    const rawLinks = anchors
      .map((anchor) => {
        try {
          const url = new URL(anchor.href, location.href);
          return {
            url: url.href,
            label: anchor.textContent?.replace(/\s+/g, " ").trim() || url.pathname.split("/").pop() || "Lecture",
            context: anchor.closest("li, tr, .ig-row, .context_module_item, .item-group-condensed, .module-item, .assignment, .discussion, .page")?.textContent?.replace(/\s+/g, " ").trim() || ""
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter((link) => isLectureLink(link));

    const current = {
      url: location.href,
      label: document.querySelector(".LectureList a[aria-current='page'], .LectureList a.active")?.textContent?.trim() ||
        document.querySelector("h2, h1")?.textContent?.replace(/\s+/g, " ").trim() ||
        "Current lecture"
    };

    const byUrl = new Map();
    for (const link of [...rawLinks, current]) {
      const normalized = stripHash(link.url);
      if (!byUrl.has(normalized)) byUrl.set(normalized, { ...link, url: normalized });
    }
    return [...byUrl.values()].slice(0, 60);
  }

  async function scanHtmlForMedia(html, baseUrl, fallbackTitle) {
    const media = [];
    media.push(...extractKalturaItems(html, baseUrl, fallbackTitle));
    for (const url of unique(extractMediaUrlsFromText(html, baseUrl))) {
      media.push(await mediaFromUrl(url, "page-scan", fallbackTitle));
    }
    for (const frameUrl of extractFrameUrlsFromText(html, baseUrl).slice(0, 8)) {
      if (isYouTubeUrl(frameUrl)) {
        media.push(youtubeMediaItem(frameUrl, fallbackTitle));
        continue;
      }
      const frameMedia = await scanFrameUrl(frameUrl, fallbackTitle);
      media.push(...frameMedia);
    }
    return media;
  }

  function mediaTitle(element) {
    return element.getAttribute("title") ||
      element.getAttribute("aria-label") ||
      currentPageTitle() ||
      "Lecture media";
  }

  async function readTrack(track) {
    const src = track.src;
    if (!src) return null;
    return {
      kind: track.kind,
      label: track.label || "",
      srclang: track.srclang || "",
      src,
      text: await fetchText(src).catch(() => null)
    };
  }

  async function fetchText(url) {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  }

  async function mediaFromUrl(href, kind, titleHint = "") {
    const isCaption = /\.(vtt|srt)(\?|#|$)/i.test(href) || /caption|transcript|subtitle/i.test(href);
    return {
      kind,
      title: titleHint || href.split("/").pop()?.split("?")[0] || `${kind} media`,
      sources: isCaption ? [] : [href],
      captions: isCaption ? [{ src: href, text: await fetchText(href).catch(() => null) }] : await discoverSiblingCaptions(href),
      duration: null,
      poster: null
    };
  }

  async function discoverSiblingCaptions(mediaUrl) {
    const candidates = [
      mediaUrl.replace(/\/index\.m3u8(\?.*)?$/i, "/subtitles.vtt"),
      mediaUrl.replace(/\/index\.m3u8(\?.*)?$/i, "/captions.vtt"),
      mediaUrl.replace(/\.(mp4|m4v|mov|m3u8)(\?.*)?$/i, ".vtt"),
      mediaUrl.replace(/\.(mp4|m4v|mov|m3u8)(\?.*)?$/i, ".srt")
    ];
    const captions = [];
    for (const candidate of unique(candidates)) {
      const text = await fetchText(candidate).catch(() => null);
      if (text && text.length > 20) captions.push({ src: candidate, text });
    }
    return captions;
  }

  async function scanFrameUrl(frameUrl, fallbackTitle = "Lecture media", depth = 0) {
    if (isYouTubeUrl(frameUrl)) return [youtubeMediaItem(frameUrl, fallbackTitle)];
    try {
      const response = await fetch(frameUrl, { credentials: "include" });
      if (!response.ok) return [];
      const text = await response.text();
      const media = [];
      media.push(...extractKalturaItems(text, frameUrl, fallbackTitle));
      const urls = extractMediaUrlsFromText(text, frameUrl);
      media.push(...await Promise.all(unique(urls).map((url) => mediaFromUrl(url, "iframe-scan", fallbackTitle))));
      if (depth < 1) {
        for (const nestedFrameUrl of extractFrameUrlsFromText(text, frameUrl).slice(0, 4)) {
          media.push(...await scanFrameUrl(nestedFrameUrl, fallbackTitle, depth + 1));
        }
      }
      return media;
    } catch {
      return [];
    }
  }

  function extractMediaUrlsFromText(text, base = location.href) {
    const urls = [];
    const decoded = decodeHtml(text);
    const patterns = [
      /https?:\/\/[^"'<>\s)]+(?:index\.m3u8|\.m3u8|\.mp4|\.m4v|\.mov|\.mp3|\.m4a|\.wav|\.webm|\.vtt|\.srt)(?:\?[^"'<>\s)]*)?/gi,
      /["']([^"']+(?:index\.m3u8|\.m3u8|\.mp4|\.m4v|\.mov|\.mp3|\.m4a|\.wav|\.webm|\.vtt|\.srt)(?:\?[^"']*)?)["']/gi
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(decoded))) {
        const raw = match[1] || match[0];
        try {
          urls.push(new URL(raw, base).href);
        } catch {
          // Ignore malformed script fragments.
        }
      }
    }
    return urls.filter(isMediaLikeUrl);
  }

  function extractFrameUrlsFromText(text, base = location.href) {
    const urls = [];
    try {
      const doc = new DOMParser().parseFromString(text, "text/html");
      for (const frame of [...doc.querySelectorAll("iframe[src], frame[src], embed[src]")]) {
        const src = frame.getAttribute("src");
        if (!src || /^(about:|javascript:)/i.test(src)) continue;
        urls.push(new URL(src, base).href);
      }
      for (const link of [...doc.querySelectorAll("a[href]")]) {
        const href = link.getAttribute("href") || "";
        const label = link.textContent?.replace(/\s+/g, " ").trim() || "";
        if (!isLectureLink({ url: new URL(href, base).href, label, context: "" })) continue;
        urls.push(new URL(href, base).href);
      }
    } catch {
      const pattern = /<(?:iframe|frame|embed)\b[^>]*\bsrc=["']([^"']+)["']/gi;
      let match;
      while ((match = pattern.exec(text))) {
        try {
          urls.push(new URL(match[1], base).href);
        } catch {
          // Ignore malformed frame sources.
        }
      }
    }
    return unique(urls);
  }

  function extractKalturaItems(html, baseUrl = location.href, fallbackTitle = currentPageTitle()) {
    const entryId = firstMatch(html, /['"]entry_id['"]\s*:\s*['"]([^'"]+)['"]/i) ||
      firstMatch(html, /entryId["']?\s*[:=]\s*["']([^"']+)["']/i);
    const wid = firstMatch(html, /['"]wid['"]\s*:\s*['"]_?(\d+)['"]/i);
    const partnerId = wid || firstMatch(html, /\/p\/(\d+)\//i) || "2323111";
    const ks = firstMatch(html, /['"]ks['"]\s*:\s*['"]([^'"]+)['"]/i);
    const fileBase = firstMatch(html, /fileBase\s*:\s*['"]([^'"]+)['"]/i);
    if (!entryId && !fileBase) return [];

    const sources = [];
    if (entryId) {
      const base = `https://cdnapisec.kaltura.com/p/${partnerId}/sp/${partnerId}00/playManifest/entryId/${entryId}`;
      const ksQuery = ks ? `?ks=${encodeURIComponent(ks)}` : "";
      sources.push(`${base}/format/applehttp/protocol/https/a.m3u8${ksQuery}`);
      sources.push(`${base}/format/url/protocol/https/video.mp4${ksQuery}`);
      sources.push(`${base}/format/download/protocol/https/video.mp4${ksQuery}`);
    }
    if (fileBase) {
      const origin = new URL(baseUrl).origin;
      sources.push(new URL(`/media/${fileBase}`, origin).href);
      sources.push(new URL(`/${fileBase}`, origin).href);
    }

    return [{
      kind: "kaltura",
      title: fallbackTitle || "Kaltura lecture",
      sources: unique(sources),
      captions: [],
      duration: null,
      poster: null,
      kaltura: entryId ? { partnerId, entryId, ks } : null
    }];
  }

  function firstMatch(text, pattern) {
    return text.match(pattern)?.[1] || null;
  }

  function titleFromHtml(html) {
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const courseTitle = doc.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim();
      const lectureTitle = doc.querySelector("h2, #lecture_Panel h3")?.textContent?.replace(/\s+/g, " ").trim();
      const pageTitle = doc.querySelector("title")?.textContent?.replace(/\s+/g, " ").trim();
      return [courseTitle, lectureTitle].filter(Boolean).join(" - ") || courseTitle || lectureTitle || pageTitle;
    } catch {
      return null;
    }
  }

  function currentPageTitle() {
    return document.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim() ||
      document.title ||
      "Lecture page";
  }

  function titleWithLabel(title, label) {
    if (!label || title.includes(label)) return title;
    return `${title} (${label})`;
  }

  function stripHash(url) {
    const parsed = new URL(url, location.href);
    parsed.hash = "";
    return parsed.href;
  }

  function isLectureLink(link) {
    let parsed;
    try {
      parsed = new URL(link.url, location.href);
    } catch {
      return false;
    }
    const sameOrigin = parsed.origin === location.origin;
    const text = `${link.label || ""} ${link.context || ""} ${parsed.pathname}`.toLowerCase();
    if (isYouTubeUrl(parsed.href) && /\b(lecture|video|recording|watch|course mechanics|course approach)\b/i.test(text)) return true;
    if (/\/watch\//i.test(parsed.pathname)) return true;
    if (isMediaLikeUrl(parsed.href)) return true;
    if (/media_objects|kaltura|panopto|podcast|zoom|recording|lecture|video/i.test(parsed.href)) return true;
    if (!sameOrigin && !/podcast|kaltura|panopto|zoom|media/i.test(parsed.hostname)) return false;
    if (!/\b(lecture|video|recording|podcast|class capture|course capture|media|zoom|kaltura|watch)\b/i.test(text)) return false;
    if (/\/courses\/\d+\/(?:modules\/items\/\d+|pages\/[^?#]+|external_tools\/\d+|files\/\d+|assignments\/\d+)/i.test(parsed.pathname)) return true;
    if (/\/courses\/\d+/i.test(parsed.pathname) && /\blecture\b/i.test(text)) return true;
    return false;
  }

  function youtubeMediaItem(url, title = "YouTube lecture", link = {}, lectureIndex = null) {
    return {
      kind: "youtube",
      title: titleWithLabel(title, link.label),
      sources: [url],
      captions: [],
      duration: null,
      poster: null,
      pageUrl: url,
      lectureIndex,
      lectureLabel: link.label,
      youtube: {
        videoId: youtubeVideoId(url)
      }
    };
  }

  function isYouTubeUrl(value = "") {
    try {
      const parsed = new URL(value, location.href);
      return /(^|\.)youtube\.com$/i.test(parsed.hostname) || /^youtu\.be$/i.test(parsed.hostname);
    } catch {
      return false;
    }
  }

  function youtubeVideoId(value = "") {
    try {
      const parsed = new URL(value, location.href);
      if (/^youtu\.be$/i.test(parsed.hostname)) return parsed.pathname.split("/").filter(Boolean)[0] || null;
      if (parsed.searchParams.get("v")) return parsed.searchParams.get("v");
      const match = parsed.pathname.match(/\/(?:embed|shorts|watch)\/([^/?#]+)/i);
      return match?.[1] || null;
    } catch {
      return null;
    }
  }

  function isMediaLikeUrl(href) {
    return /\.(mp4|m4v|mov|m3u8|mp3|m4a|wav|webm|vtt|srt)(\?|#|$)/i.test(href) ||
      /index\.m3u8/i.test(href) ||
      /caption|transcript|subtitle/i.test(href);
  }

  function decodeHtml(text) {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = text;
    return textarea.value;
  }

  function dedupeMedia(items) {
    const seen = new Set();
    const output = [];
    for (const item of items) {
      const key = [...(item.sources || []), ...(item.captions || []).map((caption) => caption.src)].join("|") || item.title;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(item);
    }
    return output;
  }

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }
})();
