import type { MemoryCategory, MemoryRecord } from "./memoryService";
import { cosineSimilarity } from "./semanticSimilarity";
import { embedText, EmbeddingRequestError, EmbeddingResponseError } from "../providers/embeddingProvider";
import { isEmbeddingStale } from "./embeddingStaleness";
import type { RequestTimer } from "../perf/requestTimer";
import { scheduleOllamaTask, OllamaPriority } from "../perf/ollamaScheduler";

// Memory v2C/v2E — hybrid deterministic + semantic relevance retrieval.
//
// Given the current user message and the full memory store, this module
// scores, ranks, floors, and budgets memories down to the small handful
// that are actually worth injecting into the agent prompt.
//
// v2C was purely lexical (Jaccard token overlap + a small category boost).
// v2E adds ONE additional signal — cosine similarity between a single
// query embedding and each memory's persisted embedding — combined with
// the lexical score, never replacing it (see the module-level rule this
// task was built under: "do NOT replace the existing deterministic v2C
// retriever"). Concretely, that means:
//   - Eligibility (whether a memory is a candidate at all) is an OR of two
//     independent floors: clears the lexical floor, OR clears the
//     semantic floor. Neither can be satisfied by the other's absence —
//     a memory with zero lexical overlap AND zero/missing embedding still
//     correctly gets excluded (Objective 9).
//   - If the query embedding itself can't be generated (Ollama down, model
//     missing, timeout, malformed response), semantic scoring is skipped
//     entirely for this call and retrieval degrades to exactly v2C's
//     original lexical-only behavior (Objective 12) — logged once, not
//     thrown.
//   - A memory that individually lacks a (current) embedding just scores
//     0 on the semantic component for this query; it's never penalized
//     beyond that, and can still be selected on lexical grounds alone.
//
// Responsibilities kept deliberately separate from the rest of Memory v2:
//   memoryExtractor      — decides what might be worth remembering (v2B)
//   memoryDeduplication  — decides whether a new candidate already exists (v2B)
//   memoryEmbeddings      — decides WHEN a memory's embedding gets (re)computed (v2E)
//   memoryService         — validates and persists memories
//   memoryRetriever (here) — decides which *existing* memories are relevant
//                            to *this* message, using whichever signals
//                            (lexical, semantic) are actually available
//
// memoryDeduplication.ts already has its own small tokenizer for comparing
// two memory candidates against each other. This module intentionally does
// NOT share it: retrieval compares an arbitrary (often question-shaped)
// query against memory content, which is a different job with a different
// stopword/normalization shape than "are these two stated facts the same
// fact" — reusing it would couple two independent concerns for a ~15-line
// saving. The duplication is small and deliberate.

// ============================================================
// Configuration — every tunable value lives here, nowhere else.
// ============================================================

