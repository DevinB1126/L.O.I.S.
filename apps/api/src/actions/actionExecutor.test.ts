// Unit tests for the action executor. Always operates on a throwaway temp
// memory file via __setMemoryPathForTesting, exactly like
// memory/memoryService.test.ts — never the real memory.json.
//
// Run with: npm run test --workspace=api

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { __setMemoryPathForTesting, __resetMemoryPathForTesting, readMemory, completeGoal } from "../memory/memoryService";
import { executeAssistantAction } from "./actionExecutor";
import type { AssistantAction } from "./assistantAction";

function withTempMemoryFile(run: () => Promise<void> | void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lois-action-executor-test-"));
  const filePath = path.join(dir, "memory.json");
  __setMemoryPathForTesting(filePath);

  return Promise.resolve(run()).finally(() => {
    __resetMemoryPathForTesting();
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

// ============================================================
// calendar.create — the exact reported bug
// ============================================================

test("calendar.create actually persists a yearly recurring event (the reported birthday bug)", async () => {
  await withTempMemoryFile(async () => {
    const action: AssistantAction = {
      type: "calendar.create",
      payload: { title: "Devin's Birthday", date: "2026-03-20", recurrence: { frequency: "yearly", interval: 1 } },
    };

    const result = await executeAssistantAction(action);

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.match(result.message, /Devin's Birthday/);
    assert.match(result.message, /repeating every year/);

    // Real persistence check — not just trusting the ActionResult's own
    // claim (Step 9's whole point): read the file back independently.
    const stored = readMemory().calendar;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].title, "Devin's Birthday");
    assert.equal(stored[0].date, "2026-03-20");
    assert.deepEqual(stored[0].recurrence, { frequency: "yearly", interval: 1 });
    assert.equal(stored[0].dateText, "March 20"); // no year shown for a recurring event
  });
});

test("calendar.create persists a one-time (non-recurring) event with its year shown", async () => {
  await withTempMemoryFile(async () => {
    const result = await executeAssistantAction({
      type: "calendar.create",
      payload: { title: "Dentist", date: "2026-03-03", timeText: "2pm" },
    });

    assert.equal(result.success, true);
    const stored = readMemory().calendar;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].recurrence, undefined);
    assert.equal(stored[0].dateText, "March 3, 2026");
    assert.equal(stored[0].timeText, "2pm");
  });
});

test("does NOT create hundreds of duplicate records for a recurring event — exactly one record is stored", async () => {
  await withTempMemoryFile(async () => {
    await executeAssistantAction({
      type: "calendar.create",
      payload: { title: "Devin's Birthday", date: "2026-03-20", recurrence: { frequency: "yearly", interval: 1 } },
    });

    assert.equal(readMemory().calendar.length, 1);
  });
});

// ============================================================
// calendar.delete — unambiguous, ambiguous, and not-found
// ============================================================

test("calendar.delete removes the single matching event", async () => {
  await withTempMemoryFile(async () => {
    await executeAssistantAction({ type: "calendar.create", payload: { title: "Dentist Appointment", date: "2026-03-03" } });

    const result = await executeAssistantAction({ type: "calendar.delete", payload: { query: "dentist" } });

    assert.equal(result.success, true);
    assert.equal(readMemory().calendar.length, 0);
  });
});

test("calendar.delete asks for clarification instead of guessing when multiple events match (Step 21/22)", async () => {
  await withTempMemoryFile(async () => {
    await executeAssistantAction({ type: "calendar.create", payload: { title: "Team Meeting A", date: "2026-03-03" } });
    await executeAssistantAction({ type: "calendar.create", payload: { title: "Team Meeting B", date: "2026-03-04" } });

    const result = await executeAssistantAction({ type: "calendar.delete", payload: { query: "meeting" } });

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.status, "needs_clarification");
    if (result.status !== "needs_clarification") return;
    assert.equal(result.candidates?.length, 2);

    // Nothing was deleted while ambiguous.
    assert.equal(readMemory().calendar.length, 2);
  });
});

test("calendar.delete reports a real, honest failure when nothing matches", async () => {
  await withTempMemoryFile(async () => {
    const result = await executeAssistantAction({ type: "calendar.delete", payload: { query: "nonexistent" } });
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.status, "error");
  });
});

// ============================================================
// goal.create / goal.complete / goal.delete
// ============================================================

