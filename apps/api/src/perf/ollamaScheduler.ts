// Ollama Scheduler v1 — a single, central priority-aware coordination layer
// that every Ollama call in this app goes through, instead of each
// subsystem (chat generation, memory extraction, embeddings) calling Ollama
// independently with no awareness of anyone else's work.
//
// WHY THIS EXISTS (see the Performance Pass v1 final report): with
// keep_alive fixing the cold-model-reload problem, warm uncontended TTFT
// dropped to ~240ms — but warm TTFT could still spike to 50-57s when a
// chat request arrived while the PREVIOUS turn's fire-and-forget background
// memory-extraction call (its own /api/generate call, same llama3.1 model)
// was still running. Ollama serializes generation work against one model,
// so "fire-and-forget from the HTTP response's perspective" does not mean
// "free" from Ollama's perspective — it still occupies the one worker the
// next interactive request needs.
//
// MEASURED, NOT GUESSED (Objective 5): a live test firing a /api/embed
// request 300ms into a 61s /api/generate call showed the embed call
// completing in 38ms — indistinguishable from its normal uncontended
// latency (24-56ms, per the previous pass's measurements). Embeddings do
// NOT contend with generation on this Ollama install (separate model
// runners). Generation calls (chat and memory-extraction both hit
// /api/generate against the SAME llama3.1 model) DO serialize. This is why
// the scheduler below runs two independent concurrency lanes rather than
// one global gate — a design decision backed by that measurement, not an
// assumption.
//
// DESIGN: two lanes ("generate", "embed"), each with its own tiny priority
// queue and a concurrency limit of 1 (Objective 5 — Ollama serializes
// generation for real; embed calls are fast enough that lane concurrency
// >1 was never observed to matter and would only add complexity, Objective
// 6). Within a lane, the highest-priority queued task always runs next;
// ties are FIFO (Objective 3/7). A currently-RUNNING background-tier task
// (LOW/BACKGROUND) may be preempted (its AbortSignal fired) when an
// interactive-tier task (HIGH/MEDIUM) arrives and nothing higher is already
// running (Objective 4) — this was judged safe specifically because every
// background workload in this codebase (memory extraction, memory
// embedding) already treats any Ollama failure as non-fatal and recoverable
// (see memoryExtractor.ts/memoryEmbeddings.ts's own try/catch posture), so
// aborting one mid-flight cannot corrupt anything; it just means that
// attempt's work is redone. HIGH/MEDIUM tasks are never preempted.
//
// This module knows nothing about prompts, models, or embeddings — it only
// knows "here is an async function to run, with this priority, on this
// lane." All actual Ollama HTTP logic stays in ollamaProvider.ts /
// embeddingProvider.ts exactly as before; callers just submit their existing
// calls as a task instead of invoking the provider directly.

import { formatPerfLine } from "./requestTimer";

// Objective 2 — small, explicit priority model. Lower numeric value = runs
// first. HIGH/MEDIUM are "interactive" (this turn, the user is waiting);
// LOW/BACKGROUND are "background" (nobody is watching a spinner for this).
export enum OllamaPriority {
  HIGH = 0,
  MEDIUM = 1,
  LOW = 2,
  BACKGROUND = 3,
}

function priorityName(priority: OllamaPriority): string {
  return OllamaPriority[priority] ?? String(priority);
}

function isInteractive(priority: OllamaPriority): boolean {
  return priority === OllamaPriority.HIGH || priority === OllamaPriority.MEDIUM;
}

// Objective 1/29 — every current Ollama workload gets one type here, kept
// deliberately generic enough that a future workload (project summary,
// document embedding/indexing) is just one more type + lane mapping, not a
// new scheduler.
export type OllamaTaskType =
  | "chat-generate" // askOllama, non-streaming /chat (LOIS or IGNIS)
  | "chat-stream" // streamOllamaResponse, streaming /chat/stream (LOIS or IGNIS)
  | "query-embedding" // embedText for the CURRENT user message during retrieval
  | "memory-extraction" // askOllama inside extractMemoryCandidates (background)
  | "memory-embed"; // embedText/embedTexts for saving/backfilling memory vectors (background)