export const RETRIEVAL_CONFIG = {
  /** Upper bound on how many memories can be injected into one prompt. */
  MAX_RETRIEVED_MEMORIES: 6,
  /** Upper bound on the combined character length of injected memory lines. */
  MAX_MEMORY_CONTEXT_CHARS: 1200,
  /** A memory's lexical relevance (0-1, before importance/recency) clearing
   *  THIS floor is one of the two independent ways a memory can become a
   *  candidate at all (the other is MIN_SEMANTIC_SCORE below) — importance/
   *  recency/pinned can never pull an off-topic memory back in on their
   *  own. Unchanged from v2C. Calibrated against that stage's test
   *  scenarios: genuine single-keyword matches on a short memory score
   *  ~0.15-0.35 after category boost; unrelated pairs score 0. */
  MIN_RELEVANCE_SCORE: 0.08,
  /** The semantic-path floor (Objective 9): cosine similarity from
   *  nomic-embed-text, calibrated against this task's own manual test set
   *  (real Ollama calls, not the hand-built vectors memoryRetriever.test.ts
   *  uses for offline determinism — see the report for the calibration
   *  script). Measured scores:
   *    RELATED   — React paraphrase 0.60, TypeScript paraphrase 0.71,
   *                concise-explanations paraphrase 0.80, video-games/
   *                "recommend something to play" 0.62, LOIS/"improve my
   *                AI system" 0.69, exact lexical "React"/"I prefer
   *                React." 0.85. Range: 0.56-0.85.
   *    UNRELATED — every memory above vs "What is the capital of France?"
   *                0.26-0.36; a same-category-but-different-fact pair
   *                (React memory vs "What editor do I use?") 0.54 — the
   *                closest false-positive risk found.
   *  0.56 sits just above that 0.54 near-miss and just below the weakest
   *  genuine match (0.56), which is a real memory-vs-loosely-worded-query
   *  pair, not a required scenario — every REQUIRED example above clears
   *  0.56 with real margin (weakest is 0.62). Deliberately conservative
   *  per Objective 8/9: a few borderline true positives may be missed
   *  before a topic-adjacent-but-wrong memory gets pulled in. */
  MIN_SEMANTIC_SCORE: 0.56,
  /** Second-stage safety net on the final BLENDED score, after weighting —
   *  catches the case where a candidate barely clears one floor but the
   *  combined signal is still weak overall. Set low relative to the
   *  individual floors on purpose: it's a backstop, not the primary gate. */
  MIN_COMBINED_SCORE: 0.12,
  /** score = LEXICAL_WEIGHT*lexical + SEMANTIC_WEIGHT*semantic +
   *  IMPORTANCE_WEIGHT*importance + RECENCY_WEIGHT*recency + pinnedBoost.
   *  Semantic and lexical are weighted EQUALLY on purpose (Objective 8:
   *  "semantic relevance should be important, but exact lexical matches
   *  should still matter" — conservative middle ground, neither signal
   *  dominates the other). importance/recency together still make up the
   *  remaining 0.30, same total non-relevance budget v2C used (0.25+0.10=
   *  0.35 before; 0.20+0.10=0.30 now, the 0.05 difference absorbed into
   *  splitting what was a single 0.65 "relevance" weight into two 0.35s). */
  LEXICAL_WEIGHT: 0.35,
  SEMANTIC_WEIGHT: 0.35,
  IMPORTANCE_WEIGHT: 0.2,
  RECENCY_WEIGHT: 0.1,
  /** Recency decays with this half-life, but never below RECENCY_FLOOR — an
   *  old memory stays useful, it just stops getting a freshness bonus. */
  RECENCY_HALF_LIFE_DAYS: 30,
  RECENCY_FLOOR: 0.3,
  /** Small, additive nudge (not multiplicative) when the query's topic
   *  matches a memory's category — Objective 14 explicitly asks for this to
   *  stay minor relative to lexical relevance. */
  CATEGORY_BOOST: 0.08,
  /** Memory v2D — small, additive nudge for a pinned memory's RANKING among
   *  candidates that already cleared a relevance floor (lexical OR
   *  semantic) on their own. Applied to `final` only, never to either
   *  floor check, so a pinned-but-unrelated memory can never clear
   *  eligibility on pinned status alone (Objective 9 — same rule v2D
   *  established, now re-verified against the semantic path too). */
  PINNED_BOOST: 0.05,
  /** Projects v1A (Objective 9) — "relevant project memories may receive a
   *  modest contextual boost over equally relevant global memories." Same
   *  posture as PINNED_BOOST: applied to `final` only, AFTER a memory has
   *  already cleared a relevance floor on its own — a project memory can
   *  never become eligible on scope alone, and scope never bypasses
   *  relevance (Objective 9's own wording). */
  PROJECT_BOOST: 0.05,
} as const;

// ============================================================
// Types
// ============================================================

export type MemoryScoreBreakdown = {
  lexical: number;
  semantic: number;
  importance: number;
  recency: number;
  categoryBoost: number;
  pinnedBoost: number;
  projectBoost: number;
  final: number;
};

export type ScoredMemory = {
  memory: MemoryRecord;
  score: MemoryScoreBreakdown;
  selected: boolean;
};

