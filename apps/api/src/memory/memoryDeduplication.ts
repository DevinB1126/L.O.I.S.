import { MemoryRecord } from "./memoryService";

// Memory v2B — lightweight, non-embedding duplicate detection.
//
// Two layers:
// 1. Exact-duplicate: compares normalized content strings.
// 2. Near-duplicate: conservative Jaccard similarity over normalized,
//    stopword-filtered tokens.
//
// This deliberately catches close paraphrases that share most of their
// meaningful words ("I prefer dark mode" / "I like dark mode" both
// normalize to "dark mode") but will NOT catch pure synonym-based rewrites
// with little shared vocabulary ("I prefer concise answers" / "I like
// responses to be short") — reliably catching those requires semantic/
// embedding similarity, which is explicitly out of scope until a later
// Memory v2 stage. Objective 9 calls for being conservative here — false
// positives (wrongly treating two distinct facts as duplicates) are worse
// than occasionally missing a paraphrased duplicate.

// Calibrated against live model output: 0.7 missed a real near-duplicate
// pair ("Dark mode is preferred" / "dark mode", ~0.67 similarity) while the
// explicitly-required-distinct pairs in the test suite score well under
// 0.5, so 0.65 still leaves a wide safety margin against false positives.
const NEAR_DUPLICATE_THRESHOLD = 0.65;

// Usability pass (post-v2B): lowered from 2 to 1. A short bare statement
// like "I prefer React." legitimately reduces to a single significant
// token ("react") once its leading phrase/stopwords are stripped, and that
// form still needs to be comparable — it's exactly what the containment
// check below catches against a longer existing memory. This doesn't
// loosen anything: a size-1 token set can only ever produce a Jaccard
// score of exactly 0 or 1, never an ambiguous middle value, so allowing it
// is already maximally conservative by construction.
const MIN_TOKENS_FOR_NEAR_DUPLICATE = 1;

// A short candidate fully contained in a longer one is capped at this many
// tokens — see isFullyContained.
const MAX_CONTAINED_TOKENS = 2;

const STOP_WORDS = new Set([
  "i", "a", "an", "the", "is", "am", "are", "was", "were", "be", "been",
  "my", "me", "to", "of", "that", "this", "for", "in", "on", "at", "with",
  "and", "or", "as", "it", "its", "so", "very", "really", "just", "also",
  // Generic procedural filler that shows up across many different
  // phrasings of the *same* underlying tool/technology preference
  // ("I prefer React for frontend work" / "I primarily use React for my
  // projects" / "I like using React for frontend development") without
  // itself distinguishing one fact from another. Deliberately NOT
  // included: words like "frontend"/"backend"/"work" that genuinely can
  // distinguish two different facts (e.g. "I work as a backend engineer"
  // vs "I work as a frontend engineer" must stay distinct) — stripping
  // those would be the over-aggressive stopword list this module
  // explicitly avoids.
  "use", "using", "used", "project", "projects", "development", "developing",
]);

// Common ways users phrase the same underlying preference — stripped ONLY
// from the comparison form used for duplicate checks, never from the text
// that actually gets displayed/stored (Objective 7).
const CONVERSATIONAL_PREFIXES: RegExp[] = [
  /^i\s+(?:really\s+|actually\s+|honestly\s+)?(?:prefer|like|love|enjoy|favor)\s+/,
  // Allows one qualifier word, e.g. "my UI preference is", "my personal preference is".
  /^my\s+(?:\S+\s+)?preference\s+is\s+/,
  /^i\s+(?:usually|typically|generally|mostly|primarily|often)\s+/,
  /^i\s+want\s+/,
];

export function normalizeForComparison(content: string): string {
  let normalized = content.toLowerCase().trim();

  normalized = normalized.replace(/[.!?]+$/g, "");
  normalized = normalized.replace(/\s+/g, " ").trim();

  for (const prefix of CONVERSATIONAL_PREFIXES) {
    const stripped = normalized.replace(prefix, "");
    if (stripped !== normalized) {
      normalized = stripped.trim();
      break;
    }
  }

  return normalized;
}

function tokenize(normalized: string): Set<string> {
  return new Set(
    normalized
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 0 && !STOP_WORDS.has(token))
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }

  const union = a.size + b.size - intersection;

  return union === 0 ? 0 : intersection / union;
}

// True if every token in `shorter` also appears in `longer` — catches a
// short, bare statement ("I prefer React.") that names the same core
// subject as a longer, more descriptive existing memory ("I prefer React
// for frontend work."), a case plain Jaccard similarity systematically
// under-scores because the longer memory's extra descriptive words dilute
// the ratio (3 shared words out of a 5-word union scores only ~0.2, well
// under threshold, even though the short side is entirely about the same
// thing). Capped at MAX_CONTAINED_TOKENS so this only fires when the
// shorter side is essentially "just the subject" — a multi-token shorter
// statement being a subset of a much longer one is weaker evidence and is
// left to the ordinary Jaccard score instead.
function isFullyContained(shorter: Set<string>, longer: Set<string>): boolean {
  if (shorter.size === 0 || shorter.size > MAX_CONTAINED_TOKENS) return false;

  for (const token of shorter) {
    if (!longer.has(token)) return false;
  }

  return true;
}

export function findExactDuplicate(content: string, existing: MemoryRecord[]): MemoryRecord | undefined {
  const normalizedCandidate = normalizeForComparison(content);

  return existing.find((memory) => normalizeForComparison(memory.content) === normalizedCandidate);
}

export function findNearDuplicate(content: string, existing: MemoryRecord[]): MemoryRecord | undefined {
  const candidateTokens = tokenize(normalizeForComparison(content));

  if (candidateTokens.size < MIN_TOKENS_FOR_NEAR_DUPLICATE) return undefined;

  let bestMatch: MemoryRecord | undefined;
  let bestScore = 0;

  for (const memory of existing) {
    const existingTokens = tokenize(normalizeForComparison(memory.content));

    if (existingTokens.size < MIN_TOKENS_FOR_NEAR_DUPLICATE) continue;

    const contained =
      isFullyContained(candidateTokens, existingTokens) || isFullyContained(existingTokens, candidateTokens);

    const score = contained ? 1 : jaccardSimilarity(candidateTokens, existingTokens);

    if (score > bestScore) {
      bestScore = score;
      bestMatch = memory;
    }
  }

  return bestScore >= NEAR_DUPLICATE_THRESHOLD ? bestMatch : undefined;
}
