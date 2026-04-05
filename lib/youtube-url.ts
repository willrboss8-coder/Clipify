/**
 * Validate user-supplied URLs for YouTube-only ingestion (no redirects to arbitrary hosts).
 */

const ALLOWED_HOST_SUFFIXES = [
  "youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
  "m.youtube.com",
];

function normalizeHostname(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

export function isAllowedYoutubeUrl(raw: string): boolean {
  const t = raw.trim();
  if (!t) return false;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return false;
  }
  const h = normalizeHostname(u.hostname);
  if (h === "youtu.be") {
    return u.pathname.length > 1;
  }
  return ALLOWED_HOST_SUFFIXES.some(
    (s) => h === s || h.endsWith(`.${s}`)
  );
}

/** Stable string for yt-dlp (trimmed URL). */
export function normalizeYoutubeUrl(raw: string): string {
  return raw.trim();
}