export interface RetrieveRelevantMemoriesOptions {
  message: string;
  memories: MemoryRecord[];
  maxMemories?: number;
  maxCharacters?: number;
  /** Overridable for deterministic tests; defaults to the real current time. */
  now?: Date;
  /** Test-only escape hatch: inject a precomputed query vector instead of
   *  calling the real embedding provider, so the hybrid-scoring tests can
   *  be deterministic and offline. Production callers never pass this. */
  __queryVectorForTesting?: number[] | null;
  /** Performance Pass v1 (Phase 1) — optional per-request timer. Marks
   *  "embeddingQuery" right after the query embedding call resolves (or is
   *  skipped) and "memoryRetrieval" after local scoring/ranking finishes,
   *  so the two genuinely distinct costs (one network round-trip to
   *  Ollama vs. purely local vector math) are never conflated into one
   *  number. Never required — retrieval works identically without it. */
  timer?: RequestTimer;
}

export interface MemoryRetrievalResult {
  /** The memories chosen for prompt injection, highest-ranked first. */
  selected: MemoryRecord[];
  /** Every candidate that cleared a relevance floor, scored, ranked, and
   *  flagged with whether it was ultimately selected (kept for debug/log
   *  use — never sent to the frontend or the model). */
  scored: ScoredMemory[];
  /** Whether a query embedding was actually available for this call — false
   *  when the message was empty, or embedding generation failed and
   *  retrieval fell back to lexical-only (Objective 12). Exposed for tests
   *  and debug logging, not for the prompt itself. */
  semanticAvailable: boolean;
}

// ============================================================
// Projects v1A — scope-based candidate pool filtering (Objective 8/9)
// ============================================================

// Narrows the CANDIDATE POOL before any scoring happens — this is a hard
// eligibility boundary, not part of the relevance model. `currentProjectId`
// is the active project's id, or null for global/unassigned chat.
//   - A global memory (scope: "global") is always in the pool, everywhere.
//   - A project memory (scope: "project") is in the pool ONLY when its own
//     projectId matches currentProjectId — never a different project's
//     memory, and never (when currentProjectId is null, i.e. global chat)
//     any project memory at all.
// Once a memory passes this filter, ordinary v2C/v2E relevance scoring
// (including the modest PROJECT_BOOST above) still fully applies — this
// function never decides what gets INJECTED into a prompt, only what's
// allowed to be a candidate at all (Objective 9: "Project scope narrows
// the candidate pool. It does not bypass relevance.").
export function filterMemoriesByScope(memories: MemoryRecord[], currentProjectId: string | null): MemoryRecord[] {
  return memories.filter((memory) => memory.scope !== "project" || memory.projectId === currentProjectId);
}

// ============================================================
// Query / content normalization (Objective 13)
// ============================================================

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "am", "are", "was", "were", "be", "been", "being",
  "i", "me", "my", "mine", "you", "your", "it", "its", "this", "that",
  "to", "of", "in", "on", "at", "for", "with", "and", "or", "as", "so",
  "do", "does", "did", "how", "what", "should", "would", "could", "can",
  "will", "shall", "please", "help", "me", "about", "into", "up",
  // Generic, low-information verbs that show up in almost any sentence
  // regardless of topic — matching on these alone produced false-positive
  // relevance (e.g. "...should I *use* for the UI" vs "I primarily *use*
  // TypeScript" sharing only "use"). Real topical overlap should come from
  // the nouns/technologies/adjectives, not these.
  "use", "used", "using", "want", "need", "needed", "get", "got", "make",
  "made", "know", "think", "like", "just",
]);

// Deliberately small — a handful of high-value equivalences that pure
// tokenization would otherwise miss, not a general-purpose thesaurus
// (Objective 13 explicitly warns against a giant synonym dictionary).
const SYNONYM_EXPANSIONS: Record<string, string[]> = {
  typescript: ["ts", "type", "typed", "typing"],
  ts: ["typescript"],
  type: ["typescript"],
  typed: ["typescript"],
  typing: ["typescript"],
  javascript: ["js"],
  js: ["javascript"],
  frontend: ["front"],
  backend: ["back"],
  ai: ["artificial", "intelligence"],
  ui: ["interface"],
  ux: ["experience"],
};

