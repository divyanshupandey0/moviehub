/**
 * Generic media URL inspection & filename helpers for Nuvio streams & downloads.
 */

const DIRECT_FILE_EXTENSIONS = /\.(mp4|mkv|webm|mov|avi|m4v)(\?|$|#)/i;
const MANIFEST_EXTENSIONS = /\.(m3u8|mpd)(\?|$|#)/i;
const BLOCKED_SCHEMES = /^(magnet:|torrent:|intent:|android-app:|javascript:|file:|content:|data:)/i;

export function isPlayableHttpUrl(url: string | undefined | null): boolean {
  if (!url || typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed || BLOCKED_SCHEMES.test(trimmed)) return false;
  try {
    const u = new URL(trimmed);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export function detectStreamContainer(
  url: string,
  explicitType?: string,
): "mp4" | "mkv" | "webm" | "m3u8" | "mpd" {
  const t = (explicitType || "").toLowerCase().trim();
  if (t === "m3u8" || t === "hls") return "m3u8";
  if (t === "mpd" || t === "dash") return "mpd";
  if (t === "mkv" || t === "matroska") return "mkv";
  if (t === "webm") return "webm";
  if (t === "mp4") return "mp4";

  const lower = url.toLowerCase();
  if (lower.includes(".m3u8") || lower.includes("/hls/")) return "m3u8";
  if (lower.includes(".mpd") || lower.includes("/dash/")) return "mpd";
  if (lower.includes(".mkv")) return "mkv";
  if (lower.includes(".webm")) return "webm";
  return "mp4";
}

/**
 * Only direct downloadable media files (progressive MP4/MKV/WEBM/MOV) can be
 * downloaded by Android's native file download service without HLS/DASH muxing.
 */
export function isDirectDownloadableUrl(
  url: string,
  explicitType?: string,
  supportsExternalPlayer?: boolean,
): boolean {
  if (!isPlayableHttpUrl(url)) return false;
  if (supportsExternalPlayer === false) return false;
  const container = detectStreamContainer(url, explicitType);
  if (container === "m3u8" || container === "mpd") return false;
  if (MANIFEST_EXTENSIONS.test(url)) return false;
  return (
    DIRECT_FILE_EXTENSIONS.test(url) ||
    container === "mp4" ||
    container === "mkv" ||
    container === "webm"
  );
}

export function extractFilenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean).pop();
    if (seg && seg.length > 2) return decodeURIComponent(seg);
  } catch {}
  return "video.mp4";
}
