// Unit tests for the pure/deterministic part of Memory v2E's embedding
// lifecycle logic. embedMemoryAsync/backfillMemoryEmbeddings call the real
// Ollama embedding endpoint and are deliberately NOT unit-tested here —
// same convention already established for memoryExtractor.ts's
// extractMemoryCandidates (LLM-calling code is exercised live, not
// mocked; only its deterministic parsing/validation is unit-tested).
// Live verification of the embedding lifecycle is covered separately.
//
// Run with: npm run test --workspace=api

import { test } from "node:test";
import assert from "node:assert/strict";
import { isEmbeddingStale } from "./memoryEmbeddings";
import { EMBEDDING_MODEL } from "../providers/embeddingProvider";

test("isEmbeddingStale: a record with no embedding at all is stale", () => {
  assert.equal(isEmbeddingStale({}), true);
  assert.equal(isEmbeddingStale({ embedding: undefined, embeddingModel: undefined }), true);
});

test("isEmbeddingStale: a record embedded by the current model is NOT stale", () => {
  assert.equal(isEmbeddingStale({ embedding: [0.1, 0.2, 0.3], embeddingModel: EMBEDDING_MODEL }), false);
});

test("isEmbeddingStale: a record embedded by a DIFFERENT model is stale (Objective 20)", () => {
  assert.equal(isEmbeddingStale({ embedding: [0.1, 0.2, 0.3], embeddingModel: "some-old-model" }), true);
});

test("isEmbeddingStale: an embedding vector present but no model recorded is stale", () => {
  assert.equal(isEmbeddingStale({ embedding: [0.1, 0.2, 0.3], embeddingModel: undefined }), true);
});
