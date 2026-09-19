import { vttToText } from "./text.mjs";

const KALTURA_API = "https://www.kaltura.com/api_v3";

export async function getKalturaCaptions({ partnerId, entryId, ks }) {
  if (!entryId) return [];
  const assets = await listCaptionAssets({ entryId, ks }).catch(() => []);
  const captions = [];

  for (const asset of assets) {
    const id = asset.id || asset.captionAssetId;
    if (!id) continue;
    const urls = [
      `${KALTURA_API}/service/caption_captionasset/action/serveWebVTT/captionAssetId/${encodeURIComponent(id)}`,
      `${KALTURA_API}/service/caption_captionasset/action/serve/captionAssetId/${encodeURIComponent(id)}`,
      `${KALTURA_API}/service/caption_captionasset/action/serve/id/${encodeURIComponent(id)}`
    ];
    const downloadUrl = await getCaptionUrl({ id, ks }).catch(() => null);
    if (downloadUrl) urls.unshift(downloadUrl);

    for (const url of urls) {
      const text = await fetchCaptionText(url, ks).catch(() => "");
      if (text && text.trim().length > 20) {
        captions.push({
          src: url,
          label: asset.label || asset.language || "Kaltura captions",
          text,
          transcriptText: vttToText(text) || text
        });
        break;
      }
    }
  }

  return captions;
}

async function listCaptionAssets({ entryId, ks }) {
  const body = new URLSearchParams();
  body.set("format", "1");
  body.set("filter:objectType", "KalturaCaptionAssetFilter");
  body.set("filter:entryIdEqual", entryId);
  body.set("filter:entryId", entryId);
  if (ks) body.set("ks", ks);
  const response = await fetch(`${KALTURA_API}/service/caption_captionasset/action/list`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) throw new Error(`Kaltura caption list HTTP ${response.status}`);
  const data = await response.json();
  return data.objects || data.items || [];
}

async function getCaptionUrl({ id, ks }) {
  const body = new URLSearchParams();
  body.set("format", "1");
  body.set("id", id);
  if (ks) body.set("ks", ks);
  const response = await fetch(`${KALTURA_API}/service/caption_captionasset/action/getUrl`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) throw new Error(`Kaltura caption URL HTTP ${response.status}`);
  const value = await response.json();
  return typeof value === "string" ? value : value?.url || null;
}

async function fetchCaptionText(url, ks) {
  const target = new URL(url);
  if (ks && !target.searchParams.has("ks")) target.searchParams.set("ks", ks);
  const response = await fetch(target, {
    headers: { accept: "text/vtt,text/plain,*/*" }
  });
  if (!response.ok) throw new Error(`Kaltura caption fetch HTTP ${response.status}`);
  const text = await response.text();
  if (/^\s*</.test(text) || /SERVICE_FORBIDDEN|INVALID_KS|error/i.test(text.slice(0, 500))) return "";
  return text;
}
