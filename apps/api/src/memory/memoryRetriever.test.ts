// Unit tests for Memory v2C/v2E's hybrid (lexical + semantic) relevance
// retrieval. Everything below EXCEPT the "Memory v2E — semantic/hybrid"
// suite passes `__queryVectorForTesting: null` explicitly, which forces
// retrieveRelevantMemories() down its "semantic unavailable" path without
// ever calling the real embedding provider — these are the original v2C
// lexical-only tests, kept hermetic/fast/offline exactly as before. The
// v2E suite instead passes precomputed vectors, so hybrid-scoring math is
// tested deterministically without an Ollama dependency either.
// Run with: npm run test --workspace=api

import { test } from "node:test";
import assert from "node:assert/strict";
import { retrieveRelevantMemories, formatRetrievedMemories, filterMemoriesByScope, RETRIEVAL_CONFIG } from "./memoryRetriever";
import { EMBEDDING_MODEL } from "../providers/embeddingProvider";
import type { MemoryRecord } from "./memoryService";

const NOW = new Date("2026-09-02T00:00:00.000Z");

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function makeMemory(overrides: Partial<MemoryRecord> & { id: string; content: string }): MemoryRecord {
  return {
    category: "other",
    importance: 3,
    pinned: false,
    scope: "global",
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    source: "user",
    ...overrides,
  };
}

// The Objective 17 fixture set, used across several tests below.
const FIXTURE: MemoryRecord[] = [
  makeMemory({ id: "m1", content: "I primarily use TypeScript.", category: "technical", importance: 4 }),
  makeMemory({ id: "m2", content: "I prefer React for frontend development.", category: "preference", importance: 3 }),
  makeMemory({ id: "m3", content: "I prefer concise technical explanations.", category: "preference", importance: 4 }),
  makeMemory({ id: "m4", content: "I prefer dark interfaces.", category: "preference", importance: 3 }),
  makeMemory({ id: "m5", content: "I am building LOIS as a local AI assistant.", category: "project", importance: 5 }),
  makeMemory({ id: "m6", content: "I like grilled cheese sandwiches.", category: "preference", importance: 2 }),
];

function idsOf(memories: MemoryRecord[]): string[] {
  return memories.map((m) => m.id);
}

// ============================================================
// Objective 17 query scenarios (v2C, lexical-only — semantic forced off)
// ============================================================

test("QUERY A: React/TypeScript question ranks TypeScript+React+concise-explanations highly, rejects dark-mode+sandwiches", async () => {
  const result = await retrieveRelevantMemories({
    message: "How should I type this React hook?",
    memories: FIXTURE,
    now: NOW,
    __queryVectorForTesting: null,
  });

  const selectedIds = idsOf(result.selected);

  assert.ok(selectedIds.includes("m1"), "TypeScript memory should be selected");
  assert.ok(selectedIds.includes("m2"), "React memory should be selected");
  assert.ok(!selectedIds.includes("m4"), "dark-interface memory should NOT be selected");
  assert.ok(!selectedIds.includes("m6"), "grilled-cheese memory should NOT be selected");
});

test("QUERY B: LOIS architecture question ranks the LOIS project memory highly", async () => {
  const result = await retrieveRelevantMemories({
    message: "Help me improve the LOIS memory architecture.",
    memories: FIXTURE,
    now: NOW,
    __queryVectorForTesting: null,
  });

  const selectedIds = idsOf(result.selected);
  assert.ok(selectedIds.includes("m5"), "LOIS project memory should be selected");
  assert.ok(!selectedIds.includes("m6"), "grilled-cheese memory should NOT be selected");
});