function tokenize(text: string): Set<string> {
  const base = text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));

  const expanded = new Set<string>(base);

  for (const token of base) {
    const synonyms = SYNONYM_EXPANSIONS[token];
    if (synonyms) {
      for (const synonym of synonyms) expanded.add(synonym);
    }

    // Simple, safe plural normalization (Objective 13) — e.g. "interfaces"
    // also adds "interface" so it matches a memory phrased in the singular.
    // Not a real stemmer: skips short words and words ending "ss" (like
    // "class"/"process") where naive stripping would be wrong.
    if (token.length >= 4 && token.endsWith("s") && !token.endsWith("ss")) {
      expanded.add(token.slice(0, -1));
    }
  }

  return expanded;
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

// ============================================================
// Category boosting (Objective 14) — small, additive, never dominant.
// ============================================================

const CATEGORY_QUERY_HINTS: Partial<Record<MemoryCategory, string[]>> = {
  technical: [
    "code", "coding", "function", "component", "hook", "bug", "error",
    "syntax", "api", "type", "types", "generic", "generics", "implement",
    "debug", "library", "framework", "compile", "build", "algorithm",
  ],
  project: ["project", "architecture", "system", "feature", "roadmap", "app"],
  work: ["work", "job", "career", "deadline", "meeting", "client"],
  preference: [
    "prefer", "like", "color", "colour", "style", "theme", "scheme",
    "design", "look", "ui", "ux", "interface",
  ],
  education: ["learn", "learning", "course", "study", "class", "school", "degree"],
  routine: ["routine", "schedule", "habit", "daily", "morning", "everyday"],
  interest: ["hobby", "interest", "enjoy", "fun"],
  relationship: ["friend", "family", "partner", "wife", "husband", "colleague"],
  personal: ["name", "live", "location", "birthday"],
};

function categoryBoostFor(category: MemoryCategory, queryTokens: Set<string>): number {
  const hints = CATEGORY_QUERY_HINTS[category];
  if (!hints) return 0;

  const matches = hints.some((hint) => queryTokens.has(hint));
  return matches ? RETRIEVAL_CONFIG.CATEGORY_BOOST : 0;
}

// ============================================================
// Score components
// ============================================================

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 1-5 -> 0.2-1.0, per Objective 4. Falls back to the default-importance
 *  (3 -> 0.6) equivalent if a record somehow has a non-finite value. */
function normalizeImportance(importance: number): number {
  if (!Number.isFinite(importance)) return 0.6;
  return clamp01(importance / 5);
}

/** Exponential decay with a floor — recent memories get a modest boost,
 *  but age alone never drives a memory's usefulness to zero (Objective 5). */
function computeRecencyScore(updatedAt: string, now: Date): number {
  const updated = new Date(updatedAt).getTime();

  if (Number.isNaN(updated)) return RETRIEVAL_CONFIG.RECENCY_FLOOR;

  const ageDays = Math.max(0, (now.getTime() - updated) / (1000 * 60 * 60 * 24));
  const decay = Math.pow(0.5, ageDays / RETRIEVAL_CONFIG.RECENCY_HALF_LIFE_DAYS);

  return RETRIEVAL_CONFIG.RECENCY_FLOOR + (1 - RETRIEVAL_CONFIG.RECENCY_FLOOR) * decay;
}

// A memory's persisted embedding is only trusted for semantic scoring if
// it's present AND current (same model as configured) — a stale embedding
// (Objective 20) is treated exactly like a missing one: 0 semantic
// contribution for this query, never a wrong comparison across models.
function semanticScoreFor(queryVector: number[] | null, memory: MemoryRecord): number {
  if (!queryVector) return 0;
  if (!memory.embedding || isEmbeddingStale(memory)) return 0;

  // cosineSimilarity can be negative (opposite direction); a "negatively
  // correlated" memory isn't meaningfully "anti-relevant" for this use
  // case, so it's floored at 0 rather than allowed to drag the blended
  // score below what the other components alone would produce.
  return Math.max(0, cosineSimilarity(queryVector, memory.embedding));
}

function isScorable(memory: unknown): memory is MemoryRecord {
  if (!memory || typeof memory !== "object") return false;
  const record = memory as Record<string, unknown>;
  return (
    typeof record.content === "string" &&
    record.content.length > 0 &&
    typeof record.importance === "number" &&
    typeof record.updatedAt === "string" &&
    typeof record.category === "string" &&
    typeof record.id === "string"
  );
}

