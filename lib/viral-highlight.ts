/**
 * Pick at most one word per caption line to accent (ASS inline color).
 */

const FILLER = new Set(
  [
    "the",
    "a",
    "an",
    "and",
    "or",
    "but",
    "to",
    "of",
    "in",
    "on",
    "at",
    "for",
    "with",
    "as",
    "by",
    "if",
    "is",
    "it",
    "we",
    "i",
    "you",
    "he",
    "she",
    "they",
    "this",
    "that",
    "these",
    "those",
    "my",
    "your",
    "his",
    "her",
    "its",
    "our",
    "their",
    "me",
    "him",
    "us",
    "them",
    "be",
    "am",
    "are",
    "was",
    "were",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "so",
    "very",
    "just",
    "only",
    "also",
    "not",
    "no",
    "yes",
    "can",
    "could",
    "would",
    "should",
    "will",
    "must",
    "about",
    "into",
    "from",
    "than",
    "then",
    "there",
    "here",
    "what",
    "which",
    "who",
    "whom",
    "when",
    "where",
    "why",
    "how",
    "all",
    "any",
    "each",
    "every",
    "some",
    "such",
    "too",
    "up",
    "out",
    "off",
    "over",
    "again",
    "once",
  ].map((w) => w.toLowerCase())
);

/** Prefer emotional / punchy words when scoring ties. */
const EMOTION_OR_ACTION = new Set(
  [
    "love",
    "hate",
    "fear",
    "amazing",
    "insane",
    "crazy",
    "wild",
    "huge",
    "massive",
    "secret",
    "truth",
    "never",
    "always",
    "everything",
    "nothing",
    "money",
    "problem",
    "mistake",
    "win",
    "lose",
    "stop",
    "start",
    "change",
    "break",
    "fix",
    "hack",
    "growth",
    "viral",
    "free",
    "now",
    "today",
    "finally",
    "literally",
    "actually",
    "really",
  ].map((w) => w.toLowerCase())
);

function normalizeToken(w: string): string {
  return w
    .replace(/^['"“”‘’]+|['"“”‘’]+$/g, "")
    .replace(/[.,!?…;:]+$/g, "")
    .toLowerCase();
}

function scoreWord(raw: string): number {
  const n = normalizeToken(raw);
  if (!n || FILLER.has(n)) return -1;
  let s = Math.min(24, n.length * 2);
  if (/\d/.test(raw)) s += 80;
  if (EMOTION_OR_ACTION.has(n)) s += 45;
  if (n.length >= 6) s += 12;
  if (/^[A-Z][a-z]{2,}/.test(raw) && raw !== raw.toUpperCase()) s += 8;
  return s;
}

/**
 * Returns index of word to highlight, or null if nothing should be accented.
 */
export function pickHighlightWordIndex(words: string[]): number | null {
  if (words.length === 0) return null;

  let bestI = -1;
  let bestS = -1;

  for (let i = 0; i < words.length; i++) {
    const s = scoreWord(words[i]!);
    if (s < 0) continue;
    // Tie-break: later word (often the punch noun / verb)
    if (s > bestS || (s === bestS && i > bestI)) {
      bestS = s;
      bestI = i;
    }
  }

  if (bestI < 0) return null;
  return bestI;
}