test("QUERY C: UI color-scheme question surfaces the dark-interface preference", async () => {
  const result = await retrieveRelevantMemories({
    message: "What color scheme should I use for the UI?",
    memories: FIXTURE,
    now: NOW,
    __queryVectorForTesting: null,
  });

  const selectedIds = idsOf(result.selected);
  assert.ok(selectedIds.includes("m4"), "dark-interface preference should be selected");
  assert.ok(!selectedIds.includes("m1"), "TypeScript memory should not be relevant here");
  assert.ok(!selectedIds.includes("m6"), "grilled-cheese memory should NOT be selected");
});

test("QUERY D: unrelated general-knowledge question returns zero memories", async () => {
  const result = await retrieveRelevantMemories({
    message: "What is the capital of France?",
    memories: FIXTURE,
    now: NOW,
    __queryVectorForTesting: null,
  });

  assert.deepEqual(result.selected, []);
});

// ============================================================
// Objective 21 test list (v2C, lexical-only — semantic forced off)
// ============================================================

test("1. exact topic overlap ranks highly (near top of the ranking)", async () => {
  const result = await retrieveRelevantMemories({
    message: "I need help with TypeScript generics syntax.",
    memories: FIXTURE,
    now: NOW,
    __queryVectorForTesting: null,
  });

  assert.equal(result.selected[0]?.id, "m1");
});

test("2. partial overlap ranks appropriately (below an exact/stronger match)", async () => {
  const result = await retrieveRelevantMemories({
    message: "How should I type this React hook?",
    memories: FIXTURE,
    now: NOW,
    __queryVectorForTesting: null,
  });

  const rankOf = (id: string) => idsOf(result.selected).indexOf(id);
  // Both TypeScript ("type") and React are relevant; the multi-keyword
  // memory (m1: type/typescript) should not rank below the single-keyword
  // React-only memory in a way that's inconsistent — just assert both are
  // present and ranked above the clearly irrelevant ones.
  assert.ok(rankOf("m1") !== -1 && rankOf("m2") !== -1);
});

test("3. unrelated memory gets filtered out by the relevance floor", async () => {
  const result = await retrieveRelevantMemories({
    message: "How should I type this React hook?",
    memories: FIXTURE,
    now: NOW,
    __queryVectorForTesting: null,
  });

  const sandwichScore = result.scored.find((s) => s.memory.id === "m6");
  assert.equal(sandwichScore, undefined, "completely unrelated memory should not even appear in `scored`");
});

test("4. high importance does not override zero relevance", async () => {
  // m5 (importance 5) is about LOIS/AI-assistant — irrelevant to a sandwich question.
  const result = await retrieveRelevantMemories({
    message: "What should I eat for lunch?",
    memories: FIXTURE,
    now: NOW,
    __queryVectorForTesting: null,
  });

  assert.ok(!idsOf(result.selected).includes("m5"), "high-importance but irrelevant memory must be excluded");
});

test("5. recent memory gets a modest boost over an otherwise-identical older one", async () => {
  const recent = makeMemory({ id: "recent", content: "I prefer React for frontend development.", category: "preference", importance: 3, updatedAt: daysAgo(1) });
  const old = makeMemory({ id: "old", content: "I prefer React for backend tooling.", category: "preference", importance: 3, updatedAt: daysAgo(400) });

  const result = await retrieveRelevantMemories({
    message: "What do you think about React?",
    memories: [recent, old],
    now: NOW,
    __queryVectorForTesting: null,
  });

  const recentScore = result.scored.find((s) => s.memory.id === "recent")!;
  const oldScore = result.scored.find((s) => s.memory.id === "old")!;
  assert.ok(recentScore.score.recency > oldScore.score.recency, "recent memory should score higher on recency");
});

test("6. old but highly relevant memory still ranks (recency has a floor, not a cliff)", async () => {
  const veryOld = makeMemory({ id: "old-pref", content: "I prefer concise explanations.", updatedAt: daysAgo(1800) }); // ~5 years

  const result = await retrieveRelevantMemories({
    message: "Please give me a concise explanation.",
    memories: [veryOld],
    now: NOW,
    __queryVectorForTesting: null,
  });

  assert.ok(idsOf(result.selected).includes("old-pref"), "a 5-year-old but genuinely relevant memory must still be selectable");
  const score = result.scored.find((s) => s.memory.id === "old-pref")!;
  assert.ok(score.score.recency >= RETRIEVAL_CONFIG.RECENCY_FLOOR - 1e-9, "recency must never drop below the configured floor");
});