// ============================================================
// Retrieval
// ============================================================

export async function retrieveRelevantMemories(
  options: RetrieveRelevantMemoriesOptions
): Promise<MemoryRetrievalResult> {
  const {
    message,
    memories,
    maxMemories = RETRIEVAL_CONFIG.MAX_RETRIEVED_MEMORIES,
    maxCharacters = RETRIEVAL_CONFIG.MAX_MEMORY_CONTEXT_CHARS,
    now = new Date(),
    __queryVectorForTesting,
    timer,
  } = options;

  const trimmedMessage = (message ?? "").trim();
  const queryTokens = tokenize(message ?? "");
  const scored: ScoredMemory[] = [];

  // An empty/whitespace query has nothing to match against — this is valid
  // input (Objective 21 #7), not an error; it just yields zero candidates.
  // No point spending an embedding call on it either.
  if (trimmedMessage.length === 0) {
    timer?.mark("embeddingQuery");
    logRetrievalDebug(message, scored, memories.length, false);
    timer?.mark("memoryRetrieval");
    return { selected: [], scored, semanticAvailable: false };
  }

  // Objective 6: exactly one embedding call per retrieval, for the query —
  // never one per memory. Objective 12: any failure here (Ollama down,
  // model missing, bad response, timeout) degrades to lexical-only rather
  // than throwing out of retrieval and breaking the chat request.
  let queryVector: number[] | null = null;

  if (__queryVectorForTesting !== undefined) {
    queryVector = __queryVectorForTesting;
  } else {
    try {
      // Ollama Scheduler v1 (Objective 9) — MEDIUM priority: this is
      // interactive work for the CURRENT turn (below chat generation
      // itself, but above any background extraction/embedding), and it
      // runs on the embed lane, which is separate from — and measured not
      // to contend with — the generate lane chat uses.
      queryVector = await scheduleOllamaTask("query-embedding", OllamaPriority.MEDIUM, (signal) =>
        embedText(trimmedMessage, signal)
      );
    } catch (error) {
      queryVector = null;
      console.warn(
        `[semantic-retrieval] unavailable; falling back to lexical ranking (${describeEmbeddingError(error)})`
      );
    }
  }

  timer?.mark("embeddingQuery");

  const semanticAvailable = queryVector !== null;

  for (const memory of memories) {
    if (!isScorable(memory)) {
      console.error("[memory-retrieval] skipping malformed memory record:", memory);
      continue;
    }

    const memoryTokens = tokenize(memory.content);
    const lexicalRelevanceRaw = jaccardSimilarity(queryTokens, memoryTokens);

    // The category boost is only ever an amplifier on top of genuine
    // lexical overlap — it must never manufacture relevance on its own
    // (Objective 14/9), so it's gated on the raw (pre-boost) score being
    // positive, same rule v2C already had.
    const boost = lexicalRelevanceRaw > 0 ? categoryBoostFor(memory.category, queryTokens) : 0;
    const lexical = clamp01(lexicalRelevanceRaw + boost);
    const semantic = semanticScoreFor(queryVector, memory);

    // Eligibility is an OR of two INDEPENDENT floors (Objective 9): a
    // memory becomes a candidate if EITHER signal clears its own bar on
    // its own. Neither floor can be satisfied by the other's presence —
    // an unrelated-but-pinned memory with near-zero lexical AND semantic
    // signal is excluded right here, before pinnedBoost is ever added.
    const passesLexicalFloor = lexical >= RETRIEVAL_CONFIG.MIN_RELEVANCE_SCORE;
    const passesSemanticFloor = semantic >= RETRIEVAL_CONFIG.MIN_SEMANTIC_SCORE;

    if (!passesLexicalFloor && !passesSemanticFloor) continue;

    const importance = normalizeImportance(memory.importance);
    const recency = computeRecencyScore(memory.updatedAt, now);
    // Only reached once a memory has already cleared a relevance floor
    // above — pinned status can never help it get here, only affect its
    // rank once it has (Objective 3/9).
    const pinnedBoost = memory.pinned ? RETRIEVAL_CONFIG.PINNED_BOOST : 0;
    // Projects v1A (Objective 9): by the time a memory reaches this loop it
    // has already been through the caller's scope filter (see
    // filterMemoriesByScope) — every scope:"project" memory that survives
    // that filter DOES belong to the current project (that's the whole
    // point of the filter), so no projectId comparison is needed here.
    const projectBoost = memory.scope === "project" ? RETRIEVAL_CONFIG.PROJECT_BOOST : 0;

    const final =
      RETRIEVAL_CONFIG.LEXICAL_WEIGHT * lexical +
      RETRIEVAL_CONFIG.SEMANTIC_WEIGHT * semantic +
      RETRIEVAL_CONFIG.IMPORTANCE_WEIGHT * importance +
      RETRIEVAL_CONFIG.RECENCY_WEIGHT * recency +
      pinnedBoost +
      projectBoost;

    // Second-stage safety net (Objective 9) — a candidate that barely
    // cleared one floor but whose overall blended signal is still weak.
    if (final < RETRIEVAL_CONFIG.MIN_COMBINED_SCORE) continue;

    scored.push({
      memory,
      score: { lexical, semantic, importance, recency, categoryBoost: boost, pinnedBoost, projectBoost, final },
      selected: false,
    });
  }

  // Deterministic ranking (Objective 21 #15/#16): sort by final score, then
  // break ties by importance, then by id so repeated runs on identical
  // input always produce an identical order.
  scored.sort((a, b) => {
    if (b.score.final !== a.score.final) return b.score.final - a.score.final;
    if (b.memory.importance !== a.memory.importance) return b.memory.importance - a.memory.importance;
    return a.memory.id.localeCompare(b.memory.id);
  });

  const selected: MemoryRecord[] = [];
  let charactersUsed = 0;

  for (const candidate of scored) {
    if (selected.length >= maxMemories) break;

    const lineLength = formatMemoryLine(candidate.memory).length;

    // Higher-ranked memories get strict priority: once the budget is full,
    // stop rather than searching for a smaller lower-ranked memory that
    // might still fit. Simple and predictable over optimal bin-packing
    // (Objective 23).
    if (charactersUsed + lineLength > maxCharacters) break;

    candidate.selected = true;
    selected.push(candidate.memory);
    charactersUsed += lineLength;
  }

  logRetrievalDebug(message, scored, memories.length, semanticAvailable);
  timer?.mark("memoryRetrieval");

  return { selected, scored, semanticAvailable };
}

