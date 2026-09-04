import { addMemory, addGoalFromCommand, getMemories, touchMemory, MemoryRecord, MemoryCategory, MemoryScope } from "./memoryService";
import {
  extractMemoryCandidates,
  isExplicitGoalCommand,
  isExplicitMemoryCommand,
  splitExplicitMemoryCommands,
  containsSensitiveContent,
  MemoryCandidate,
} from "./memoryExtractor";
import { findExactDuplicate, findNearDuplicate } from "./memoryDeduplication";
import { embedMemoryAsync } from "./memoryEmbeddings";

// Memory v2B orchestration — the single entry point the chat pipeline
// (server.ts, for both /chat and /chat/stream) calls after a user message
// is known. This is intentionally the only place that decides explicit vs.
// automatic and ties extraction + dedup + persistence together; it owns no
// logic of its own for any of those three concerns.
//
//   user message
//     -> explicit memory command?
//          yes -> save directly (authoritative, Objective 4)
//          no  -> extract candidates (memoryExtractor)
//                   -> confidence gate
//                   -> sensitive-content guard
//                   -> duplicate check (memoryDeduplication)
//                   -> save accepted candidates (memoryService)
//
// Below this threshold, an automatically-extracted candidate is rejected
// rather than saved (Objective 12). 0.8 is the suggested starting point;
// recalibrate if live model behavior warrants it.
const CONFIDENCE_THRESHOLD = 0.8;

export type MemoryExtractionResult = {
  saved: MemoryRecord[];
  duplicates: MemoryCandidate[];
  rejected: MemoryCandidate[];
};

export interface MemoryExtractionContext {
  /** Projects v1A — the project this message was sent inside, if any. */
  projectId?: string | null;
}

// Projects v1A (Objective 7) — decides whether a newly-extracted candidate
// becomes a "global" or "project" memory. Deliberately simple: outside a
// project, everything is global (unchanged v2B behavior). Inside a
// project, a candidate is project-scoped UNLESS its category marks it as
// describing the USER rather than the project itself ("preference" and
// "personal" — e.g. "I prefer concise explanations" should stay available
// everywhere, not get trapped inside one project). This is a clean,
// category-based architectural distinction, not a giant heuristic — easy
// to refine later without restructuring anything (Objective 7's own
// instruction: "be conservative... create a clean distinction that can be
// improved later").
const GLOBAL_EVEN_INSIDE_PROJECT_CATEGORIES: ReadonlySet<MemoryCategory> = new Set(["preference", "personal"]);

function resolveScope(
  category: MemoryCategory,
  projectId: string | null | undefined
): { scope: MemoryScope; projectId?: string } {
  if (!projectId) return { scope: "global" };
  if (GLOBAL_EVEN_INSIDE_PROJECT_CATEGORIES.has(category)) return { scope: "global" };
  return { scope: "project", projectId };
}

// Extraction is a secondary capability: any failure here is caught and
// logged, never thrown, so it can safely be called without the caller
// needing its own try/catch (Objective 13). Call this at most once per user
// message (Objective 14) — never per streamed chunk, never retried.
export async function processUserMessageForMemory(
  message: string,
  context: MemoryExtractionContext = {}
): Promise<MemoryExtractionResult> {
  try {
    // Checked first and separately from isExplicitMemoryCommand: an
    // unambiguous goal-creation command ("Add goal: ...") belongs in the
    // dedicated Goals system, not as a MemoryRecord — see
    // processExplicitGoalCommand. Neither pattern list overlaps with the
    // other, so the order between this and the memory-command check below
    // doesn't itself matter; it's ordered first for readability (goal
    // routing is the more specific case).
    if (isExplicitGoalCommand(message)) {
      return processExplicitGoalCommand(message);
    }

    if (isExplicitMemoryCommand(message)) {
      return await processExplicitCommand(message, context.projectId ?? null);
    }

    return await processAutomaticExtraction(message, context.projectId ?? null);
  } catch (error) {
    console.error("[memory] pipeline failed unexpectedly, skipping:", error);
    return { saved: [], duplicates: [], rejected: [] };
  }
}

// Goal commands intentionally never produce a MemoryRecord (Part 4 of the
// usability pass): they always return an empty result here, even on
// success — the created Goal lives in memory.goals, not memory.memories,
// and the chat pipeline doesn't need to know which of the two happened,
// only that the message was handled.
function processExplicitGoalCommand(message: string): MemoryExtractionResult {
  const goal = addGoalFromCommand(message);

  if (goal) {
    console.log(`[memory] explicit goal created (not saved as a fact): "${goal.title}"`);
  } else {
    console.log(`[memory] explicit goal command skipped (empty or duplicate title): "${message}"`);
  }

  return { saved: [], duplicates: [], rejected: [] };
}

