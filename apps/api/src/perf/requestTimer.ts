// Performance Pass v1 — Phase 1 instrumentation.
//
// A lightweight, per-request timer threaded through the chat pipeline
// (server.ts -> agentRouter.ts -> agentContext.ts -> memoryRetriever.ts)
// so every stage of a single request can report how long IT took, without
// any stage needing to know about the others or about logging itself —
// each just calls `timer.mark("stageName")` when its own work finishes.
//
// Deliberately a plain object passed explicitly through function
// parameters (never a module-level/global timer) — this app handles
// concurrent requests, and a shared mutable timer would corrupt readings
// across simultaneous requests. One RequestTimer instance per request,
// created at the top of the route handler, is the only safe shape here.
//
// Never logs prompt/memory/message CONTENT — only stage names and
// millisecond durations (Objective/Phase 1: "Do not log full sensitive
// prompt contents unnecessarily").

export interface RequestTimer {
  /** Records how long has elapsed since the PREVIOUS mark (or since the
   *  timer was created, for the first mark) under `label`. Marks are
   *  cumulative-safe: calling mark() again under the same label overwrites
   *  it, so a stage that's measured in one place but conditionally skipped
   *  in another never leaves a stale/duplicate entry. */
  mark(label: string): void;
  /** Total elapsed time since the timer was created, in ms. */
  elapsedTotal(): number;
  /** Every mark recorded so far, in insertion order, as {label, ms}. */
  entries(): { label: string; ms: number }[];
}

export function createRequestTimer(): RequestTimer {
  const requestStart = process.hrtime.bigint();
  let lastMark = requestStart;
  const marks: { label: string; ms: number }[] = [];
  const indexByLabel = new Map<string, number>();

  function toMs(deltaNs: bigint): number {
    return Math.round((Number(deltaNs) / 1e6) * 100) / 100; // ms, 2dp
  }

  return {
    mark(label: string) {
      const now = process.hrtime.bigint();
      const ms = toMs(now - lastMark);
      lastMark = now;

      const existingIndex = indexByLabel.get(label);
      if (existingIndex !== undefined) {
        marks[existingIndex] = { label, ms };
      } else {
        indexByLabel.set(label, marks.length);
        marks.push({ label, ms });
      }
    },
    elapsedTotal() {
      return toMs(process.hrtime.bigint() - requestStart);
    },
    entries() {
      return [...marks];
    },
  };
}

// Formats a timer's marks into ONE concise, greppable log line, matching
// the task's own example shape ("[perf] agent=LOIS ... memoryLoad=3ms ...
// total=4696ms") — a single console.log call per request rather than one
// line per stage, so a request's full timing profile is always readable
// as one unit in the server log instead of interleaved with other
// concurrent requests' lines.
export function formatPerfLine(prefix: string, fields: Record<string, string | number>): string {
  const parts = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  return `${prefix} ${parts}`;
}
