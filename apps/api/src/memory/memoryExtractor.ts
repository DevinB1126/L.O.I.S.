import { askOllama } from "../providers/ollamaProvider";
import { MEMORY_CATEGORIES, MemoryCategory, ProfileField } from "./memoryService";
import { scheduleOllamaTask, OllamaPriority, OllamaTaskPreemptedError } from "../perf/ollamaScheduler";

// Memory v2B — decides what from a single user message MIGHT be worth
// remembering, and returns structured candidates. This module never writes
// to memory.json (memoryService owns persistence) and never decides
// duplicates (memoryDeduplication owns that) — see memoryPipeline.ts for
// the orchestration that ties all three together.

export type MemoryCandidate = {
  content: string;
  category: MemoryCategory;
  importance: number;
  confidence: number;
  /** Set internally when a candidate is rejected/deduped — never requested from the model. */
  reason?: string;
};

const MIN_CONTENT_LENGTH = 3;
const MAX_CONTENT_LENGTH = 300;

// ============================================================
// Explicit commands ("remember that...", "save this...") — these bypass
// automatic extraction entirely and are authoritative (Objective 4).
// ============================================================

const EXPLICIT_MEMORY_PATTERNS: RegExp[] = [
  /^remember that\s+/i,
  /^remember:\s*/i,
  /^please remember that\s+/i,
  /^lois,?\s+remember that\s+/i,
  /^lois,?\s+remember:\s*/i,
  /^save this\s*[:.]?\s*/i,
  /^add this to memory\s*[:.]?\s*/i,
  /^add to my facts\s*[:.]?\s*/i,
  /^add fact\s*[:.]?\s*/i,
];

export function isExplicitMemoryCommand(message: string): boolean {
  const trimmed = message.trim();
  return EXPLICIT_MEMORY_PATTERNS.some((pattern) => pattern.test(trimmed));
}

// Same trigger phrases as EXPLICIT_MEMORY_PATTERNS, but unanchored and
// global — used to locate every command boundary *within* a message,
// including ones that don't start the string, so a message containing
// several "Remember that ..." clauses splits into that many atomic
// statements instead of being saved as one run-on memory. Longer/more
// specific phrases are listed first so they win over a shorter phrase that
// would otherwise match as a substring of them (e.g. "remember that" is a
// substring of "please remember that").
const EXPLICIT_COMMAND_SPLIT_PATTERNS: RegExp[] = [
  /please remember that\s+/gi,
  /lois,?\s+remember that\s+/gi,
  /lois,?\s+remember:\s*/gi,
  /remember that\s+/gi,
  /remember:\s*/gi,
  /save this\s*[:.]?\s*/gi,
  /add this to memory\s*[:.]?\s*/gi,
  /add to my facts\s*[:.]?\s*/gi,
  /add fact\s*[:.]?\s*/gi,
];

// Splits a message that starts with an explicit memory command into one or
// more atomic statements, stripping the trigger phrase from each. A single
// command ("Remember that X.") yields a one-element array — the same
// result the old stripExplicitCommandPrefix() produced — so this is a
// drop-in replacement, not just an addition.
export function splitExplicitMemoryCommands(message: string): string[] {
  const matches: { start: number; end: number }[] = [];

  for (const pattern of EXPLICIT_COMMAND_SPLIT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(message)) !== null) {
      matches.push({ start: match.index, end: match.index + match[0].length });

      // A zero-length match (shouldn't happen with these patterns, but
      // guards against a future edit introducing one) would loop forever.
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  }

  if (matches.length === 0) {
    const trimmed = message.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }

  // Several patterns can match the same logical trigger point (e.g. both
  // "remember that" and "please remember that" match at/near the same
  // spot) — sort earliest-and-longest first, then drop any match that
  // starts inside a match we've already kept, so each real trigger point
  // is only counted once.
  matches.sort((a, b) => a.start - b.start || b.end - a.end);

  const boundaries: { start: number; end: number }[] = [];
  for (const match of matches) {
    const previous = boundaries[boundaries.length - 1];
    if (previous && match.start < previous.end) continue;
    boundaries.push(match);
  }

  const segments: string[] = [];

  for (let i = 0; i < boundaries.length; i++) {
    const contentStart = boundaries[i].end;
    const contentEnd = i + 1 < boundaries.length ? boundaries[i + 1].start : message.length;
    const segment = message.slice(contentStart, contentEnd).trim();

    if (segment.length > 0) segments.push(segment);
  }

  return segments;
}