type Lane = "generate" | "embed";

// Objective 5 — which physical resource each task type actually contends
// for. chat-generate/chat-stream/memory-extraction all hit /api/generate
// against the one llama3.1 model, so they share a lane and a slot.
// query-embedding/memory-embed hit /api/embed against nomic-embed-text,
// measured not to contend with the generate lane, so they get their own.
const TASK_LANE: Record<OllamaTaskType, Lane> = {
  "chat-generate": "generate",
  "chat-stream": "generate",
  "memory-extraction": "generate",
  "query-embedding": "embed",
  "memory-embed": "embed",
};

const MAX_CONCURRENT: Record<Lane, number> = {
  generate: 1,
  embed: 1,
};

// Objective 6 — task shape, adapted to this codebase: `run` receives the
// AbortSignal the scheduler wants this attempt to observe (composed from
// preemption + any externalSignal the caller supplied), not a signal the
// caller has to manage itself.
export interface OllamaTask<T> {
  id: string;
  type: OllamaTaskType;
  priority: OllamaPriority;
  run: (signal: AbortSignal) => Promise<T>;
  createdAt: number;
}

export interface ScheduleOllamaTaskOptions {
  /** Ties this task's lifecycle to an existing external AbortSignal — e.g.
   *  an Express route's client-disconnect controller (Objective 13). If it
   *  fires while the task is still queued, the task is cancelled and its
   *  promise rejects immediately without ever running. If it fires while
   *  the task is running, the run()'s own signal is aborted exactly as a
   *  preemption would be. */
  externalSignal?: AbortSignal;
  /** LOW/BACKGROUND only (Objective 14) — if this task is preempted by
   *  higher-priority work before it settles, automatically re-queue ONE
   *  retry attempt at the same priority (never more than one). Because the
   *  priority queue always drains higher-priority work first, re-queueing
   *  immediately already has the effect of "runs once the system is idle" —
   *  no separate idle-detection timer is needed. Never applies to
   *  HIGH/MEDIUM tasks — interactive failures follow the caller's existing
   *  error handling, not this retry policy, even if this flag is
   *  mistakenly passed for one (asserted, see scheduleOllamaTask below). */
  retryOnPreempt?: boolean;
}

/** Thrown when the scheduler itself aborts a task's signal because
 *  higher-priority work needed the lane (as opposed to the task's own
 *  run() failing for an unrelated reason, or an externalSignal cancelling
 *  it). Only ever thrown for LOW/BACKGROUND tasks. */
export class OllamaTaskPreemptedError extends Error {
  constructor(taskId: string) {
    super(`Ollama task ${taskId} was preempted by higher-priority work`);
    this.name = "OllamaTaskPreemptedError";
  }
}

/** Thrown when a task is cancelled via externalSignal before it ever ran
 *  (still queued at the time the external signal fired). */
export class OllamaTaskCancelledError extends Error {
  constructor(taskId: string) {
    super(`Ollama task ${taskId} was cancelled before it started`);
    this.name = "OllamaTaskCancelledError";
  }
}

interface QueueEntry<T> {
  task: OllamaTask<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  controller: AbortController;
  options: ScheduleOllamaTaskOptions;
  retriesUsed: number;
  preempted: boolean;
}

interface LaneState {
  queue: QueueEntry<unknown>[];
  active: QueueEntry<unknown> | null;
}

const lanes: Record<Lane, LaneState> = {
  generate: { queue: [], active: null },
  embed: { queue: [], active: null },
};

let idCounter = 0;

/**
 * Submits one unit of Ollama work to the scheduler and resolves/rejects
 * exactly like calling `run()` directly would — the only difference is
 * WHEN `run()` actually starts, decided by priority + lane concurrency
 * (Objective 1/12: this never buffers or transforms the result itself).
 */
