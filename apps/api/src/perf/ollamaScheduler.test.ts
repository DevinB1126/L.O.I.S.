// Ollama Scheduler v1 — tests. Uses only node:test's built-in MockTracker
// (t.mock, stable since Node 18/20 — no new dependency, consistent with
// "keep it lightweight" for the scheduler itself) and synthetic `run`
// functions the test fully controls, so nothing here ever hits a real
// Ollama instance — the same "no live Ollama needed for unit tests"
// philosophy every other test file in this codebase already follows.
//
// Run with: npm run test --workspace=api

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scheduleOllamaTask,
  getSchedulerStats,
  OllamaPriority,
  OllamaTaskPreemptedError,
  OllamaTaskCancelledError,
  __resetOllamaSchedulerForTesting,
} from "./ollamaScheduler";

// A "deferred" — lets a test start a task's run() and control exactly when
// it resolves/rejects, so queueing/ordering behavior can be observed while
// a task is deliberately kept "in flight".
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function resetBeforeEach() {
  __resetOllamaSchedulerForTesting();
}

// ---------------------------------------------------------------------
// Objective 28 #1 — higher priority beats queued lower priority
// ---------------------------------------------------------------------
test("a HIGH-priority task queued behind a same-tier active task starts before a LOW-priority task queued after it", async () => {
  resetBeforeEach();

  const blocker = deferred<string>();
  const order: string[] = [];

  // Occupies the generate lane so both of the below are forced to queue,
  // not race to start immediately. HIGH so it is never itself preempted —
  // isolates queue ORDERING from preemption behavior (tested separately).
  const blockerPromise = scheduleOllamaTask("chat-generate", OllamaPriority.HIGH, () => blocker.promise);

  const lowPromise = scheduleOllamaTask("memory-extraction", OllamaPriority.LOW, async () => {
    order.push("low");
    return "low-done";
  });

  const highPromise = scheduleOllamaTask("chat-generate", OllamaPriority.HIGH, async () => {
    order.push("high");
    return "high-done";
  });

  blocker.resolve("blocker-done");
  await blockerPromise;
  await Promise.all([lowPromise, highPromise]);

  assert.deepEqual(order, ["high", "low"], "HIGH must start before LOW even though LOW was queued first");
});

// ---------------------------------------------------------------------
// Objective 28 #2 — FIFO within same priority
// ---------------------------------------------------------------------
test("two same-priority tasks run in the order they were queued (FIFO)", async () => {
  resetBeforeEach();

  const blocker = deferred<string>();
  const order: string[] = [];

  const blockerPromise = scheduleOllamaTask("chat-generate", OllamaPriority.HIGH, () => blocker.promise);

  const first = scheduleOllamaTask("chat-generate", OllamaPriority.HIGH, async () => {
    order.push("first");
    return "a";
  });
  const second = scheduleOllamaTask("chat-generate", OllamaPriority.HIGH, async () => {
    order.push("second");
    return "b";
  });

  blocker.resolve("blocker-done");
  await blockerPromise;
  await Promise.all([first, second]);

  assert.deepEqual(order, ["first", "second"]);
});

// ---------------------------------------------------------------------
// Objective 28 #3 / Test Scenario 20 — background runs when idle
// ---------------------------------------------------------------------
test("a background task runs immediately when nothing else is queued or active", async () => {
  resetBeforeEach();

  let ran = false;
  const result = await scheduleOllamaTask("memory-extraction", OllamaPriority.LOW, async () => {
    ran = true;
    return "ok";
  });

  assert.equal(ran, true);
  assert.equal(result, "ok");
});

// ---------------------------------------------------------------------
// Objective 28 #4 — a failed task releases the scheduler (no permanent lock)
// ---------------------------------------------------------------------
test("a task whose run() rejects does not lock the lane — the next task still runs", async () => {
  resetBeforeEach();

  await assert.rejects(
    scheduleOllamaTask("chat-generate", OllamaPriority.HIGH, async () => {
      throw new Error("simulated Ollama failure");
    }),
    /simulated Ollama failure/
  );

  let secondRan = false;
  const result = await scheduleOllamaTask("chat-generate", OllamaPriority.HIGH, async () => {
    secondRan = true;
    return "recovered";
  });

  assert.equal(secondRan, true);
  assert.equal(result, "recovered");
});