// ============================================================
// Explicit goal commands ("add goal: ...", "create goal: ...") — usability
// pass: these were previously falling through to automatic extraction and
// (when the model chose to save them) ending up as a generic MemoryRecord
// as well as a Goal, duplicating the same fact across two different
// systems. This gate is checked before isExplicitMemoryCommand so an
// unambiguous goal-creation command routes straight to the Goals system
// and never becomes a memory at all — see processExplicitGoalCommand in
// memoryPipeline.ts. Deliberately narrow and anchored (unlike
// updateStructuredMemory's looser "my goal is"/"i want to" detection,
// which stays as-is): a wrong match here would silently skip saving
// something that should have been remembered, so only phrasing that is
// unambiguously a command to create a goal is included.
// ============================================================

// Kept in sync manually with cleanGoalPhrase() in memoryService.ts (see the
// comment there for why it's a separate literal list, not a shared import).
const EXPLICIT_GOAL_PATTERNS: RegExp[] = [
  /^add goal:?\s*/i,
  /^add a goal:?\s*/i,
  /^create goal:?\s*/i,
  /^create a goal:?\s*/i,
  /^new goal:?\s*/i,
  /^set goal:?\s*/i,
  /^set a goal:?\s*/i,
];

export function isExplicitGoalCommand(message: string): boolean {
  const trimmed = message.trim();
  return EXPLICIT_GOAL_PATTERNS.some((pattern) => pattern.test(trimmed));
}

// ============================================================
// Profile update intent — bug fix (profile-state synchronization pass):
// LOIS's chat reply used to claim "I've updated your profile" for messages
// like "My favorite color is red" while nothing was ever actually
// persisted — the reply is generated by an LLM call with no connection
// whatsoever to whether any mutation happened (see
// profileUpdatePipeline.ts). This is the deterministic detector that lets
// the server perform (and truthfully confirm or deny) a real
// profile.<field> mutation *before* generating any reply, instead of
// trusting a model to narrate one.
//
// Deliberately NOT anchored to the start of the message (unlike the
// explicit memory/goal command gates above) — the real bug report was "I
// want to change my favorite color. My favorite color is red", where the
// canonical statement follows an unrelated lead-in sentence. Patterns are
// still specific, declarative phrasings rather than single keywords, to
// keep false positives on unrelated sentences unlikely; this is
// intentionally simpler than full intent understanding (no question/
// hypothetical detection like the LLM-based extraction prompt has) —
// acceptable here because every phrasing matched is an explicit,
// unambiguous statement of a canonical fact, mirroring how the goal/memory
// command gates above already trade some recall for determinism.
// ============================================================

export type ProfileUpdateIntent = {
  field: ProfileField;
  value: string;
};