export function scheduleOllamaTask<T>(
  type: OllamaTaskType,
  priority: OllamaPriority,
  run: (signal: AbortSignal) => Promise<T>,
  options: ScheduleOllamaTaskOptions = {}
): Promise<T> {
  if (options.retryOnPreempt && isInteractive(priority)) {
    // Programmer error, not a runtime condition — fail loudly in
    // development rather than silently ignoring the flag.
    throw new Error(`retryOnPreempt is only valid for LOW/BACKGROUND tasks, not ${priorityName(priority)}`);
  }

  const id = `${type}-${++idCounter}`;
  const task: OllamaTask<T> = { id, type, priority, run, createdAt: Date.now() };

  return new Promise<T>((resolve, reject) => {
    const entry: QueueEntry<T> = {
      task,
      resolve,
      reject,
      controller: new AbortController(),
      options,
      retriesUsed: 0,
      preempted: false,
    };

    enqueue(entry);
  });
}

function enqueue<T>(entry: QueueEntry<T>): void {
  const lane = TASK_LANE[entry.task.type];
  const state = lanes[lane];

  if (entry.options.externalSignal) {
    if (entry.options.externalSignal.aborted) {
      // Already gone before we even queued it — never start it.
      entry.reject(new OllamaTaskCancelledError(entry.task.id));
      return;
    }

    entry.options.externalSignal.addEventListener(
      "abort",
      () => cancelOrAbort(lane, entry as QueueEntry<unknown>),
      { once: true }
    );
  }

  state.queue.push(entry as QueueEntry<unknown>);
  logQueueState(lane);
  maybePreempt(lane);
  drain(lane);
}

// Objective 4 — if the lane's currently-active task is background-tier and
// the new arrival is interactive-tier, and nothing interactive is already
// running, ask the active task to abort. Its own drain()-level .catch()
// handles the rest (marking it preempted, freeing the lane, optionally
// re-queueing it once per retryOnPreempt).
function maybePreempt(lane: Lane): void {
  const state = lanes[lane];
  const active = state.active;
  if (!active || active.preempted) return;
  if (isInteractive(active.task.priority)) return; // never preempt interactive work

  const hasInteractiveWaiting = state.queue.some((entry) => isInteractive(entry.task.priority));
  if (!hasInteractiveWaiting) return;

  active.preempted = true;
  active.controller.abort();
}

function cancelOrAbort(lane: Lane, entry: QueueEntry<unknown>): void {
  const state = lanes[lane];
  const queuedIndex = state.queue.indexOf(entry);

  if (queuedIndex !== -1) {
    state.queue.splice(queuedIndex, 1);
    entry.reject(new OllamaTaskCancelledError(entry.task.id));
    logQueueState(lane);
    return;
  }

  if (state.active === entry) {
    entry.controller.abort();
  }
}

function pickNext(lane: Lane): QueueEntry<unknown> | undefined {
  const state = lanes[lane];
  if (state.queue.length === 0) return undefined;

  let bestIndex = 0;
  for (let i = 1; i < state.queue.length; i++) {
    // Strictly lower (better) priority replaces the current best; equal
    // priority leaves the earlier-seen (earlier-queued) entry in place —
    // this is what gives FIFO ordering within a single priority tier
    // (Objective 3/7/19), since entries are always pushed in arrival order.
    if (state.queue[i].task.priority < state.queue[bestIndex].task.priority) {
      bestIndex = i;
    }
  }

  const [entry] = state.queue.splice(bestIndex, 1);
  return entry;
}