test("goal.create actually persists a goal and reports real success", async () => {
  await withTempMemoryFile(async () => {
    const result = await executeAssistantAction({ type: "goal.create", payload: { rawMessage: "Add a goal to finish the portfolio." } });

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.match(result.message, /finish the portfolio/i);

    const stored = readMemory().goals;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].completed, false);
  });
});

test("goal.create reports real failure (not fabricated success) for a duplicate goal", async () => {
  await withTempMemoryFile(async () => {
    await executeAssistantAction({ type: "goal.create", payload: { rawMessage: "Add a goal: finish the portfolio" } });
    const second = await executeAssistantAction({ type: "goal.create", payload: { rawMessage: "Add a goal: finish the portfolio" } });

    assert.equal(second.success, false);
    assert.equal(readMemory().goals.length, 1); // still exactly one, not duplicated
  });
});

test("goal.complete marks the matching goal complete and persists it", async () => {
  await withTempMemoryFile(async () => {
    await executeAssistantAction({ type: "goal.create", payload: { rawMessage: "Add a goal: finish the portfolio" } });

    const result = await executeAssistantAction({ type: "goal.complete", payload: { query: "portfolio" } });

    assert.equal(result.success, true);
    assert.equal(readMemory().goals[0].completed, true);
  });
});

test("goal.delete removes the matching goal", async () => {
  await withTempMemoryFile(async () => {
    await executeAssistantAction({ type: "goal.create", payload: { rawMessage: "Add a goal: finish the portfolio" } });

    const result = await executeAssistantAction({ type: "goal.delete", payload: { query: "portfolio" } });

    assert.equal(result.success, true);
    assert.equal(readMemory().goals.length, 0);
  });
});

// ============================================================
// memory.create
// ============================================================

test("memory.create actually persists a memory and reports real success", async () => {
  await withTempMemoryFile(async () => {
    const result = await executeAssistantAction({ type: "memory.create", payload: { rawMessage: "Remember that I prefer React." } });

    assert.equal(result.success, true);
    const stored = readMemory().memories;
    assert.equal(stored.length, 1);
    assert.match(stored[0].content, /React/);
  });
});

test("memory.create reports real failure for an exact duplicate, does not create a second record", async () => {
  await withTempMemoryFile(async () => {
    await executeAssistantAction({ type: "memory.create", payload: { rawMessage: "Remember that I prefer React." } });
    const second = await executeAssistantAction({ type: "memory.create", payload: { rawMessage: "Remember that I prefer React." } });

    assert.equal(second.success, false);
    assert.equal(readMemory().memories.length, 1);
  });
});

// ============================================================
// Step 25 #14 — malformed/degenerate input is rejected honestly, never
// silently guessed through or fabricated into a fake success.
// ============================================================

test("calendar.delete with an empty query reports failure rather than matching/deleting arbitrarily", async () => {
  await withTempMemoryFile(async () => {
    await executeAssistantAction({ type: "calendar.create", payload: { title: "Dentist", date: "2026-03-03" } });

    const result = await executeAssistantAction({ type: "calendar.delete", payload: { query: "" } });

    assert.equal(result.success, false);
    assert.equal(readMemory().calendar.length, 1); // nothing was touched
  });
});

test("goal.complete with an empty query reports failure rather than matching/completing arbitrarily", async () => {
  await withTempMemoryFile(async () => {
    await executeAssistantAction({ type: "goal.create", payload: { rawMessage: "Add a goal: finish the portfolio" } });

    const result = await executeAssistantAction({ type: "goal.complete", payload: { query: "" } });

    assert.equal(result.success, false);
    assert.equal(readMemory().goals[0].completed, false); // nothing was touched
  });
});

test("goal.create with an empty message reports failure, not a blank goal", async () => {
  await withTempMemoryFile(async () => {
    const result = await executeAssistantAction({ type: "goal.create", payload: { rawMessage: "add goal:" } });

    assert.equal(result.success, false);
    assert.equal(readMemory().goals.length, 0);
  });
});

// ============================================================
// goals.replace — the exact regression case from the reported failure
// (LOIS narrated a goal replacement that never actually happened)
// ============================================================