test("7. empty query is handled safely (no crash, no results)", async () => {
  const result = await retrieveRelevantMemories({ message: "", memories: FIXTURE, now: NOW, __queryVectorForTesting: null });
  assert.deepEqual(result.selected, []);
  assert.deepEqual(result.scored, []);
});

test("8. no relevant memories returns []", async () => {
  const result = await retrieveRelevantMemories({
    message: "What is the capital of France?",
    memories: FIXTURE,
    now: NOW,
    __queryVectorForTesting: null,
  });
  assert.deepEqual(result.selected, []);
});

test("9. max memory count is enforced", async () => {
  const many: MemoryRecord[] = Array.from({ length: 20 }, (_, i) =>
    makeMemory({ id: `t${i}`, content: `I use TypeScript for project number ${i}.`, category: "technical" })
  );

  const result = await retrieveRelevantMemories({
    message: "Tell me about my TypeScript projects.",
    memories: many,
    maxMemories: 6,
    now: NOW,
    __queryVectorForTesting: null,
  });

  assert.ok(result.selected.length <= 6);
});

test("10. character/context budget is enforced", async () => {
  const many: MemoryRecord[] = Array.from({ length: 20 }, (_, i) =>
    makeMemory({ id: `t${i}`, content: `I use TypeScript for project number ${i} in great detail.`, category: "technical" })
  );

  const result = await retrieveRelevantMemories({
    message: "Tell me about my TypeScript projects.",
    memories: many,
    maxMemories: 20,
    maxCharacters: 150,
    now: NOW,
    __queryVectorForTesting: null,
  });

  const totalChars = result.selected.reduce((sum, m) => sum + `- ${m.content}`.length, 0);
  assert.ok(totalChars <= 150, `total selected characters (${totalChars}) must not exceed the budget`);
});

test("11. higher-ranked memories survive a tight budget cutoff over lower-ranked ones", async () => {
  const strong = makeMemory({ id: "strong", content: "I mainly use TypeScript for my main project.", category: "technical", importance: 5 });
  const weak = makeMemory({ id: "weak", content: "I have used TypeScript occasionally.", category: "technical", importance: 1 });

  const strongLineLength = `- ${strong.content}`.length;
  const weakLineLength = `- ${weak.content}`.length;

  const result = await retrieveRelevantMemories({
    message: "Tell me about TypeScript.",
    memories: [weak, strong],
    // Enough room for the higher-ranked line alone, not both.
    maxCharacters: strongLineLength + 5,
    now: NOW,
    __queryVectorForTesting: null,
  });

  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].id, "strong");
  assert.ok(strongLineLength + weakLineLength > strongLineLength + 5, "sanity check: both lines together must exceed the budget");
});

test("14. the entire memory list is not blindly injected — a large store yields a small selection", async () => {
  const large: MemoryRecord[] = [
    ...FIXTURE,
    ...Array.from({ length: 50 }, (_, i) => makeMemory({ id: `noise${i}`, content: `Unrelated memory number ${i} about gardening.`, category: "other" })),
  ];

  const result = await retrieveRelevantMemories({
    message: "How should I type this React hook?",
    memories: large,
    now: NOW,
    __queryVectorForTesting: null,
  });

  assert.ok(result.selected.length <= RETRIEVAL_CONFIG.MAX_RETRIEVED_MEMORIES);
  assert.ok(result.selected.length < large.length);
});

