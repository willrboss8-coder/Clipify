/**
 * ASS layout constants for viral captions (720×1280 export, visible content column margins).
 * Line length is enforced separately in `lib/viral-chunk.ts` (hard character limit).
 */

/** Full exported TikTok-style frame width (see `lib/ffmpeg.ts` cutClip → 720×1280). */
export const VIDEO_WIDTH_PX = 720;

/**
 * Horizontal fraction of the frame that contains the actual picture (speaker / content),
 * excluding symmetric black bars or padded framing baked into the export.
 */
export const VISIBLE_CONTENT_WIDTH_FRACTION = 0.72;

/** Width of the center content column (pixels), not the full frame. */
export function visibleContentWidthPx(): number {
  return VIDEO_WIDTH_PX * VISIBLE_CONTENT_WIDTH_FRACTION;
}

/**
 * Symmetric ASS MarginL / MarginR from the frame edges to the visible content column.
 */
export function viralAssMarginLRPx(): number {
  const side = (VIDEO_WIDTH_PX - visibleContentWidthPx()) / 2;
  return Math.max(0, Math.round(side));
}