// A single message can contain several "Remember that ..." clauses (this
// was the exact bug reported: four chained commands were being saved as
// one run-on memory instead of four atomic ones — see
// splitExplicitMemoryCommands). Each split segment is persisted and
// duplicate-checked independently ("per candidate", not against the
// original whole message), exactly like automatic extraction's candidates.
//
// This intentionally still uses only addMemory()'s own exact-match dedup
// (not the near-duplicate check automatic extraction also applies) — an
// explicit command is the user deliberately asking LOIS to remember
// something, so a merely *similar* existing memory should not silently
// block it; only a genuine exact restatement should.
//
// Projects v1A: explicit saves have no category signal (no LLM
// classification call for these — addMemory() defaults them to "other"),
// so resolveScope("other", projectId) always resolves to project scope
// when inside a project — a deliberate, documented default: an explicit
// "remember that..." said while working in a project is treated as
// project knowledge unless/until v1B-style classification improves on it.
async function processExplicitCommand(message: string, projectId: string | null): Promise<MemoryExtractionResult> {
  const segments = splitExplicitMemoryCommands(message);

  const result: MemoryExtractionResult = { saved: [], duplicates: [], rejected: [] };
  const { scope, projectId: resolvedProjectId } = resolveScope("other", projectId);

  for (const content of segments) {
    const saved = addMemory(content, { source: "user", scope, projectId: resolvedProjectId });

    if (saved) {
      console.log(`[memory] explicit save: "${saved.content}"`);
      result.saved.push(saved);
      // Memory v2E (Objective 4): embed on creation. Awaited here, not
      // fire-and-forget — this whole pipeline already runs off the
      // request's critical path (server.ts calls it via .catch(), never
      // awaits it for the chat reply), so there's no user-facing latency
      // cost to waiting for one ~50ms embed call before moving to the next
      // segment.
      await embedMemoryAsync(saved.id);
    } else {
      console.log(`[memory] explicit save skipped (empty or duplicate content): "${content}"`);
      result.duplicates.push({
        content,
        category: "other",
        importance: 3,
        confidence: 1,
        reason: "duplicate_or_empty",
      });
    }
  }

  return result;
}

// Projects v1A: `existing` (used for both exact- and near-duplicate
// checking) is narrowed to the SAME scope as the candidate being
// considered — a project fact only collides with that same project's
// existing memories, a global fact only with existing global ones. This
// mirrors addMemory()/updateMemory()'s own scoped dedup and keeps a
// project's memories from silently blocking (or being blocked by)
// unrelated global or other-project content.
function sameScopeMemories(all: MemoryRecord[], scope: MemoryScope, projectId: string | undefined): MemoryRecord[] {
  return all.filter((m) => m.scope === scope && m.projectId === projectId);
}

async function processAutomaticExtraction(message: string, projectId: string | null): Promise<MemoryExtractionResult> {
  const candidates = await extractMemoryCandidates(message);

  const result: MemoryExtractionResult = { saved: [], duplicates: [], rejected: [] };

  // Performance Pass v1 (Objective 7) — getMemories() (a full readMemory()
  // disk read + JSON parse) was previously called once PER CANDIDATE inside
  // this loop, so a 3-candidate extraction batch paid for the same read
  // three times. Read once up front and keep it in sync locally instead: a
  // successfully saved candidate is pushed into `allMemories` immediately
  // below so a later candidate IN THE SAME BATCH still sees it for exact/
  // near-duplicate checking — the intra-batch dedup behavior this loop
  // already relied on is unchanged, only the redundant re-reads are gone.
  // This is a background/fire-and-forget path (never the chat critical
  // path), so it's lower priority than the fix already applied in
  // agentContext.ts, but the same duplication was real.
  const allMemories = getMemories();

  for (const candidate of candidates) {
    if (candidate.confidence < CONFIDENCE_THRESHOLD) {
      console.log(
        `[memory] candidate rejected (confidence ${candidate.confidence.toFixed(2)} < ${CONFIDENCE_THRESHOLD}): "${candidate.content}"`
      );
      result.rejected.push({ ...candidate, reason: "low_confidence" });
      continue;
    }

    if (containsSensitiveContent(candidate.content)) {
      console.log("[memory] candidate rejected (sensitive content)");
      result.rejected.push({ ...candidate, reason: "sensitive_content" });
      continue;
    }

    const { scope, projectId: resolvedProjectId } = resolveScope(candidate.category, projectId);
    const existing = sameScopeMemories(allMemories, scope, resolvedProjectId);

    const exactMatch = findExactDuplicate(candidate.content, existing);
    if (exactMatch) {
      console.log(`[memory] candidate duplicate (exact match): "${candidate.content}"`);
      touchMemory(exactMatch.id);
      result.duplicates.push({ ...candidate, reason: "exact_duplicate" });
      continue;
    }

    const nearMatch = findNearDuplicate(candidate.content, existing);
    if (nearMatch) {
      console.log(`[memory] candidate duplicate (near match with "${nearMatch.content}"): "${candidate.content}"`);
      result.duplicates.push({ ...candidate, reason: "near_duplicate" });
      continue;
    }

    const saved = addMemory(candidate.content, {
      category: candidate.category,
      importance: candidate.importance,
      scope,
      projectId: resolvedProjectId,
      source: "user",
    });

    if (saved) {
      console.log(`[memory] candidate saved: "${saved.content}" (category=${saved.category}, importance=${saved.importance})`);
      result.saved.push(saved);
      allMemories.push(saved); // keep the local snapshot in sync for later candidates in this same batch
      await embedMemoryAsync(saved.id); // Memory v2E (Objective 4) — see processExplicitCommand's comment
    } else {
      // addMemory()'s own internal exact-match check caught something our
      // normalization missed (or the content was empty after its cleanup)
      // — treat it as a duplicate rather than silently dropping it.
      result.duplicates.push({ ...candidate, reason: "exact_duplicate" });
    }
  }

  return result;
}