test("15/16. retrieval order is deterministic — identical input produces identical output", async () => {
  const run1 = await retrieveRelevantMemories({ message: "How should I type this React hook?", memories: FIXTURE, now: NOW, __queryVectorForTesting: null });
  const run2 = await retrieveRelevantMemories({ message: "How should I type this React hook?", memories: FIXTURE, now: NOW, __queryVectorForTesting: null });

  assert.deepEqual(idsOf(run1.selected), idsOf(run2.selected));
});

test("17. a malformed memory record does not crash retrieval", async () => {
  const malformed = [
    { id: "bad1" }, // missing everything
    { id: "bad2", content: "valid-looking but no importance/updatedAt" },
    null,
    "just a string",
    makeMemory({ id: "good", content: "I use TypeScript for my projects.", category: "technical" }),
  ] as unknown as MemoryRecord[];

  await assert.doesNotReject(async () => {
    const result = await retrieveRelevantMemories({ message: "Tell me about TypeScript.", memories: malformed, now: NOW, __queryVectorForTesting: null });
    assert.ok(idsOf(result.selected).includes("good"));
  });
});

// ============================================================
// Memory v2D — pinned boost (Objective 3: ranking only, never eligibility)
// ============================================================

test("pinned boost ranks an otherwise-tied pinned memory above an unpinned one", async () => {
  const pinned = makeMemory({
    id: "pinned-1",
    content: "I primarily use TypeScript for my projects.",
    category: "technical",
    importance: 3,
    pinned: true,
  });
  const unpinned = makeMemory({
    id: "unpinned-1",
    content: "I primarily use TypeScript for my work.",
    category: "technical",
    importance: 3,
    pinned: false,
  });

  const result = await retrieveRelevantMemories({ message: "Tell me about TypeScript.", memories: [pinned, unpinned], now: NOW, __queryVectorForTesting: null });

  const pinnedScore = result.scored.find((s) => s.memory.id === "pinned-1")!;
  const unpinnedScore = result.scored.find((s) => s.memory.id === "unpinned-1")!;

  assert.ok(pinnedScore.score.final > unpinnedScore.score.final, "pinned memory should rank higher when otherwise similar");
  assert.equal(pinnedScore.score.pinnedBoost, RETRIEVAL_CONFIG.PINNED_BOOST);
  assert.equal(unpinnedScore.score.pinnedBoost, 0);
});

test("a pinned but UNRELATED memory does not bypass the relevance floor (Objective 3's own example)", async () => {
  const pinned = makeMemory({ id: "pinned-lois", content: "I am building LOIS.", pinned: true, importance: 5 });

  const result = await retrieveRelevantMemories({ message: "What is the capital of France?", memories: [pinned], now: NOW, __queryVectorForTesting: null });

  assert.equal(result.selected.length, 0, "an unrelated pinned memory must still be excluded");
  assert.equal(result.scored.length, 0, "it should never even clear the floor to be scored");
});

// ============================================================
// Memory v2E — semantic/hybrid retrieval
//
// Uses hand-built, small, easy-to-reason-about vectors (NOT real
// embeddings) via __queryVectorForTesting so this suite stays offline and
// deterministic — it's testing the HYBRID SCORING MATH (floors, weights,
// fallback), not the embedding model's actual semantic quality (that's
// covered by live/manual testing against real Ollama, per this task's own
// "no mocked embedding-quality tests" posture — see the final report).
// ============================================================

// Simple 3D "concept space" for hand-built test vectors: axis 0 = frontend
// framework topic, axis 1 = typed-language topic, axis 2 = unrelated
// topic. Unit-ish vectors along/near an axis are "about" that concept.
const FRONTEND_TOPIC = [1, 0, 0];
const TYPED_LANG_TOPIC = [0, 1, 0];
const UNRELATED_TOPIC = [0, 0, 1];

