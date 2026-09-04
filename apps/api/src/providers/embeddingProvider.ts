// Memory v2E — local embedding generation via Ollama's /api/embed endpoint.
//
// Deliberately separate from ollamaProvider.ts (which owns the LOIS/IGNIS
// chat completion calls): embeddings are a different Ollama model, a
// different endpoint, and a different response shape, and Objective 1
// explicitly asks that the embedding model never be conflated with the
// chat model. This module owns HTTP + response parsing only — deciding
// WHEN a memory needs (re)embedding is memoryEmbeddings.ts's job, not
// this file's (Objective 2: "do not mix embedding parsing into
// memoryService.ts" applies just as much to keeping it out of the
// lifecycle-decision code).

import { PERF_CONFIG } from "../perf/perfConfig";

const OLLAMA_BASE_URL = "http://localhost:11434";
const OLLAMA_EMBED_URL = `${OLLAMA_BASE_URL}/api/embed`;

// The ONLY place this string is written — every other module that needs
// to know the embedding model name (memoryEmbeddings.ts, memoryRetriever.ts
// for stale-check comparisons, etc.) imports this constant instead of
// repeating it (Objective 1: "Do not scatter the model string throughout
// the project").
//
// nomic-embed-text: 274MB, 768-dimensional, purpose-built for retrieval
// (not the LOIS/IGNIS conversational model, llama3.1, which is not an
// embedding model). If this model is not installed, embedText/embedTexts
// reject with EmbeddingRequestError — callers must treat that as "semantic
// retrieval unavailable this run," never as a reason to crash or block
// chat (Objective 12).
//
// Install with: ollama pull nomic-embed-text
export const EMBEDDING_MODEL = "nomic-embed-text";

// A query embedding sits directly in the chat request's latency path
// (Objective 13), so it gets a real timeout rather than hanging
// indefinitely if Ollama is wedged. Empirically a single embed call takes
// well under 100ms locally; 5s is generous headroom, not a target.
const EMBEDDING_TIMEOUT_MS = 5000;

export class EmbeddingRequestError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "EmbeddingRequestError";
    this.status = status;
  }
}

export class EmbeddingResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingResponseError";
  }
}

type OllamaEmbedResponse = {
  embeddings?: unknown;
};

/** Embeds a single string. Convenience wrapper around embedTexts(). */
export async function embedText(text: string, signal?: AbortSignal): Promise<number[]> {
  const [vector] = await embedTexts([text], signal);
  return vector;
}

/**
 * Embeds one or more strings in a single Ollama request (Objective 6: one
 * request per call site, never one request per item in a loop). Throws
 * EmbeddingRequestError for connection/HTTP-level failures (including
 * timeout) and EmbeddingResponseError for a malformed/missing/wrong-shape
 * response — callers decide what "unavailable" means for them (skip this
 * memory, fall back to lexical-only, etc.); this function never silently
 * returns a wrong-shaped or partial result.
 *
 * Ollama Scheduler v1 (Objective 13) — `signal` is an OPTIONAL external
 * signal (e.g. from the scheduler) layered on top of the timeout below,
 * never a replacement for it: either one aborts the request, and the catch
 * block reports which actually happened rather than always blaming the
 * timeout.
 */
export async function embedTexts(texts: string[], signal?: AbortSignal): Promise<number[][]> {
  if (texts.length === 0) return [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);
  let timedOut = false;
  const onTimeout = () => {
    timedOut = true;
  };
  controller.signal.addEventListener("abort", onTimeout, { once: true });

  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });

  let response: Response;

  try {
    response = await fetch(OLLAMA_EMBED_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Performance Pass v1 (Objective 13) — nomic-embed-text is small
      // (~274MB, F16), unlike the ~4.9GB conversational model, so keeping
      // it resident for the same window costs little relative to the
      // latency it saves: without keep_alive it unloads on Ollama's own
      // 5-minute idle default just like the chat model does, and the next
      // query embedding (which sits directly in the chat request's
      // critical path — see EMBEDDING_TIMEOUT_MS above) pays a reload.
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts, keep_alive: PERF_CONFIG.MODEL_KEEP_ALIVE }),
      signal: controller.signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      if (timedOut) {
        throw new EmbeddingRequestError(`Ollama embedding request timed out after ${EMBEDDING_TIMEOUT_MS}ms`);
      }
      // Aborted by the caller-supplied signal (scheduler preemption or an
      // external cancellation), not by the timeout — rethrow as-is so
      // callers that check error.name === "AbortError" (the scheduler
      // included) can tell this apart from a genuine request failure.
      throw error;
    }

    const reason = error instanceof Error ? error.message : String(error);
    throw new EmbeddingRequestError(`Failed to reach Ollama at ${OLLAMA_EMBED_URL}: ${reason}`);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onExternalAbort);
  }

  if (!response.ok) {
    const bodyText = await safeReadText(response);
    throw new EmbeddingRequestError(
      `Ollama embedding request responded with status ${response.status}: ${bodyText || response.statusText}`,
      response.status
    );
  }

  let data: OllamaEmbedResponse;

  try {
    data = await response.json();
  } catch (error) {
    throw new EmbeddingResponseError("Ollama embedding response was not valid JSON");
  }

  const vectors = validateEmbeddingsShape(data.embeddings, texts.length);

  return vectors;
}

// Never trust the response shape blindly (mirrors askOllama/
// streamOllamaResponse's own "never trust Ollama's output" posture):
// missing field, wrong type, wrong count, non-numeric/non-finite entries,
// or an empty vector are all treated as EmbeddingResponseError rather than
// silently propagating a corrupt vector into cosine similarity math later.
function validateEmbeddingsShape(value: unknown, expectedCount: number): number[][] {
  if (!Array.isArray(value)) {
    throw new EmbeddingResponseError("Ollama embedding response was missing an 'embeddings' array");
  }

  if (value.length !== expectedCount) {
    throw new EmbeddingResponseError(
      `Ollama embedding response returned ${value.length} vector(s) for ${expectedCount} input(s)`
    );
  }

  const vectors: number[][] = [];

  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length === 0) {
      throw new EmbeddingResponseError("Ollama embedding response contained an empty or malformed vector");
    }

    for (const component of entry) {
      if (typeof component !== "number" || !Number.isFinite(component)) {
        throw new EmbeddingResponseError("Ollama embedding response contained a non-numeric vector component");
      }
    }

    vectors.push(entry as number[]);
  }

  return vectors;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
