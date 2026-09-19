const entities = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", "\""],
  ["apos", "'"],
  ["nbsp", " "]
]);

export function htmlToText(html = "") {
  return cleanCanvasText(String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#?\w+);/g, (_match, entity) => decodeEntity(entity))
  );
}

export function vttToText(vtt = "") {
  return cleanCanvasText(String(vtt)
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.includes("-->") && !/^WEBVTT/i.test(line) && !/^\d+$/.test(line.trim()))
    .join("\n")
    .replace(/<[^>]+>/g, ""));
}

export function cleanCanvasText(text = "") {
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
  const cleanedLines = [];
  for (const rawLine of String(text)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      if (cleanedLines.at(-1) !== "") cleanedLines.push("");
      continue;
    }
    if (exactNoise.has(line)) continue;
    if (patternNoise.some((pattern) => pattern.test(line))) continue;
    const count = seen.get(line) || 0;
    seen.set(line, count + 1);
    if (line.length < 120 && count >= 1) continue;
    cleanedLines.push(line);
  }

  return cleanedLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntity(entity) {
  if (entity.startsWith("#x")) return String.fromCodePoint(parseInt(entity.slice(2), 16));
  if (entity.startsWith("#")) return String.fromCodePoint(parseInt(entity.slice(1), 10));
  return entities.get(entity) || `&${entity};`;
}
