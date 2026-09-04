// Memory v2E — split out of memoryEmbeddings.ts specifically to avoid a
// circular import: memoryRetriever.ts needs isEmbeddingStale() (to decide
// whether a memory's persisted vector is trustworthy for this query)
// without pulling in memoryEmbeddings.ts's memoryService.ts dependencies
// (getMemories/getMemoryById/setMemoryEmbedding), since memoryService.ts
// itself imports FROM memoryRetriever.ts (getMemoryContext calling
// retrieveRelevantMemories). This module only ever imports the
// MemoryRecord TYPE (erased at compile time, no runtime edge) plus
// EMBEDDING_MODEL, so it can sit under both memoryEmbeddings.ts and
// memoryRetriever.ts without either creating a cycle back to
// memoryService.ts.

import { EMBEDDING_MODEL } from "../providers/embeddingProvider";
import type { MemoryRecord } from "./memoryService";

// A record needs (re)embedding if it has never been embedded, or if it was
// embedded by a DIFFERENT model than the one currently configured
// (Objective 20) — comparing vectors produced by two different embedding
// models is meaningless, so a model change makes every existing embedding
// stale in one stroke, exactly like never having one.
export function isEmbeddingStale(record: Pick<MemoryRecord, "embedding" | "embeddingModel">): boolean {
  return !record.embedding || record.embeddingModel !== EMBEDDING_MODEL;
}
