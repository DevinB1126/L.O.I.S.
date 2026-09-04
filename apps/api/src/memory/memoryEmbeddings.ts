// Memory v2E — decides WHEN and HOW a memory's embedding gets (re)computed
// and persisted. Deliberately separate from embeddingProvider.ts (which
// only knows HTTP/response parsing) and from memoryService.ts (which only
// knows how to persist a vector once it exists, via setMemoryEmbedding) —
// this is the module that ties "a memory needs embedding" to "go get one
// and save it," including backfill and the async-vs-sync boundary that
// implies.

import {
  EMBEDDING_MODEL,
  embedText,
  embedTexts,
  EmbeddingRequestError,
  EmbeddingResponseError,
} from "../providers/embeddingProvider";
import { getMemories, getMemoryById, setMemoryEmbedding } from "./memoryService";
import { isEmbeddingStale } from "./embeddingStaleness";
import { scheduleOllamaTask, OllamaPriority } from "../perf/ollamaScheduler";

// Re-exported so existing/external callers of memoryEmbeddings.isEmbeddingStale
// keep working — the implementation lives in embeddingStaleness.ts purely to
// break a circular import with memoryRetriever.ts (see that file's header).
export { isEmbeddingStale };

// Re-reads the record synchronously (no `await` between the read and the
// write) right before persisting an embedding computed for `expectedContent`
// — if the content has since changed (an edit landed while the Ollama call
// was in flight) or the record was deleted, the result is discarded rather
// than silently re-attaching a vector that no longer describes the current
// text. This closes that race the same way the rest of this codebase
// reasons about synchronous mutation safety: the check and the write
// happen in the same synchronous tick, so nothing can interleave between
// them even though the embedding call itself was async.
function applyIfStillCurrent(id: string, expectedContent: string, vector: number[]): boolean {
  const current = getMemoryById(id);

  if (!current || current.content !== expectedContent) {
    return false;
  }

  return setMemoryEmbedding(id, vector, EMBEDDING_MODEL);
}

// Fire-and-forget entry point called right after a memory is created or
// its content is edited (Objective 4/14) — never called for a
// pinned/importance/category-only change, since the embedding input is
// content alone. Never throws: a failure here just leaves the memory
// without a current embedding until the next backfill sweep, which is the
// same "unavailable, fall back to lexical" posture retrieval itself takes
// (Objective 12).
export async function embedMemoryAsync(id: string): Promise<void> {
  const record = getMemoryById(id);
  if (!record) return; // already deleted

  try {
    // Ollama Scheduler v1 (Objective 1/29) — BACKGROUND priority (the
    // lowest tier): saving/re-embedding one memory is never something a
    // user is waiting on. retryOnPreempt so a preemption doesn't quietly
    // leave this memory without a vector any longer than necessary — it
    // falls back to lexical-only retrieval until this resolves either way.
    const vector = await scheduleOllamaTask(
      "memory-embed",
      OllamaPriority.BACKGROUND,
      (signal) => embedText(record.content, signal),
      { retryOnPreempt: true }
    );
    applyIfStillCurrent(id, record.content, vector);
  } catch (error) {
    console.warn(`[memory-embeddings] failed to embed memory ${id.slice(0, 8)}: ${describeEmbeddingError(error)}`);
  }
}

// How many memories get embedded in a single Ollama request during a
// backfill sweep. Chunked rather than one all-at-once batch so a single
// request stays a reasonable size as the store grows, and so one
// malformed/failed chunk doesn't lose progress already made on others.
const BACKFILL_BATCH_SIZE = 20;

export interface BackfillResult {
  attempted: number;
  succeeded: number;
}

// Lazy backfill (Objective 5): finds every memory lacking a current-model
// embedding and generates them in a small number of batched Ollama calls
// — never one request per memory (Objective 13). Intended to be called
// fire-and-forget from server.ts at startup (never blocks the server from
// listening) and is safe to call again later (e.g. after an
// EMBEDDING_MODEL change) since isEmbeddingStale is what decides the work
// list, not a one-time flag.
export async function backfillMemoryEmbeddings(): Promise<BackfillResult> {
  const stale = getMemories().filter(isEmbeddingStale);

  if (stale.length === 0) {
    return { attempted: 0, succeeded: 0 };
  }

  console.log(`[memory-embeddings] backfilling ${stale.length} memor${stale.length === 1 ? "y" : "ies"}...`);

  let succeeded = 0;

  for (let i = 0; i < stale.length; i += BACKFILL_BATCH_SIZE) {
    const chunk = stale.slice(i, i + BACKFILL_BATCH_SIZE);

    try {
      // Ollama Scheduler v1 — same BACKGROUND priority as embedMemoryAsync
      // above; this is a startup bulk sweep, the lowest-urgency workload in
      // the app. retryOnPreempt so a preempted chunk gets one automatic
      // retry rather than silently skipping memories that just happened to
      // be mid-batch when a chat request arrived — the existing per-chunk
      // catch below still handles a retry that also fails, exactly as it
      // already handled any other embedTexts failure.
      const vectors = await scheduleOllamaTask(
        "memory-embed",
        OllamaPriority.BACKGROUND,
        (signal) => embedTexts(chunk.map((memory) => memory.content), signal),
        { retryOnPreempt: true }
      );

      chunk.forEach((memory, index) => {
        if (applyIfStillCurrent(memory.id, memory.content, vectors[index])) {
          succeeded++;
        }
      });
    } catch (error) {
      console.warn(
        `[memory-embeddings] backfill batch failed (${chunk.length} memories skipped this pass): ${describeEmbeddingError(error)}`
      );
      // Move on to the next chunk — a transient failure on one batch
      // shouldn't abort progress on the rest of the sweep.
    }
  }

  console.log(`[memory-embeddings] backfill complete: ${succeeded}/${stale.length} embedded`);

  return { attempted: stale.length, succeeded };
}

function describeEmbeddingError(error: unknown): string {
  if (error instanceof EmbeddingRequestError || error instanceof EmbeddingResponseError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
