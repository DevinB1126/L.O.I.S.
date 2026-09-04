// Unit tests for Memory v2E's cosine similarity — pure vector math, no
// Ollama dependency. Run with: npm run test --workspace=api

import { test } from "node:test";
import assert from "node:assert/strict";
import { cosineSimilarity } from "./semanticSimilarity";

test("cosineSimilarity: identical vectors score 1", () => {
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
});

test("cosineSimilarity: orthogonal vectors score 0", () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test("cosineSimilarity: opposite vectors score -1", () => {
  assert.equal(cosineSimilarity([1, 2, 3], [-1, -2, -3]), -1);
});

test("cosineSimilarity: scale-invariant (same direction, different magnitude, still 1)", () => {
  assert.equal(cosineSimilarity([1, 2, 3], [2, 4, 6]), 1);
});

test("cosineSimilarity: a partially-aligned pair lands strictly between 0 and 1", () => {
  const score = cosineSimilarity([1, 1, 0], [1, 0, 0]);
  assert.ok(score > 0 && score < 1, `expected 0 < score < 1, got ${score}`);
});

test("cosineSimilarity: mismatched dimensions return 0, not a throw", () => {
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2]), 0);
});

test("cosineSimilarity: a zero vector returns 0 (undefined direction, not NaN)", () => {
  assert.equal(cosineSimilarity([0, 0, 0], [1, 2, 3]), 0);
  assert.equal(cosineSimilarity([1, 2, 3], [0, 0, 0]), 0);
  assert.equal(cosineSimilarity([0, 0], [0, 0]), 0);
});

test("cosineSimilarity: empty vectors return 0", () => {
  assert.equal(cosineSimilarity([], []), 0);
  assert.equal(cosineSimilarity([], [1, 2]), 0);
});

test("cosineSimilarity: non-finite components return 0 instead of NaN/Infinity", () => {
  assert.equal(cosineSimilarity([1, NaN, 3], [1, 2, 3]), 0);
  assert.equal(cosineSimilarity([1, Infinity, 3], [1, 2, 3]), 0);
  assert.equal(cosineSimilarity([1, 2, 3], [1, -Infinity, 3]), 0);
});

test("cosineSimilarity: non-array input returns 0 instead of throwing", () => {
  assert.equal(cosineSimilarity(null as unknown as number[], [1, 2]), 0);
  assert.equal(cosineSimilarity([1, 2], undefined as unknown as number[]), 0);
});

test("cosineSimilarity: result is always within [-1, 1]", () => {
  const a = [0.7, -0.3, 0.6, 0.1];
  const b = [0.2, 0.9, -0.4, 0.5];
  const score = cosineSimilarity(a, b);
  assert.ok(score >= -1 && score <= 1, `expected score in [-1,1], got ${score}`);
});