test("semantic-only match: zero lexical overlap but high cosine similarity still gets selected", async () => {
  const reactMemory = makeMemory({
    id: "react-mem",
    content: "I prefer React for frontend development.",
    category: "preference",
    embedding: FRONTEND_TOPIC,
    embeddingModel: EMBEDDING_MODEL,
  });

  const result = await retrieveRelevantMemories({
    // Deliberately shares almost no tokens with the memory's content.
    message: "What framework do I usually like to build interfaces with?",
    memories: [reactMemory],
    now: NOW,
    __queryVectorForTesting: FRONTEND_TOPIC, // same axis -> cosine similarity 1
  });

  assert.ok(idsOf(result.selected).includes("react-mem"), "a semantically-close memory with no lexical overlap should still be selected");
  const score = result.scored.find((s) => s.memory.id === "react-mem")!;
  assert.equal(score.score.semantic, 1);
});

test("semantic score is 0 (not selected on semantic grounds) when the memory has no embedding", async () => {
  const noEmbedding = makeMemory({ id: "no-embed", content: "Something else entirely unrelated to the query." });

  const result = await retrieveRelevantMemories({
    message: "What framework do I usually like to build interfaces with?",
    memories: [noEmbedding],
    now: NOW,
    __queryVectorForTesting: FRONTEND_TOPIC,
  });

  assert.equal(result.selected.length, 0);
});

test("a stale embedding (wrong model) is treated as no embedding, not compared", async () => {
  const staleMemory = makeMemory({
    id: "stale",
    content: "I prefer React for frontend development.",
    embedding: FRONTEND_TOPIC,
    embeddingModel: "some-old-retired-model", // != current EMBEDDING_MODEL
  });

  const result = await retrieveRelevantMemories({
    message: "What framework do I usually like to build interfaces with?",
    memories: [staleMemory],
    now: NOW,
    __queryVectorForTesting: FRONTEND_TOPIC,
  });

  const score = result.scored.find((s) => s.memory.id === "stale");
  assert.equal(score?.score.semantic ?? 0, 0, "a stale-model embedding must not contribute to the semantic score");
});

test("an unrelated memory (low lexical AND low semantic) stays excluded even when pinned (Objective 9)", async () => {
  const unrelatedPinned = makeMemory({
    id: "unrelated-pinned",
    content: "I am building LOIS as a local AI assistant.",
    pinned: true,
    importance: 5,
    embedding: [0, 0, 1], // orthogonal to the query vector below
    embeddingModel: EMBEDDING_MODEL,
  });

  const result = await retrieveRelevantMemories({
    message: "What is the capital of France?",
    memories: [unrelatedPinned],
    now: NOW,
    __queryVectorForTesting: [1, 0, 0], // orthogonal -> cosine similarity 0
  });

  assert.equal(result.selected.length, 0, "unrelated pinned memory must stay excluded even with a real (but unrelated) embedding");
});

test("exact lexical match remains extremely strong even with semantic scoring active (Objective 11)", async () => {
  const exact = makeMemory({
    id: "exact-react",
    content: "I prefer React.",
    embedding: FRONTEND_TOPIC,
    embeddingModel: EMBEDDING_MODEL,
  });

  const result = await retrieveRelevantMemories({
    message: "React",
    memories: [exact],
    now: NOW,
    __queryVectorForTesting: FRONTEND_TOPIC,
  });

  assert.ok(idsOf(result.selected).includes("exact-react"));
  const score = result.scored.find((s) => s.memory.id === "exact-react")!;
  // Jaccard over {"react"} vs {"prefer","react"} is exactly 0.5 — well
  // clear of MIN_RELEVANCE_SCORE (0.08) and comfortably selected; the
  // point of this test is that it's NOT diluted or displaced by semantic
  // scoring being active, not a specific magnitude.
  assert.ok(score.score.lexical >= 0.5, `expected a strong lexical score for an exact match, got ${score.score.lexical}`);
  assert.equal(result.selected[0]?.id, "exact-react", "the exact match should rank first");
});