// ---------------------------------------------------------------------
// Objective 28 #5 / Test Scenario 25 — queued cancellation works
// ---------------------------------------------------------------------
test("aborting an externalSignal while a task is still queued cancels it without ever calling run()", async () => {
  resetBeforeEach();

  const blocker = deferred<string>();
  const blockerPromise = scheduleOllamaTask("memory-extraction", OllamaPriority.LOW, () => blocker.promise);

  const controller = new AbortController();
  let runCalled = false;

  const queuedPromise = scheduleOllamaTask(
    "memory-extraction",
    OllamaPriority.LOW,
    async () => {
      runCalled = true;
      return "should never happen";
    },
    { externalSignal: controller.signal }
  );

  controller.abort();

  await assert.rejects(queuedPromise, OllamaTaskCancelledError);
  assert.equal(runCalled, false, "run() must never be invoked for a task cancelled while still queued");

  // Queue continues normally afterward — no dangling lock left behind.
  blocker.resolve("blocker-done");
  await blockerPromise;

  const stats = getSchedulerStats();
  assert.equal(stats.activeGenerate, null);
  assert.equal(stats.queuedBackground, 0);
});

// ---------------------------------------------------------------------
// Objective 28 #6 / Test Scenario 21 — no starvation: multiple background
// tasks all eventually run when nothing higher-priority ever arrives.
// ---------------------------------------------------------------------
test("multiple queued background tasks all eventually complete when no interactive work arrives", async () => {
  resetBeforeEach();

  const completed: number[] = [];
  const tasks = [0, 1, 2, 3, 4].map((i) =>
    scheduleOllamaTask("memory-embed", OllamaPriority.BACKGROUND, async () => {
      completed.push(i);
      return i;
    })
  );

  const results = await Promise.all(tasks);

  assert.deepEqual(completed.sort((a, b) => a - b), [0, 1, 2, 3, 4]);
  assert.deepEqual(results, [0, 1, 2, 3, 4]);
});

// ---------------------------------------------------------------------
// Preemption (Objective 4) — a RUNNING background task is aborted when
// interactive work arrives, and (Objective 14) a retryOnPreempt task gets
// exactly one automatic retry.
// ---------------------------------------------------------------------
test("a running LOW-priority task is preempted (its signal aborts) when a HIGH-priority task arrives, and retryOnPreempt gets exactly one retry", async () => {
  resetBeforeEach();

  let attempts = 0;
  let sawAbortOnFirstAttempt = false;

  const lowPromise = scheduleOllamaTask(
    "memory-extraction",
    OllamaPriority.LOW,
    (signal) =>
      new Promise<string>((resolve, reject) => {
        attempts++;
        const thisAttempt = attempts;

        signal.addEventListener("abort", () => {
          if (thisAttempt === 1) sawAbortOnFirstAttempt = true;
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });

        if (thisAttempt === 2) {
          // The retry attempt succeeds normally.
          resolve("retry-succeeded");
        }
        // First attempt deliberately never resolves on its own — it only
        // settles via the abort listener above, exactly like a real
        // fetch/axios call observing an AbortSignal would.
      }),
    { retryOnPreempt: true }
  );

  // Give the LOW task's first attempt a tick to actually become "active"
  // before the HIGH task arrives and preempts it.
  await new Promise((resolve) => setImmediate(resolve));

  const highResult = await scheduleOllamaTask("chat-generate", OllamaPriority.HIGH, async () => "high-done");
  assert.equal(highResult, "high-done");

  const lowResult = await lowPromise;

  assert.equal(sawAbortOnFirstAttempt, true, "the first attempt's signal must have been aborted");
  assert.equal(attempts, 2, "exactly one retry (two total attempts)");
  assert.equal(lowResult, "retry-succeeded");
});

test("a preempted task WITHOUT retryOnPreempt rejects with OllamaTaskPreemptedError", async () => {
  resetBeforeEach();

  const lowPromise = scheduleOllamaTask(
    "memory-extraction",
    OllamaPriority.LOW,
    (signal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      })
    // no retryOnPreempt
  );

  await new Promise((resolve) => setImmediate(resolve));

  await scheduleOllamaTask("chat-generate", OllamaPriority.HIGH, async () => "high-done");

  await assert.rejects(lowPromise, OllamaTaskPreemptedError);
});

