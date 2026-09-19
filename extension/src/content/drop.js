(() => {
  const SCRIPT_VERSION = "2026-05-03-upload-set-drop-bridge";
  if (window.__bundlrDropVersion === SCRIPT_VERSION) return;
  window.__bundlrDropVersion = SCRIPT_VERSION;

  const HELPER = "http://127.0.0.1:8765";
  const CUSTOM_TYPES = ["application/x-bundlr-upload-set"];
  const TEXT_PREFIXES = ["BUNDLR_UPLOAD_SET:"];
  let syntheticDrop = false;

  document.addEventListener("dragover", (event) => {
    if (!hasBundlrPayload(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
  }, true);

  document.addEventListener("drop", (event) => {
    if (syntheticDrop) return;
    const payload = readPayload(event.dataTransfer);
    if (!payload) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    deliverBundle(event.target, payload).catch((error) => {
      console.error("Bundlr upload failed:", error);
      showBundlrToast(`Bundlr upload failed: ${error.message}`);
    });
  }, true);

  async function deliverBundle(target, payload) {
    showBundlrToast("Bundlr is attaching your context...");
    const response = await fetch(`${HELPER}/api/bin/${encodeURIComponent(payload.binName)}/upload-set`);
    if (!response.ok) throw new Error(await response.text());
    const uploadSet = await response.json();
    const transfer = new DataTransfer();
    for (const item of uploadSet.files || []) {
      const fileResponse = await fetch(`${HELPER}/api/bin/${encodeURIComponent(payload.binName)}/upload-set/file/${encodeURIComponent(item.filename)}`);
      if (!fileResponse.ok) throw new Error(await fileResponse.text());
      const blob = await fileResponse.blob();
      transfer.items.add(new File([blob], item.filename, { type: item.contentType || blob.type || "text/plain" }));
    }
    if (!transfer.files.length) throw new Error("No upload files were generated.");

    if (tryFileInputs(transfer.files)) {
      showBundlrToast(`Attached ${transfer.files.length} Bundlr file(s)`);
      return;
    }

    syntheticDrop = true;
    try {
      const dropTarget = nearestDropTarget(target);
      for (const type of ["dragenter", "dragover", "drop"]) {
        dropTarget.dispatchEvent(new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          dataTransfer: transfer
        }));
      }
      showBundlrToast(`Dropped ${transfer.files.length} Bundlr file(s)`);
    } finally {
      syntheticDrop = false;
    }
  }

  function tryFileInputs(files) {
    const inputs = [...document.querySelectorAll("input[type='file']")]
      .filter((input) => !input.disabled);
    for (const input of inputs) {
      try {
        input.files = files;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      } catch {
        // Try the next input or fall back to synthetic drop.
      }
    }
    return false;
  }

  function hasBundlrPayload(dataTransfer) {
    const types = [...(dataTransfer?.types || [])];
    if (CUSTOM_TYPES.some((type) => types.includes(type))) return true;
    const text = dataTransfer?.getData?.("text/plain") || "";
    return isLikelyAiPage() && TEXT_PREFIXES.some((prefix) => text.startsWith(prefix));
  }

  function readPayload(dataTransfer) {
    for (const type of CUSTOM_TYPES) {
      const custom = dataTransfer.getData(type);
      if (custom) return parsePayload(custom);
    }
    const text = dataTransfer.getData("text/plain") || "";
    const prefix = TEXT_PREFIXES.find((item) => text.startsWith(item));
    if (!prefix) return null;
    return parsePayload(text.slice(prefix.length));
  }

  function parsePayload(value) {
    try {
      return JSON.parse(atob(value));
    } catch {
      return null;
    }
  }

  function nearestDropTarget(target) {
    return target?.closest?.("[contenteditable='true'], textarea, form, main, [role='main']") ||
      document.querySelector("main, [role='main']") ||
      document.body;
  }

  function safeFilename(value) {
    return String(value || "class").replace(/[^a-z0-9]+/gi, "-");
  }

  function isLikelyAiPage() {
    return /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$|(^|\.)gemini\.google\.com$|(^|\.)claude\.ai$|(^|\.)notebooklm\.google\.com$/i.test(location.hostname);
  }

  function showBundlrToast(message) {
    const existing = document.getElementById("bundlr-toast");
    if (existing) existing.remove();
    const toast = document.createElement("div");
    toast.id = "bundlr-toast";
    toast.textContent = message;
    Object.assign(toast.style, {
      position: "fixed",
      right: "18px",
      bottom: "18px",
      zIndex: "2147483647",
      background: "#071f3d",
      color: "#fff",
      font: "700 14px Helvetica, Arial, sans-serif",
      borderRadius: "14px",
      boxShadow: "0 10px 28px rgba(0,0,0,0.24)",
      maxWidth: "320px",
      padding: "12px 14px"
    });
    document.documentElement.appendChild(toast);
    setTimeout(() => toast.remove(), 4500);
  }
})();
