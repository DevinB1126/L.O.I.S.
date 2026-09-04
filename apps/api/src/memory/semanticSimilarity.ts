// Memory v2E — a small, pure, independently-testable cosine similarity
// function (Objective 7). Deliberately has zero knowledge of MemoryRecord,
// Ollama, or retrieval scoring — just vector math — so it can be reasoned
// about and tested in complete isolation from everything that calls it.

/**
 * Cosine similarity between two vectors, in [-1, 1]. Returns 0 (never
 * throws, never returns NaN/Infinity) for any input that can't produce a
 * meaningful comparison: mismatched dimensions, a zero vector (magnitude
 * 0 — cosine similarity is undefined against it), empty input, or any
 * non-finite component. Callers (memoryRetriever.ts) treat 0 as "no
 * semantic signal for this pair," which is exactly the safe, inert value
 * for a score that gets added into a larger weighted sum.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];

    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;

    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  if (normA === 0 || normB === 0) return 0;

  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));

  // Floating-point error can push an otherwise-valid result a hair outside
  // [-1, 1] (e.g. 1.0000000000000002) — clamp rather than let that leak
  // into downstream math as a subtly-out-of-range weight.
  return Math.max(-1, Math.min(1, similarity));
}
