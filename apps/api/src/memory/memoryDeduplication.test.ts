// Unit tests for Memory v2B's non-embedding duplicate detection.
// Run with: npm run test --workspace=api

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeForComparison, findExactDuplicate, findNearDuplicate } from "./memoryDeduplication";
import type { MemoryRecord } from "./memoryService";

function makeMemory(content: string, id = content): MemoryRecord {
  return {
    id,
    content,
    category: "other",
    importance: 3,
    pinned: false,
    scope: "global",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    source: "user",
  };
}

test("normalizeForComparison lowercases, trims, collapses whitespace and strips trailing punctuation", () => {
  assert.equal(normalizeForComparison("  I  prefer   Dark Mode!!  "), "dark mode");
  assert.equal(normalizeForComparison("I like dark mode."), "dark mode");
  assert.equal(normalizeForComparison("My preference is dark mode."), "dark mode");
});

test("findExactDuplicate matches on normalized content, not raw string", () => {
  const existing = [makeMemory("I prefer dark mode.")];

  const match = findExactDuplicate("i LIKE dark mode", existing);
  assert.ok(match);
  assert.equal(match!.content, "I prefer dark mode.");

  const noMatch = findExactDuplicate("I prefer light mode.", existing);
  assert.equal(noMatch, undefined);
});

test("findNearDuplicate catches close paraphrases sharing most meaningful words", () => {
  const existing = [makeMemory("I prefer dark mode.")];

  const match = findNearDuplicate("My UI preference is dark mode.", existing);
  assert.ok(match, "close paraphrase should be caught as a near-duplicate");
});

test("findNearDuplicate does NOT flag related-but-distinct facts (Objective 10)", () => {
  const existing = [makeMemory("I primarily use TypeScript.")];

  const match = findNearDuplicate("I primarily use React.", existing);
  assert.equal(match, undefined, "different technologies must not be treated as duplicates");
});

test("findNearDuplicate does NOT flag distinct preferences in the same category", () => {
  const existing = [makeMemory("I prefer dark mode.")];

  const match = findNearDuplicate("I prefer blue UI accents.", existing);
  assert.equal(match, undefined);
});

test("findNearDuplicate does NOT treat a correction as a duplicate (Objective 18)", () => {
  const existing = [makeMemory("I prefer Vue.")];

  const match = findNearDuplicate("I actually prefer React.", existing);
  assert.equal(match, undefined, "conflicting preferences must not be silently merged");
});

test("findNearDuplicate ignores very short content to avoid noisy false positives", () => {
  const existing = [makeMemory("React.")];

  const match = findNearDuplicate("Redux.", existing);
  assert.equal(match, undefined);
});

// Usability pass regression coverage: the real reported gap was that
// "I prefer React for frontend work" / "I primarily use React for my
// projects" / "I like using React for frontend development" / "I prefer
// React" all got saved as four separate memories instead of being
// recognized as the same preference.

test("findNearDuplicate catches a bare subject statement against a longer descriptive memory (the reported React gap)", () => {
  const existing = [makeMemory("I prefer React for frontend work.")];

  const match = findNearDuplicate("I prefer React.", existing);
  assert.ok(match, "a short bare restatement of the same subject should be caught");
});

test("findNearDuplicate catches the reported React variants against each other, pairwise", () => {
  const variants = [
    "I prefer React for frontend work.",
    "I primarily use React for my projects.",
    "I like using React for frontend development.",
    "I prefer React.",
  ];

  for (let i = 0; i < variants.length; i++) {
    for (let j = 0; j < variants.length; j++) {
      if (i === j) continue;

      const existing = [makeMemory(variants[i], `existing-${i}`)];
      const match = findNearDuplicate(variants[j], existing);

      assert.ok(match, `"${variants[j]}" should be caught as a near-duplicate of "${variants[i]}"`);
    }
  }
});

test("findNearDuplicate still keeps different technologies distinct even as bare single-word statements", () => {
  const existing = [makeMemory("I prefer React.")];

  const match = findNearDuplicate("I prefer TypeScript.", existing);
  assert.equal(match, undefined, "React and TypeScript preferences must never be merged");
});

test("findNearDuplicate does not merge complementary facts about different technologies (Objective 5 example)", () => {
  const existing = [makeMemory("I prefer React for frontend development.")];

  const match = findNearDuplicate("I primarily use TypeScript for my projects.", existing);
  assert.equal(match, undefined);
});

test("findNearDuplicate does not merge related-but-distinct facts (Objective 5 example: dark interfaces vs favorite color)", () => {
  const existing = [makeMemory("I prefer dark interfaces.")];

  const match = findNearDuplicate("My favorite color is black.", existing);
  assert.equal(match, undefined);
});

test("findNearDuplicate does not treat job-role-distinguishing words as generic filler", () => {
  // Guards the new STOP_WORDS additions (use/using/projects/development)
  // against over-reaching: "frontend"/"backend"/"work" were deliberately
  // NOT added, because they can be the one word that makes two statements
  // genuinely different, not just differently phrased.
  const existing = [makeMemory("I work as a backend engineer.")];

  const match = findNearDuplicate("I work as a frontend engineer.", existing);
  assert.equal(match, undefined, "backend and frontend engineer roles must not be merged");
});