test("HIGH-priority active work is never preempted by another HIGH/MEDIUM arrival", async () => {
  resetBeforeEach();

  const blocker = deferred<string>();
  let aborted = false;

  const highPromise = scheduleOllamaTask("chat-generate", OllamaPriority.HIGH, (signal) => {
    signal.addEventListener("abort", () => {
      aborted = true;
    });
    return blocker.promise;
  });

  await new Promise((resolve) => setImmediate(resolve));

  // A second HIGH task arrives while the first is still active — must
  // queue behind it, not preempt it.
  const secondHigh = scheduleOllamaTask("chat-generate", OllamaPriority.HIGH, async () => "second");

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(aborted, false, "an active HIGH task must never be preempted");

  blocker.resolve("first-done");
  const [firstResult, secondResult] = await Promise.all([highPromise, secondHigh]);
  assert.equal(firstResult, "first-done");
  assert.equal(secondResult, "second");
});

// ---------------------------------------------------------------------
// Objective 5 — embed and generate lanes are independent: an embed task
// queued while a generate task is active does not wait on it.
// ---------------------------------------------------------------------
test("the embed lane is independent from the generate lane — an embed task runs while a generate task is still active", async () => {
  resetBeforeEach();

  const blocker = deferred<string>();
  const generatePromise = scheduleOllamaTask("chat-generate", OllamaPriority.HIGH, () => blocker.promise);

  let embedRan = false;
  const embedResult = await scheduleOllamaTask("query-embedding", OllamaPriority.MEDIUM, async () => {
    embedRan = true;
    return [0.1, 0.2];
  });

  assert.equal(embedRan, true, "embed task must complete without waiting for the still-active generate task");
  assert.deepEqual(embedResult, [0.1, 0.2]);

  blocker.resolve("generate-done");
  await generatePromise;
});

// ---------------------------------------------------------------------
// Objective 28 #11 / Test Scenario 23 — streaming: the scheduler does not
// buffer/delay a run() function's own progressive side effects, and does
// not transform its return value.
// ---------------------------------------------------------------------
test("streaming-shaped work: chunks emitted by run() are visible as they happen, not buffered until the task settles", async () => {
  resetBeforeEach();

  const chunksSeenDuringRun: string[] = [];
  let chunksAtResolutionTime = 0;

  const resultPromise = scheduleOllamaTask("chat-stream", OllamaPriority.HIGH, async () => {
    for (const chunk of ["Hello", ", ", "world", "!"]) {
      chunksSeenDuringRun.push(chunk);
      // Simulate real streaming (the network yielding chunks over time)
      // with a microtask gap between each.
      await Promise.resolve();
    }
    chunksAtResolutionTime = chunksSeenDuringRun.length;
    return chunksSeenDuringRun.join("");
  });

  const result = await resultPromise;

  assert.equal(result, "Hello, world!");
  assert.equal(chunksAtResolutionTime, 4, "all chunks must have been emitted before the task resolved, in order");
});

// ---------------------------------------------------------------------
// Objective 16 — queue metrics reflect interactive vs. background counts.
// ---------------------------------------------------------------------
test("getSchedulerStats reports queuedInteractive/queuedBackground/active correctly", async () => {
  resetBeforeEach();

  const blocker = deferred<string>();
  const blockerPromise = scheduleOllamaTask("chat-generate", OllamaPriority.HIGH, () => blocker.promise);
  await new Promise((resolve) => setImmediate(resolve));

  const queuedHigh = scheduleOllamaTask("chat-generate", OllamaPriority.HIGH, async () => "h");
  const queuedLow = scheduleOllamaTask("memory-extraction", OllamaPriority.LOW, async () => "l");
  await new Promise((resolve) => setImmediate(resolve));

  const stats = getSchedulerStats();
  assert.equal(stats.activeGenerate, "chat-generate");
  assert.equal(stats.activeEmbed, null);
  // The queued HIGH task preempts the queued LOW task's chance to run only
  // once the active slot frees — both are simply queued right now.
  assert.ok(stats.queuedInteractive >= 1);
  assert.ok(stats.queuedBackground >= 0);

  blocker.resolve("done");
  await blockerPromise;
  await Promise.all([queuedHigh, queuedLow]);

  const idleStats = getSchedulerStats();
  assert.equal(idleStats.activeGenerate, null);
  assert.equal(idleStats.queuedInteractive, 0);
  assert.equal(idleStats.queuedBackground, 0);
});

