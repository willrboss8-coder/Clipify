/**
 * Light cleanup so captions read cleaner than raw ASR without changing meaning.
 */

/** Whole-line cleanup for SRT / segment text before word-splitting. */
export function cleanTranscriptLineForCaptions(text: string): string {
  let t = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, " ").trim();
  if (!t) return "";

  t = t.replace(/\s+/g, " ");

  // Standalone filler tokens (conservative — avoid stripping meaningful "like" verbs)
  t = t.replace(/\b(uh|um|uhh|umm)\b/gi, " ");
  t = t.replace(/\b(you know)\b/gi, " ");
  t = t.replace(/\b(sort of|kind of)\b/gi, " ");

  // Tidy spacing around punctuation
  t = t.replace(/\s+([.,!?…;:])/g, "$1");
  t = t.replace(/([.,!?…])\s*([.,!?…])/g, "$1");
  t = t.replace(/\s+/g, " ").trim();

  return t;
}

/**
 * Per-word cleanup for timed-word pipeline. Returns null to drop obvious filler tokens.
 */
export function cleanTimedWordToken(word: string): string | null {
  const t = word.trim();
  if (!t) return null;

  const bare = t.replace(/^['"“”‘’]+|['"“”‘’.,!?…;:]+$/g, "").toLowerCase();
  if (/^(uh|um|uhh|umm)\.?$/i.test(bare)) return null;

  return t;
}