// Root-cause debugging pass: "lois update my favorite color from black to
// red please" was not recognized by any pattern (only "X is Y" and "change
// X to Y" existed), so the message fell through to the unguarded LLM chat
// path, which hallucinated a success narrative again — same failure mode
// as the original bug, just a phrasing gap. The "(?:change|update|set) my
// <field>(?: from OLD)? to NEW" pattern below covers that imperative form
// (with or without a stated old value) for every field, tried first since
// it's more specific than the plain "X is Y" statement it could otherwise
// be a substring of.
const PROFILE_UPDATE_PATTERNS: { field: ProfileField; pattern: RegExp }[] = [
  { field: "favoriteColor", pattern: /(?:change|update|set) my favou?rite colou?r(?: from\s+[^.!?\n,]+?)?\s+to\s+([^.!?\n,]+)/i },
  { field: "favoriteColor", pattern: /my favou?rite colou?r is\s+([^.!?\n,]+)/i },
  { field: "location", pattern: /(?:change|update|set) my location(?: from\s+[^.!?\n,]+?)?\s+to\s+([^.!?\n,]+)/i },
  { field: "location", pattern: /i(?:'ve| have)? moved to\s+([^.!?\n,]+)/i },
  { field: "location", pattern: /my location is\s+([^.!?\n,]+)/i },
  { field: "location", pattern: /i live in\s+([^.!?\n,]+)/i },
  { field: "occupation", pattern: /(?:change|update|set) my occupation(?: from\s+[^.!?\n,]+?)?\s+to\s+([^.!?\n,]+)/i },
  { field: "occupation", pattern: /my occupation is\s+([^.!?\n,]+)/i },
  { field: "occupation", pattern: /i work as (?:a|an)\s+([^.!?\n,]+)/i },
  { field: "name", pattern: /(?:change|update|set) my name(?: from\s+[^.!?\n,]+?)?\s+to\s+([^.!?\n,]+)/i },
  { field: "name", pattern: /my name is\s+([^.!?\n,]+)/i },
];

// Common trailing politeness/filler that can follow the actual value in an
// imperative phrasing ("...to red please") — stripped from every field's
// captured value so it doesn't end up baked into the stored value.
const TRAILING_FILLER = /\s+(?:please|now|thanks|thank you|for me)$/i;

export function detectProfileUpdateIntent(message: string): ProfileUpdateIntent | null {
  for (const { field, pattern } of PROFILE_UPDATE_PATTERNS) {
    pattern.lastIndex = 0; // patterns aren't /g, but stay defensive if that ever changes
    const match = pattern.exec(message);

    if (!match || !match[1]) continue;

    let value = match[1].trim();
    value = value.replace(TRAILING_FILLER, "").trim();

    if (value.length > 0) {
      return { field, value };
    }
  }

  return null;
}

// ============================================================
// Sensitive-content guard (Objective 3) — a small, explicit deny-list, not
// a compliance engine. Applied only to automatically-extracted candidates;
// explicit "remember that..." commands follow the app's existing policy
// unchanged (the user deliberately asked for it to be saved).
// ============================================================

const SENSITIVE_PATTERNS: RegExp[] = [
  /\bpassword\b/i,
  /\bpasswd\b/i,
  /\bapi[-_ ]?keys?\b/i,
  /\bsecret[-_ ]?keys?\b/i,
  /\baccess[-_ ]?tokens?\b/i,
  /\b(?:auth|authorization)[-_ ]?tokens?\b/i,
  /\bbearer\s+[a-z0-9._-]{10,}/i,
  /\bssn\b/i,
  /\bsocial security\b/i,
  /\bcredit card\b/i,
  /\bcard number\b/i,
  /\brouting number\b/i,
  /\baccount number\b/i,
  /\b\d{3}-\d{2}-\d{4}\b/, // SSN-shaped
  /\b(?:\d[ -]?){13,19}\b/, // long digit runs (card/account-number-shaped)
  /\bdiagnos(?:is|ed)\b/i,
  /\bmedical condition\b/i,
];

export function containsSensitiveContent(text: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}

// ============================================================
// LLM-based candidate extraction
// ============================================================

const EXTRACTION_PROMPT_HEADER = `You are a memory extraction system for a personal AI assistant. Your ONLY job is to decide whether a single user message contains durable, persistent information worth remembering for future conversations, and if so, extract it as one or more short factual statements.

Rules — follow all of them exactly:
- Extract ONLY durable, persistent information about the user or their ongoing context: personal preferences, long-term likes/dislikes, ongoing projects, stable work/education context, persistent routines or habits, important goals or plans, tools/technologies they regularly use, stable communication preferences, or explicitly stated relationships.
- Do NOT extract transient statements: current mood, hunger, tiredness, weather, "I'll be right back", small talk, or anything true only right now.
- Do NOT extract questions, hypotheticals, or requests for the assistant to do something (e.g. "Should I use React?", "Fix this bug", "What's 2+2?", "If I switched to Python, would that help?"). A question about a topic is NOT a statement of fact about the user.
- Do NOT infer or assume anything the user did not explicitly state. Do not guess.
- Preserve negation exactly. "I don't like Tailwind" must stay negative — never invert it to "I like Tailwind".
- NEVER extract sensitive information even if explicitly present: passwords, API keys, tokens, financial account/card numbers, precise home addresses, medical diagnoses, legal/criminal details, or other highly private data.
- Each "content" value MUST be a complete, self-contained, grammatical first-person sentence about the user — never a bare word, a title, or a sentence fragment. Write it the way you would want to read it back later. For example write "I primarily use TypeScript for my projects." — NOT "TypeScript". Write "I'm building LOIS, a local AI assistant." — NOT "LOIS" or "Building LOIS".
- Only use these category values: ${MEMORY_CATEGORIES.join(", ")}.
- importance is an integer from 1 to 5, and you must be strict about it: 3 (normal) is the correct value for almost every memory you extract, including ordinary preferences and the tools/technologies someone uses. Use 4 ONLY when the user describes something as their main or primary long-term project or a major life circumstance. Use 5 only in the rare case the user explicitly calls something critical, essential, or the single most important thing — if in doubt, use 3, never 4 or 5.
- confidence is a number from 0 to 1: how confident you are this is a genuine, explicitly-stated, durable fact worth remembering.
- A single message may contain zero, one, or a few distinct facts. Keep each memory a short, complete, atomic sentence — do not merge unrelated facts into one entry, and do not split one fact into several near-duplicate entries.
- Respond with JSON ONLY. No prose, no markdown code fences, no explanation before or after — just the JSON object.

Respond in exactly this shape:
{"shouldRemember": true, "memories": [{"content": "...", "category": "...", "importance": 3, "confidence": 0.9}]}

If nothing durable is stated, respond with exactly:
{"shouldRemember": false, "memories": []}`;

// One extraction attempt per user message (Objective 14) — callers must not
// invoke this more than once per message (e.g. never per streamed chunk).
export async function extractMemoryCandidates(message: string): Promise<MemoryCandidate[]> {
  const prompt = `${EXTRACTION_PROMPT_HEADER}

User message:
"""
${message}
"""

JSON response:`;

  let raw: string;

  try {
    // Ollama Scheduler v1 (Objective 8) — LOW priority, retryOnPreempt so a
    // preemption by an interactive chat request (see Objective 4) isn't
    // silently lost: the scheduler re-queues this exact attempt once, and
    // because the queue always drains higher-priority work first, that
    // retry naturally runs once the system goes idle rather than fighting
    // the next interactive request all over again. If the retry is ALSO
    // preempted (or any other error occurs), this catch treats it exactly
    // like any other extraction failure always has — extraction is
    // noncritical, so a lost attempt here means "try again next message,"
    // never a broken chat response.
    raw = await scheduleOllamaTask("memory-extraction", OllamaPriority.LOW, (signal) => askOllama(prompt, signal), {
      retryOnPreempt: true,
    });
  } catch (error) {
    if (error instanceof OllamaTaskPreemptedError) {
      console.log("[memory] extraction preempted by interactive work (retry already attempted); skipping this turn");
    } else {
      console.error("[memory] extraction request failed:", error);
    }
    return [];
  }

  return parseExtractionResponse(raw);
}

// Never trust the model's JSON blindly (Objective 5) — every field is
// validated, and any failure at any stage yields an empty candidate list
// rather than throwing, so extraction can never break the chat pipeline.
function parseExtractionResponse(raw: string): MemoryCandidate[] {
  const jsonText = extractJsonObject(raw);

  if (!jsonText) {
    console.error("[memory] extraction response had no JSON object");
    return [];
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    console.error("[memory] extraction response was not valid JSON:", error);
    return [];
  }

  if (!parsed || typeof parsed !== "object") return [];

  const result = parsed as Record<string, unknown>;

  if (result.shouldRemember !== true) return [];
  if (!Array.isArray(result.memories)) return [];

  const candidates: MemoryCandidate[] = [];

  for (const entry of result.memories) {
    const candidate = validateCandidate(entry);
    if (candidate) {
      candidates.push(candidate);
    } else {
      console.error("[memory] dropping malformed extraction candidate:", entry);
    }
  }

  return candidates;
}

function validateCandidate(value: unknown): MemoryCandidate | null {
  if (!value || typeof value !== "object") return null;

  const entry = value as Record<string, unknown>;

  const content = typeof entry.content === "string" ? entry.content.trim() : "";
  if (content.length < MIN_CONTENT_LENGTH || content.length > MAX_CONTENT_LENGTH) return null;

  if (!isMemoryCategory(entry.category)) return null;
  const category = entry.category;

  const importance = Number(entry.importance);
  if (!Number.isInteger(importance) || importance < 1 || importance > 5) return null;

  const confidence = Number(entry.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;

  return { content, category, importance, confidence };
}

function isMemoryCategory(value: unknown): value is MemoryCategory {
  return typeof value === "string" && (MEMORY_CATEGORIES as readonly string[]).includes(value);
}

// Models sometimes wrap JSON in ```json fences or add stray text despite
// instructions — pull out the first {...} object rather than assuming the
// whole response is clean JSON.
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) return null;

  return text.slice(start, end + 1);
}

// Exposed for testing the parsing/validation path without a live model call.
export const __testables = { parseExtractionResponse };
