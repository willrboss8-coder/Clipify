/** Structured client-facing code when YouTube blocks automated access. */
export const YOUTUBE_AUTH_REQUIRED_CODE = "YOUTUBE_AUTH_REQUIRED";

export const YOUTUBE_AUTH_FRIENDLY_MESSAGE =
  "This YouTube video could not be accessed automatically right now. Try another link or upload the video file directly.";

export class YoutubeDlpUserError extends Error {
  readonly code: string;

  constructor(
    message: string = YOUTUBE_AUTH_FRIENDLY_MESSAGE,
    code: string = YOUTUBE_AUTH_REQUIRED_CODE
  ) {
    super(message);
    this.name = "YoutubeDlpUserError";
    this.code = code;
  }
}

/**
 * Heuristic: YouTube anti-bot / sign-in walls (stderr from yt-dlp).
 * Match loosely on common English phrases; case-insensitive.
 */
export function isYoutubeDlpAuthLikeFailure(combinedStd: string): boolean {
  const t = combinedStd.toLowerCase();
  if (t.includes("sign in to confirm you're not a bot")) return true;
  if (t.includes("sign in to confirm your age")) return true;
  if (t.includes("please sign in") && t.includes("not a bot")) return true;
  if (t.includes("cookies") && t.includes("authentication")) return true;
  if (t.includes("po_token") && t.includes("cookies")) return true;
  if (t.includes("login required") || t.includes("log in to confirm")) return true;
  return false;
}