test("EXACT REGRESSION CASE — goals.replace atomically makes active goals equal exactly the requested list", async () => {
  await withTempMemoryFile(async () => {
    // Pre-existing active goals, exactly as reported: unrelated older goals
    // already present before the request.
    await executeAssistantAction({ type: "goal.create", payload: { rawMessage: "add goal: finish LOIS v1 with voice, goals, and calendar" } });
    await executeAssistantAction({
      type: "goal.create",
      payload: { rawMessage: "add goal: I'm building LOIS and IGNIS, and I want to use them as references" },
    });

    const result = await executeAssistantAction({
      type: "goals.replace",
      payload: {
        titles: [
          "Finish testing for the ValourTCG beta",
          "Find a career job for Computer Science",
          "Finish L.O.I.S./I.G.N.I.S. development",
        ],
      },
    });

    assert.equal(result.success, true, "ActionResult must report real success");
    if (!result.success) return;
    assert.match(result.message, /ValourTCG beta/);

    // Real persistence check, not the ActionResult's own claim.
    const active = readMemory().goals.filter((goal) => !goal.completed);
    assert.equal(active.length, 3, "old unrelated active goals must be gone, replaced by exactly the requested 3");
    assert.deepEqual(
      active.map((goal) => goal.title),
      [
        "Finish testing for the ValourTCG beta",
        "Find a career job for Computer Science",
        "Finish L.O.I.S./I.G.N.I.S. development",
      ]
    );
  });
});

test("goals.replace preserves completed goals as history (Objective 3) — never touches them", async () => {
  await withTempMemoryFile(async () => {
    await executeAssistantAction({ type: "goal.create", payload: { rawMessage: "add goal: an old finished goal" } });
    const beforeCompleted = readMemory().goals[0];
    completeGoal(beforeCompleted.id);

    await executeAssistantAction({ type: "goals.replace", payload: { titles: ["New goal A", "New goal B"] } });

    const after = readMemory().goals;
    const completed = after.find((goal) => goal.id === beforeCompleted.id);

    assert.ok(completed, "the completed goal must still exist");
    assert.equal(completed?.completed, true);
    assert.equal(completed?.title, "an old finished goal");
    assert.equal(after.filter((goal) => !goal.completed).length, 2);
  });
});

test("goals.replace preserves the id of an active goal whose title is unchanged (Objective 4)", async () => {
  await withTempMemoryFile(async () => {
    await executeAssistantAction({ type: "goal.create", payload: { rawMessage: "add goal: keep this one" } });
    const originalId = readMemory().goals[0].id;

    await executeAssistantAction({ type: "goals.replace", payload: { titles: ["keep this one", "a brand new goal"] } });

    const kept = readMemory().goals.find((goal) => goal.title === "keep this one");
    assert.equal(kept?.id, originalId, "an unchanged goal must keep its original id, not get a new one");
  });
});

test("goals.replace validation: rejects an empty list", async () => {
  await withTempMemoryFile(async () => {
    const result = await executeAssistantAction({ type: "goals.replace", payload: { titles: [] } });
    assert.equal(result.success, false);
  });
});

test("goals.replace validation: trims titles and removes exact duplicates", async () => {
  await withTempMemoryFile(async () => {
    const result = await executeAssistantAction({
      type: "goals.replace",
      payload: { titles: ["  Goal A  ", "Goal A", "Goal B"] },
    });

    assert.equal(result.success, true);
    const active = readMemory().goals.filter((goal) => !goal.completed);
    assert.equal(active.length, 2);
    assert.equal(active[0].title, "Goal A");
  });
});

test("goals.replace validation: rejects an all-empty-string list", async () => {
  await withTempMemoryFile(async () => {
    const result = await executeAssistantAction({ type: "goals.replace", payload: { titles: ["", "   "] } });
    assert.equal(result.success, false);
    assert.equal(readMemory().goals.length, 0);
  });
});

// Step 17 — a forced persistence failure must be reported honestly, never
// as fake success, and must not corrupt/partially-write state.
test("STEP 17 — a forced persistence failure is reported as a real failure, not fabricated success", async () => {
  const badPath = path.join(os.tmpdir(), `lois-action-executor-nonexistent-dir-${Date.now()}`, "memory.json");
  __setMemoryPathForTesting(badPath); // parent directory deliberately never created

  try {
    const result = await executeAssistantAction({ type: "goals.replace", payload: { titles: ["A", "B"] } });
    assert.equal(result.success, false, "must not report success when persistence genuinely fails");
  } finally {
    __resetMemoryPathForTesting();
  }
});