// Objective 17 — purely reactive: drain() is only ever invoked from
// enqueue() and from a just-settled task's own completion handler below,
// never from a loop or timer, so there is no busy-waiting or blocking of
// the Node event loop.
//
// IMPORTANT ordering note: bookkeeping (clearing `state.active`, logging,
// and pulling the next task via drain()) always happens BEFORE the
// caller's promise is resolved/rejected, in the SAME .then() reaction —
// never in a separate .finally() stage. A two-stage .then().catch().finally()
// chain settles the caller's promise (in .then/.catch) one microtask
// BEFORE .finally() runs its own cleanup, which would let an `await
// scheduleOllamaTask(...)` continuation observe stale scheduler state
// (e.g. getSchedulerStats() still showing the just-finished task as
// active) for one tick. Doing it in this order guarantees a caller never
// sees the scheduler in an inconsistent state.
function drain(lane: Lane): void {
  const state = lanes[lane];
  if (state.active || state.queue.length === 0) return;

  const entry = pickNext(lane);
  if (!entry) return;

  state.active = entry;
  logQueueState(lane);

  const startedAt = Date.now();
  const waitMs = startedAt - entry.task.createdAt;

  function settleAndDrain(): void {
    if (state.active === entry) {
      state.active = null;
    }
    logQueueState(lane);
    drain(lane);
  }

  entry.task.run(entry.controller.signal).then(
    (result) => {
      logCompletion(entry, waitMs, Date.now() - startedAt, "completed");
      settleAndDrain();
      entry.resolve(result);
    },
    (error) => {
      if (entry.preempted && entry.options.retryOnPreempt && entry.retriesUsed < 1) {
        logCompletion(entry, waitMs, Date.now() - startedAt, "preempted-retrying");
        settleAndDrain();
        requeueRetry(lane, entry);
        return;
      }

      const status = entry.preempted ? "preempted" : "failed";
      logCompletion(entry, waitMs, Date.now() - startedAt, status);
      settleAndDrain();
      entry.reject(entry.preempted ? new OllamaTaskPreemptedError(entry.task.id) : error);
    }
  );
}

function requeueRetry(lane: Lane, entry: QueueEntry<unknown>): void {
  const retryEntry: QueueEntry<unknown> = {
    task: { ...entry.task, createdAt: Date.now() }, // fresh wait-time baseline for the retry attempt
    resolve: entry.resolve,
    reject: entry.reject,
    controller: new AbortController(),
    options: entry.options,
    retriesUsed: entry.retriesUsed + 1,
    preempted: false,
  };

  if (entry.options.externalSignal && !entry.options.externalSignal.aborted) {
    entry.options.externalSignal.addEventListener("abort", () => cancelOrAbort(lane, retryEntry), { once: true });
  }

  lanes[lane].queue.push(retryEntry);
  logQueueState(lane);
}

// Objective 15 — one concise line per task settlement. Never logs prompt
// content, only identifiers/timings, matching every other [perf*] log line
// in this codebase.
function logCompletion(entry: QueueEntry<unknown>, waitMs: number, durationMs: number, status: string): void {
  console.log(
    formatPerfLine("[ollama-scheduler]", {
      id: entry.task.id,
      type: entry.task.type,
      priority: priorityName(entry.task.priority),
      wait: `${waitMs}ms`,
      duration: `${durationMs}ms`,
      status,
    })
  );
}

// Objective 16 — lightweight queue-state visibility, logged whenever it
// changes (enqueue, dequeue, task start/settle). Cheap: this app issues at
// most a handful of Ollama calls per chat turn, so log volume stays small.
function logQueueState(lane: Lane): void {
  const stats = getSchedulerStats();
  console.log(
    formatPerfLine("[ollama-scheduler-queue]", {
      lane,
      queuedInteractive: stats.queuedInteractive,
      queuedBackground: stats.queuedBackground,
      activeGenerate: stats.activeGenerate ?? "none",
      activeEmbed: stats.activeEmbed ?? "none",
    })
  );
}

export interface OllamaSchedulerStats {
  queuedInteractive: number;
  queuedBackground: number;
  activeGenerate: OllamaTaskType | null;
  activeEmbed: OllamaTaskType | null;
}

/** Objective 16 — exposed (not just logged) so tests and any future
 *  diagnostics endpoint can inspect scheduler state directly. */
export function getSchedulerStats(): OllamaSchedulerStats {
  const allQueued = [...lanes.generate.queue, ...lanes.embed.queue];

  return {
    queuedInteractive: allQueued.filter((entry) => isInteractive(entry.task.priority)).length,
    queuedBackground: allQueued.filter((entry) => !isInteractive(entry.task.priority)).length,
    activeGenerate: lanes.generate.active?.task.type ?? null,
    activeEmbed: lanes.embed.active?.task.type ?? null,
  };
}

/** Test-only escape hatch — resets all lanes to empty/idle. Never called
 *  from production code. */
export function __resetOllamaSchedulerForTesting(): void {
  for (const lane of Object.keys(lanes) as Lane[]) {
    lanes[lane].queue = [];
    lanes[lane].active = null;
  }
  idCounter = 0;
}