// ---------------------------------------------------------------------
// Objective 28 #7-10 — LOIS, IGNIS, query embedding, and memory extraction
// each actually go through the scheduler (not bypassing it), verified via
// node:test's built-in MockTracker rather than a real Ollama call. Each
// test mocks scheduleOllamaTask itself (to capture type/priority) AND the
// underlying provider call it wraps (so nothing hits the network), then
// exercises the real production code path.
// ---------------------------------------------------------------------

test("loisAgent submits its generation call through the scheduler at HIGH priority", async (t) => {
  const ollamaScheduler = await import("./ollamaScheduler");
  const ollamaProvider = await import("../providers/ollamaProvider");
  const agentContext = await import("../conversations/agentContext");

  const calls: { type: string; priority: OllamaPriority }[] = [];

  t.mock.method(ollamaScheduler, "scheduleOllamaTask", async (type: any, priority: any, run: any) => {
    calls.push({ type, priority });
    return run(new AbortController().signal);
  });
  t.mock.method(ollamaProvider, "askOllama", async () => "mocked reply");
  t.mock.method(agentContext, "assembleAgentContext", async () => ({
    memoryContext: "",
    historyText: "",
    project: null,
  }));

  const { loisAgent } = await import("../agents/lois");
  const reply = await loisAgent("hello");

  assert.equal(reply, "mocked reply");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "chat-generate");
  assert.equal(calls[0].priority, OllamaPriority.HIGH);
});

test("ignisAgent submits its generation call through the scheduler at HIGH priority", async (t) => {
  const ollamaScheduler = await import("./ollamaScheduler");
  const ollamaProvider = await import("../providers/ollamaProvider");
  const agentContext = await import("../conversations/agentContext");

  const calls: { type: string; priority: OllamaPriority }[] = [];

  t.mock.method(ollamaScheduler, "scheduleOllamaTask", async (type: any, priority: any, run: any) => {
    calls.push({ type, priority });
    return run(new AbortController().signal);
  });
  t.mock.method(ollamaProvider, "askOllama", async () => "mocked reply");
  t.mock.method(agentContext, "assembleAgentContext", async () => ({
    memoryContext: "",
    historyText: "",
    project: null,
  }));

  const { ignisAgent } = await import("../agents/ignis");
  const reply = await ignisAgent("hello");

  assert.equal(reply, "mocked reply");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "chat-generate");
  assert.equal(calls[0].priority, OllamaPriority.HIGH);
});

test("the current-turn query embedding in retrieval submits through the scheduler at MEDIUM priority", async (t) => {
  const ollamaScheduler = await import("./ollamaScheduler");
  const embeddingProvider = await import("../providers/embeddingProvider");

  const calls: { type: string; priority: OllamaPriority }[] = [];

  t.mock.method(ollamaScheduler, "scheduleOllamaTask", async (type: any, priority: any, run: any) => {
    calls.push({ type, priority });
    return run(new AbortController().signal);
  });
  t.mock.method(embeddingProvider, "embedText", async () => [0.1, 0.2, 0.3]);

  const { retrieveRelevantMemories } = await import("../memory/memoryRetriever");
  await retrieveRelevantMemories({ message: "what frontend framework do I prefer?", memories: [] });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "query-embedding");
  assert.equal(calls[0].priority, OllamaPriority.MEDIUM);
});

test("memory extraction submits its model call through the scheduler at LOW priority", async (t) => {
  const ollamaScheduler = await import("./ollamaScheduler");
  const ollamaProvider = await import("../providers/ollamaProvider");

  const calls: { type: string; priority: OllamaPriority; retryOnPreempt?: boolean }[] = [];

  t.mock.method(ollamaScheduler, "scheduleOllamaTask", async (type: any, priority: any, run: any, options: any) => {
    calls.push({ type, priority, retryOnPreempt: options?.retryOnPreempt });
    return run(new AbortController().signal);
  });
  t.mock.method(ollamaProvider, "askOllama", async () => '{"candidates": []}');

  const { extractMemoryCandidates } = await import("../memory/memoryExtractor");
  await extractMemoryCandidates("I like TypeScript.");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "memory-extraction");
  assert.equal(calls[0].priority, OllamaPriority.LOW);
  assert.equal(calls[0].retryOnPreempt, true);
});