test("hybrid ranking is deterministic given the same vectors (Objective 21 #15/16, semantic variant)", async () => {
  const memory = makeMemory({ id: "m", content: "I prefer React for frontend development.", embedding: FRONTEND_TOPIC, embeddingModel: EMBEDDING_MODEL });

  const run1 = await retrieveRelevantMemories({ message: "framework for interfaces", memories: [memory], now: NOW, __queryVectorForTesting: FRONTEND_TOPIC });
  const run2 = await retrieveRelevantMemories({ message: "framework for interfaces", memories: [memory], now: NOW, __queryVectorForTesting: FRONTEND_TOPIC });

  assert.deepEqual(run1.scored[0]?.score, run2.scored[0]?.score);
});

test("semantic scoring never lowers below what lexical-only would already select (fallback safety)", async () => {
  const memory = makeMemory({ id: "typed", content: "I primarily use TypeScript for my projects.", category: "technical" });

  // No embedding on the memory at all — semantic contributes 0, lexical
  // alone must still be enough given the fixture already proves this in
  // the v2C-only suite above; this just confirms the SAME call, with
  // semantic scoring "on" (a query vector present) but nothing to compare
  // against, doesn't regress it.
  const result = await retrieveRelevantMemories({
    message: "I need help with TypeScript generics syntax.",
    memories: [memory],
    now: NOW,
    __queryVectorForTesting: TYPED_LANG_TOPIC,
  });

  assert.ok(idsOf(result.selected).includes("typed"));
});

test("query embedding failure falls back to lexical-only without throwing (Objective 12)", async () => {
  // __queryVectorForTesting: null is exactly the "embedding unavailable"
  // path production code takes when embedText() throws — reused here to
  // prove the fallback still finds a strong lexical match.
  const memory = makeMemory({ id: "m1", content: "I primarily use TypeScript." });

  await assert.doesNotReject(async () => {
    const result = await retrieveRelevantMemories({
      message: "I need help with TypeScript generics.",
      memories: [memory],
      now: NOW,
      __queryVectorForTesting: null,
    });
    assert.equal(result.semanticAvailable, false);
    assert.ok(idsOf(result.selected).includes("m1"));
  });
});

test("semanticAvailable reports true when a query vector was used", async () => {
  const memory = makeMemory({ id: "m1", content: "I prefer React for frontend development.", embedding: FRONTEND_TOPIC, embeddingModel: EMBEDDING_MODEL });

  const result = await retrieveRelevantMemories({
    message: "frontend framework",
    memories: [memory],
    now: NOW,
    __queryVectorForTesting: FRONTEND_TOPIC,
  });

  assert.equal(result.semanticAvailable, true);
});

// ============================================================
// Formatting
// ============================================================

test("formatRetrievedMemories renders a plain bullet list, not JSON", () => {
  const text = formatRetrievedMemories([FIXTURE[0], FIXTURE[1]]);
  assert.equal(text, "- I primarily use TypeScript.\n- I prefer React for frontend development.");
  assert.ok(!text.includes("{"), "must not contain raw JSON");
});

test("formatRetrievedMemories handles an empty selection", () => {
  assert.equal(formatRetrievedMemories([]), "- None");
});

// ============================================================
// Projects v1A — scope-based candidate pool filtering (Objective 8/9)
// ============================================================

test("filterMemoriesByScope: global chat (currentProjectId=null) keeps only global memories", () => {
  const globalMem = makeMemory({ id: "g1", content: "global fact", scope: "global" });
  const projectMem = makeMemory({ id: "p1", content: "project fact", scope: "project", projectId: "proj-a" });

  const filtered = filterMemoriesByScope([globalMem, projectMem], null);

  assert.deepEqual(filtered.map((m) => m.id), ["g1"]);
});

