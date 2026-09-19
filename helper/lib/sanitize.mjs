export function safeName(value, fallback = "untitled") {
  const cleaned = String(value || "")
    .normalize("NFKD")
    .replace(/[^\w.\- ]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

export function fileSlug(value, fallback = "item") {
  return safeName(value, fallback)
    .replace(/\.+$/g, "")
    .replace(/^\.+/g, "")
    .replace(/\s+/g, "-")
    .toLowerCase() || fallback;
}