function describeEmbeddingError(error: unknown): string {
  if (error instanceof EmbeddingRequestError || error instanceof EmbeddingResponseError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

// ============================================================
// Prompt formatting (Objective 10) — plain readable bullets, never raw JSON.
// ============================================================

function formatMemoryLine(memory: MemoryRecord): string {
  return `- ${memory.content}`;
}

export function formatRetrievedMemories(memories: MemoryRecord[]): string {
  return memories.length > 0 ? memories.map(formatMemoryLine).join("\n") : "- None";
}

// ============================================================
// Debug logging (Objective 15/18) — concise, never a full content dump.
// ============================================================

function logRetrievalDebug(
  message: string,
  scored: ScoredMemory[],
  totalMemoryCount: number,
  semanticAvailable: boolean
): void {
  const selectedCount = scored.filter((s) => s.selected).length;

  console.log(
    `[memory-retrieval] query="${truncate(message, 60)}" candidates=${scored.length}/${totalMemoryCount} selected=${selectedCount} semantic=${semanticAvailable ? "on" : "off"}`
  );

  for (const { memory, score, selected } of scored) {
    console.log(
      `  ${selected ? "✓" : "·"} ${memory.id.slice(0, 8)} lex=${score.lexical.toFixed(2)} sem=${score.semantic.toFixed(2)} imp=${score.importance.toFixed(2)} rec=${score.recency.toFixed(2)} pin=${score.pinnedBoost.toFixed(2)} final=${score.final.toFixed(2)} "${truncate(memory.content, 50)}"`
    );
  }
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}