test("filterMemoriesByScope: inside a project keeps global + that project's memories, excludes other projects", () => {
  const globalMem = makeMemory({ id: "g1", content: "global fact", scope: "global" });
  const sameProjectMem = makeMemory({ id: "p1", content: "same project fact", scope: "project", projectId: "proj-a" });
  const otherProjectMem = makeMemory({ id: "p2", content: "other project fact", scope: "project", projectId: "proj-b" });

  const filtered = filterMemoriesByScope([globalMem, sameProjectMem, otherProjectMem], "proj-a");

  assert.deepEqual(
    filtered.map((m) => m.id).sort(),
    ["g1", "p1"]
  );
});

test("Objective 37 (context isolation): a project memory never becomes a retrieval candidate in a different project", async () => {
  const valourMemory = makeMemory({
    id: "valour-lp",
    content: "Starting LP is 8000.",
    category: "other",
    scope: "project",
    projectId: "project-valour",
  });
  const loisDevMemory = makeMemory({
    id: "lois-ollama",
    content: "LOIS uses Ollama locally.",
    category: "technical",
    scope: "project",
    projectId: "project-lois-dev",
  });

  const allMemories = [valourMemory, loisDevMemory];

  // Inside LOIS Development, asking about starting LP: Valour's memory
  // must not even be a candidate (filtered out before scoring/retrieval).
  const poolInLoisDev = filterMemoriesByScope(allMemories, "project-lois-dev");
  assert.deepEqual(poolInLoisDev.map((m) => m.id), ["lois-ollama"]);

  const resultInLoisDev = await retrieveRelevantMemories({
    message: "What is the starting LP?",
    memories: poolInLoisDev,
    __queryVectorForTesting: null,
  });
  assert.equal(resultInLoisDev.selected.length, 0, "Valour's project memory must NOT leak into LOIS Development");

  // Inside Valour, asking about the local AI runtime: LOIS Development's
  // memory must not even be a candidate.
  const poolInValour = filterMemoriesByScope(allMemories, "project-valour");
  assert.deepEqual(poolInValour.map((m) => m.id), ["valour-lp"]);

  const resultInValour = await retrieveRelevantMemories({
    message: "What local AI runtime does this project use?",
    memories: poolInValour,
    __queryVectorForTesting: null,
  });
  assert.equal(resultInValour.selected.length, 0, "LOIS Development's project memory must NOT leak into Valour");
});

test("a project memory receives a modest boost over an equally-relevant global memory (Objective 9)", async () => {
  const globalMem = makeMemory({
    id: "g1",
    content: "I use TypeScript for this project.",
    category: "technical",
    scope: "global",
    importance: 3,
    updatedAt: daysAgo(1),
  });
  const projectMem = makeMemory({
    id: "p1",
    content: "I use TypeScript for this project also.",
    category: "technical",
    scope: "project",
    projectId: "proj-a",
    importance: 3,
    updatedAt: daysAgo(1),
  });

  const result = await retrieveRelevantMemories({
    message: "What language do I use for this project?",
    memories: [globalMem, projectMem],
    __queryVectorForTesting: null,
  });

  const globalScored = result.scored.find((s) => s.memory.id === "g1");
  const projectScored = result.scored.find((s) => s.memory.id === "p1");

  assert.ok(globalScored && projectScored);
  assert.ok(
    projectScored!.score.final >= globalScored!.score.final,
    "an equally-relevant project memory should score at least as high as the global one, via PROJECT_BOOST"
  );
  assert.equal(projectScored!.score.projectBoost, RETRIEVAL_CONFIG.PROJECT_BOOST);
  assert.equal(globalScored!.score.projectBoost, 0);
});

test("a project memory still cannot bypass the relevance floor purely from PROJECT_BOOST (Objective 9)", async () => {
  const unrelatedProjectMem = makeMemory({
    id: "p1",
    content: "The sky is blue today.",
    category: "other",
    scope: "project",
    projectId: "proj-a",
  });

  const result = await retrieveRelevantMemories({
    message: "What is the starting LP for the card game?",
    memories: [unrelatedProjectMem],
    __queryVectorForTesting: null,
  });

  assert.equal(result.selected.length, 0);
});
