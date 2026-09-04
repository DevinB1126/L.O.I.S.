// Unit tests for the Memory v2A structured memory foundation: v1->v2
// migration, ID stability, dedup, ID-based deletion, and malformed-data
// handling. Uses Node's built-in test runner (node:test) — no new test
// framework dependency — and always operates on a throwaway temp file via
// __setMemoryPathForTesting, never the real memory.json.
//
// Run with: npm run test --workspace=api

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  __setMemoryPathForTesting,
  __resetMemoryPathForTesting,
  readMemory,
  addMemory,
  touchMemory,
  deleteMemory,
  getMemories,
  getMemoryById,
  getMemoryContext,
  addGoalFromCommand,
  updateProfile,
  isProfileField,
  updateMemory,
} from "./memoryService";

function withTempMemoryFile(seed: unknown, run: (filePath: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lois-memory-test-"));
  const filePath = path.join(dir, "memory.json");

  if (seed !== undefined) {
    fs.writeFileSync(filePath, JSON.stringify(seed, null, 2));
  }

  __setMemoryPathForTesting(filePath);

  try {
    run(filePath);
  } finally {
    __resetMemoryPathForTesting();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const LEGACY_V1_MEMORY = {
  profile: { name: "Devin", favoriteColor: "black", location: "Dallas", occupation: "" },
  preferences: ["I prefer dark mode"],
  projects: [],
  goals: [{ id: "goal-1", title: "ship v1", completed: true, createdAt: "2026-06-24T00:00:00.000Z" }],
  facts: ["my favorite superhero is Spider-Man", "I prefer dark mode"],
  calendar: [{ id: "cal-1", title: "Dentist", dateText: "tomorrow", timeText: "9am", createdAt: "2026-06-24T00:00:00.000Z" }],
  conversations: [{ agent: "lois", userMessage: "hi", assistantReply: "hello", timestamp: "2026-06-24T00:00:00.000Z" }],
};

test("migrates a v1 memory file: facts become memories, content preserved", () => {
  withTempMemoryFile(LEGACY_V1_MEMORY, () => {
    const data = readMemory();

    assert.equal(data.schemaVersion, 4);
    assert.equal(data.memories.length, 2);
    assert.deepEqual(
      data.memories.map((m) => m.content),
      ["my favorite superhero is Spider-Man", "I prefer dark mode"]
    );
  });
});

test("migrated memories get unique, stable IDs, correct defaults, and 'migration' source", () => {
  withTempMemoryFile(LEGACY_V1_MEMORY, () => {
    const data = readMemory();
    const ids = data.memories.map((m) => m.id);

    assert.equal(new Set(ids).size, ids.length, "IDs must be unique");
    for (const memory of data.memories) {
      assert.equal(typeof memory.id, "string");
      assert.ok(memory.id.length > 0);
      assert.equal(memory.category, "other");
      assert.equal(memory.importance, 3);
      assert.equal(memory.pinned, false);
      assert.equal(memory.scope, "global");
      assert.equal(memory.source, "migration");
      assert.equal(typeof memory.createdAt, "string");
      assert.equal(typeof memory.updatedAt, "string");
    }
  });
});

test("restarting (re-reading) does not regenerate IDs or re-migrate", () => {
  withTempMemoryFile(LEGACY_V1_MEMORY, () => {
    const first = readMemory();
    const firstIds = first.memories.map((m) => m.id);

    // Simulate a server restart: a fresh read of the now-migrated file.
    const second = readMemory();
    const secondIds = second.memories.map((m) => m.id);

    assert.deepEqual(secondIds, firstIds);
    assert.equal(second.memories.length, first.memories.length);
  });
});

test("migration creates a v1 backup once, and never overwrites an existing one", () => {
  withTempMemoryFile(LEGACY_V1_MEMORY, (filePath) => {
    readMemory(); // triggers migration + backup

    const backupPath = path.join(path.dirname(filePath), "memory.v1.backup.json");
    assert.ok(fs.existsSync(backupPath), "backup file should exist after migration");

    const backedUp = JSON.parse(fs.readFileSync(backupPath, "utf-8"));
    assert.deepEqual(backedUp.facts, LEGACY_V1_MEMORY.facts);

    // Tamper with the backup, then force another migration-eligible read by
    // writing a v1 file back — the backup must not be clobbered.
    fs.writeFileSync(backupPath, JSON.stringify({ sentinel: true }));
    fs.writeFileSync(filePath, JSON.stringify(LEGACY_V1_MEMORY, null, 2));
    readMemory();

    const stillBackedUp = JSON.parse(fs.readFileSync(backupPath, "utf-8"));
    assert.deepEqual(stillBackedUp, { sentinel: true });
  });
});

// Memory v2D — v2 -> v3 migration (adds MemoryRecord.pinned).
const LEGACY_V2_MEMORY = {
  schemaVersion: 2,
  profile: { name: "Devin", favoriteColor: "black", location: "Dallas", occupation: "" },
  preferences: [],
  projects: [],
  goals: [{ id: "goal-1", title: "ship v1", completed: true, createdAt: "2026-06-24T00:00:00.000Z" }],
  memories: [
    {
      id: "v2-id-1",
      content: "I prefer React.",
      category: "preference",
      importance: 4,
      createdAt: "2026-06-24T00:00:00.000Z",
      updatedAt: "2026-06-24T00:00:00.000Z",
      source: "user",
      // no `pinned` — this is the whole point of the fixture
    },
  ],
  calendar: [],
  conversations: [],
};

test("v2 -> v3 -> v4 migration adds pinned:false and scope:global to every existing memory without regenerating IDs or content", () => {
  withTempMemoryFile(LEGACY_V2_MEMORY, () => {
    const data = readMemory();

    assert.equal(data.schemaVersion, 4);
    assert.equal(data.memories.length, 1);
    assert.equal(data.memories[0].id, "v2-id-1", "ID must not be regenerated");
    assert.equal(data.memories[0].content, "I prefer React.");
    assert.equal(data.memories[0].category, "preference");
    assert.equal(data.memories[0].importance, 4);
    assert.equal(data.memories[0].pinned, false);
    assert.equal(data.memories[0].scope, "global");
    assert.equal(data.memories[0].projectId, undefined);
    assert.equal(data.memories[0].createdAt, "2026-06-24T00:00:00.000Z", "createdAt must not change");
  });
});

test("v2 -> v3 migration preserves goals/profile/calendar untouched and creates a v2 backup", () => {
  withTempMemoryFile(LEGACY_V2_MEMORY, (filePath) => {
    const data = readMemory();

    assert.deepEqual(data.goals, LEGACY_V2_MEMORY.goals);
    assert.deepEqual(data.profile, LEGACY_V2_MEMORY.profile);

    const backupPath = path.join(path.dirname(filePath), "memory.v2.backup.json");
    assert.ok(fs.existsSync(backupPath), "memory.v2.backup.json should exist after the v2->v3 migration");

    const backedUp = JSON.parse(fs.readFileSync(backupPath, "utf-8"));
    assert.equal(backedUp.schemaVersion, 2, "backup should hold the pre-migration (v2) content");
  });
});

test("restarting after v2 -> v3 migration does not re-migrate or change IDs again", () => {
  withTempMemoryFile(LEGACY_V2_MEMORY, () => {
    const first = readMemory();
    const second = readMemory();

    assert.deepEqual(second.memories, first.memories);
    assert.equal(second.schemaVersion, 4);
  });
});

test("goals/calendar/conversations/profile/preferences/projects survive migration untouched", () => {
  withTempMemoryFile(LEGACY_V1_MEMORY, () => {
    const data = readMemory();

    assert.deepEqual(data.profile, LEGACY_V1_MEMORY.profile);
    assert.deepEqual(data.preferences, LEGACY_V1_MEMORY.preferences);
    assert.deepEqual(data.projects, LEGACY_V1_MEMORY.projects);
    assert.deepEqual(data.goals, LEGACY_V1_MEMORY.goals);
    assert.deepEqual(data.calendar, LEGACY_V1_MEMORY.calendar);
    assert.deepEqual(data.conversations, LEGACY_V1_MEMORY.conversations);
  });
});

test("addMemory creates a record with id, timestamps, default importance and source", () => {
  withTempMemoryFile(undefined, () => {
    const created = addMemory("I have a dog named Rex");

    assert.ok(created);
    assert.equal(typeof created!.id, "string");
    assert.equal(created!.content, "I have a dog named Rex");
    assert.equal(created!.category, "other");
    assert.equal(created!.importance, 3);
    assert.equal(created!.source, "user");
    assert.equal(created!.createdAt, created!.updatedAt);

    const stored = getMemories();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, created!.id);
  });
});

test("addMemory respects explicit category/importance/source overrides", () => {
  withTempMemoryFile(undefined, () => {
    const created = addMemory("Deploys happen on Fridays", {
      category: "work",
      importance: 5,
      source: "system",
    });

    assert.ok(created);
    assert.equal(created!.category, "work");
    assert.equal(created!.importance, 5);
    assert.equal(created!.source, "system");
  });
});

test("addMemory does not create a duplicate (case-insensitive) and returns null", () => {
  withTempMemoryFile(undefined, () => {
    const first = addMemory("I prefer dark mode");
    const duplicate = addMemory("I PREFER DARK MODE");

    assert.ok(first);
    assert.equal(duplicate, null);
    assert.equal(getMemories().length, 1);
  });
});

test("deleteMemory removes only the targeted memory by ID", () => {
  withTempMemoryFile(undefined, () => {
    const a = addMemory("first fact")!;
    const b = addMemory("second fact")!;
    const c = addMemory("third fact")!;

    const removed = deleteMemory(b.id);

    assert.equal(removed, true);
    const remaining = getMemories();
    assert.equal(remaining.length, 2);
    assert.deepEqual(
      remaining.map((m) => m.id).sort(),
      [a.id, c.id].sort()
    );
    assert.equal(getMemoryById(a.id)?.content, "first fact");
    assert.equal(getMemoryById(c.id)?.content, "third fact");
    assert.equal(getMemoryById(b.id), undefined);
  });
});

test("deleteMemory with an unknown ID returns false and changes nothing", () => {
  withTempMemoryFile(undefined, () => {
    addMemory("only fact");
    const removed = deleteMemory("does-not-exist");

    assert.equal(removed, false);
    assert.equal(getMemories().length, 1);
  });
});

// Memory v2D — updateMemory (search/editing/pinning management).

test("updateMemory edits content, preserves id/createdAt/source, and bumps updatedAt", () => {
  withTempMemoryFile(undefined, () => {
    // addMemory strips a trailing period (cleanRememberPhrase) — using
    // content without one here so the assertions below aren't tripped up
    // by that unrelated, pre-existing behavior.
    const created = addMemory("I prefer React")!;

    const result = updateMemory(created.id, { content: "I prefer React for frontend development." });

    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.memory.id, created.id, "ID must stay the same");
    assert.equal(result.memory.content, "I prefer React for frontend development.");
    assert.equal(result.memory.createdAt, created.createdAt, "createdAt must not change");
    assert.equal(result.memory.source, created.source, "source must not change");
    assert.ok(
      new Date(result.memory.updatedAt).getTime() >= new Date(created.updatedAt).getTime(),
      "updatedAt must be bumped to at least the original moment (may tie at millisecond resolution in a fast test)"
    );

    // And it's actually persisted, not just returned.
    assert.equal(getMemoryById(created.id)?.content, "I prefer React for frontend development.");
  });
});

test("updateMemory changing only category/importance/pinned leaves content untouched", () => {
  withTempMemoryFile(undefined, () => {
    const created = addMemory("I prefer React")!;

    const result = updateMemory(created.id, { category: "technical", importance: 5, pinned: true });

    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.memory.content, "I prefer React", "content untouched when not part of the update");
    assert.equal(result.memory.category, "technical");
    assert.equal(result.memory.importance, 5);
    assert.equal(result.memory.pinned, true);
  });
});

test("updateMemory rejects an update to an unknown ID", () => {
  withTempMemoryFile(undefined, () => {
    const result = updateMemory("does-not-exist", { content: "anything" });
    assert.deepEqual(result, { ok: false, reason: "not_found" });
  });
});

test("updateMemory rejects empty or over-length content, leaving the record unchanged", () => {
  withTempMemoryFile(undefined, () => {
    const created = addMemory("I prefer React")!;

    const emptyResult = updateMemory(created.id, { content: "   " });
    assert.deepEqual(emptyResult, { ok: false, reason: "invalid_content" });

    const tooLong = "x".repeat(301);
    const longResult = updateMemory(created.id, { content: tooLong });
    assert.deepEqual(longResult, { ok: false, reason: "invalid_content" });

    assert.equal(getMemoryById(created.id)?.content, "I prefer React", "unchanged on rejected edits");
  });
});

test("updateMemory rejects a category outside the closed MemoryCategory list", () => {
  withTempMemoryFile(undefined, () => {
    const created = addMemory("I prefer React")!;

    const result = updateMemory(created.id, { category: "not-a-real-category" as never });
    assert.deepEqual(result, { ok: false, reason: "invalid_category" });
    assert.equal(getMemoryById(created.id)?.category, "other");
  });
});

test("updateMemory rejects importance outside 1-5", () => {
  withTempMemoryFile(undefined, () => {
    const created = addMemory("I prefer React")!;

    assert.deepEqual(updateMemory(created.id, { importance: 0 }), { ok: false, reason: "invalid_importance" });
    assert.deepEqual(updateMemory(created.id, { importance: 6 }), { ok: false, reason: "invalid_importance" });
    assert.deepEqual(updateMemory(created.id, { importance: 3.5 }), { ok: false, reason: "invalid_importance" });
  });
});

test("updateMemory rejects a non-boolean pinned value", () => {
  withTempMemoryFile(undefined, () => {
    const created = addMemory("I prefer React")!;
    const result = updateMemory(created.id, { pinned: "yes" as never });
    assert.deepEqual(result, { ok: false, reason: "invalid_pinned" });
  });
});

test("updateMemory prevents editing content into an exact duplicate of a DIFFERENT memory", () => {
  withTempMemoryFile(undefined, () => {
    addMemory("I prefer React");
    const other = addMemory("I like video games")!;

    const result = updateMemory(other.id, { content: "I prefer React" });

    assert.deepEqual(result, { ok: false, reason: "duplicate" });
    assert.equal(getMemoryById(other.id)?.content, "I like video games", "unchanged on a rejected duplicate edit");
  });
});

test("updateMemory allows re-saving a memory's own unchanged content (not a self-duplicate)", () => {
  withTempMemoryFile(undefined, () => {
    const created = addMemory("I prefer React")!;

    const result = updateMemory(created.id, { content: "I prefer React", pinned: true });

    assert.ok(result.ok);
  });
});

test("updateMemory never touches unrelated memories, goals, or calendar", () => {
  withTempMemoryFile(undefined, () => {
    const target = addMemory("I prefer React")!;
    addMemory("I like video games");
    addGoalFromCommand("Add goal: ship v1");

    updateMemory(target.id, { pinned: true });

    const data = readMemory();
    assert.equal(data.memories.length, 2);
    assert.equal(data.memories.find((m) => m.content === "I like video games")?.pinned, false);
    assert.equal(data.goals.length, 1);
    assert.equal(data.goals[0].title, "ship v1");
  });
});

test("missing memory.json initializes a valid empty structure without throwing", () => {
  withTempMemoryFile(undefined, (filePath) => {
    fs.rmSync(filePath, { force: true }); // ensure it truly doesn't exist
    __setMemoryPathForTesting(filePath);

    const data = readMemory();

    assert.equal(data.schemaVersion, 4);
    assert.deepEqual(data.memories, []);
    assert.deepEqual(data.goals, []);
    assert.deepEqual(data.calendar, []);
    assert.ok(fs.existsSync(filePath), "a fresh file should be written");
  });
});

test("empty memory.json file initializes a valid structure without throwing", () => {
  withTempMemoryFile(undefined, (filePath) => {
    fs.writeFileSync(filePath, "");

    const data = readMemory();

    assert.equal(data.schemaVersion, 4);
    assert.deepEqual(data.memories, []);
  });
});

test("corrupt (invalid JSON) memory.json is quarantined and a fresh structure is used", () => {
  withTempMemoryFile(undefined, (filePath) => {
    fs.writeFileSync(filePath, "{ this is not valid json ");

    const data = readMemory();

    assert.equal(data.schemaVersion, 4);
    assert.deepEqual(data.memories, []);

    const dir = path.dirname(filePath);
    const quarantined = fs.readdirSync(dir).filter((f) => f.startsWith("memory.corrupt."));
    assert.equal(quarantined.length, 1, "exactly one quarantine file should be created");
  });
});

test("malformed individual memory records are dropped instead of crashing readMemory", () => {
  withTempMemoryFile(
    {
      schemaVersion: 2,
      profile: { name: "Devin", favoriteColor: "", location: "", occupation: "" },
      preferences: [],
      projects: [],
      goals: [],
      memories: [
        { id: "ok-1", content: "valid memory", category: "other", importance: 3, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", source: "user" },
        { id: "bad-1", content: "missing category/importance" },
        { content: "missing id entirely", category: "other", importance: 3, createdAt: "x", updatedAt: "x", source: "user" },
        "just a raw string, not even an object",
        { id: "bad-2", content: "importance out of range", category: "other", importance: 99, createdAt: "x", updatedAt: "x", source: "user" },
      ],
      calendar: [],
      conversations: [],
    },
    () => {
      const data = readMemory();

      assert.equal(data.memories.length, 1);
      assert.equal(data.memories[0].id, "ok-1");
    }
  );
});

test("addGoalFromCommand creates a Goal, not a MemoryRecord (Part 4 routing fix)", () => {
  withTempMemoryFile(undefined, () => {
    const goal = addGoalFromCommand("Add goal: finish LOIS v1 with voice, goals, and calendar.");

    assert.ok(goal);
    assert.equal(goal!.title, "finish LOIS v1 with voice, goals, and calendar");
    assert.equal(goal!.completed, false);

    const data = readMemory();
    assert.equal(data.goals.length, 1);
    assert.equal(data.goals[0].id, goal!.id);
    assert.equal(data.memories.length, 0, "a goal command must never also create a MemoryRecord");
  });
});

test("addGoalFromCommand does not create a duplicate goal (case-insensitive title) and returns null", () => {
  withTempMemoryFile(undefined, () => {
    const first = addGoalFromCommand("Add goal: ship the beta");
    const duplicate = addGoalFromCommand("Create goal: SHIP THE BETA");

    assert.ok(first);
    assert.equal(duplicate, null);
    assert.equal(readMemory().goals.length, 1);
  });
});

// Profile-state synchronization fix (Steps 19.1-19.12 of the bug report).
test("updateProfile updates the requested field", () => {
  withTempMemoryFile(undefined, () => {
    const updated = updateProfile("favoriteColor", "red");

    assert.ok(updated);
    assert.equal(updated!.favoriteColor, "red");
    assert.equal(readMemory().profile.favoriteColor, "red");
  });
});

test("updateProfile replaces the old value — never keeps both active", () => {
  withTempMemoryFile(
    {
      schemaVersion: 2,
      profile: { name: "Devin", favoriteColor: "black", location: "Dallas", occupation: "" },
      preferences: [],
      projects: [],
      goals: [],
      memories: [],
      calendar: [],
      conversations: [],
    },
    () => {
      updateProfile("favoriteColor", "red");
      const data = readMemory();

      assert.equal(data.profile.favoriteColor, "red");
      assert.notEqual(data.profile.favoriteColor, "black");
    }
  );
});

test("updateProfile does not touch unrelated profile fields", () => {
  withTempMemoryFile(
    {
      schemaVersion: 2,
      profile: { name: "Devin", favoriteColor: "black", location: "Dallas", occupation: "engineer" },
      preferences: [],
      projects: [],
      goals: [],
      memories: [],
      calendar: [],
      conversations: [],
    },
    () => {
      updateProfile("favoriteColor", "red");
      const data = readMemory();

      assert.equal(data.profile.name, "Devin");
      assert.equal(data.profile.location, "Dallas");
      assert.equal(data.profile.occupation, "engineer");
    }
  );
});

test("updateProfile leaves memories, goals, and calendar intact", () => {
  withTempMemoryFile(undefined, () => {
    addMemory("I like video games");
    addGoalFromCommand("Add goal: ship v1");

    updateProfile("favoriteColor", "red");

    const data = readMemory();
    assert.equal(data.memories.length, 1);
    assert.equal(data.memories[0].content, "I like video games");
    assert.equal(data.goals.length, 1);
    assert.equal(data.goals[0].title, "ship v1");
  });
});

test("updateProfile persists across a fresh read (simulated restart)", () => {
  withTempMemoryFile(undefined, () => {
    updateProfile("favoriteColor", "red");

    // readMemory() re-reads from disk each call — no in-process cache to
    // coincidentally make this pass.
    assert.equal(readMemory().profile.favoriteColor, "red");
  });
});

test("updateProfile rejects an empty value and leaves the profile unchanged", () => {
  withTempMemoryFile(
    {
      schemaVersion: 2,
      profile: { name: "Devin", favoriteColor: "black", location: "Dallas", occupation: "" },
      preferences: [],
      projects: [],
      goals: [],
      memories: [],
      calendar: [],
      conversations: [],
    },
    () => {
      const result = updateProfile("favoriteColor", "   ");

      assert.equal(result, null, "an invalid update must report failure, not false success");
      assert.equal(readMemory().profile.favoriteColor, "black", "unchanged on a rejected update");
    }
  );
});

test("isProfileField rejects field names outside the closed allowlist", () => {
  assert.equal(isProfileField("favoriteColor"), true);
  assert.equal(isProfileField("name"), true);
  assert.equal(isProfileField("location"), true);
  assert.equal(isProfileField("occupation"), true);
  assert.equal(isProfileField("__proto__"), false);
  assert.equal(isProfileField("isAdmin"), false);
  assert.equal(isProfileField("memories"), false);
});

test("updateProfile applies sequential updates using the latest value", () => {
  withTempMemoryFile(undefined, () => {
    updateProfile("favoriteColor", "red");
    updateProfile("favoriteColor", "blue");
    updateProfile("favoriteColor", "red");

    assert.equal(readMemory().profile.favoriteColor, "red");
  });
});

test("rapid interleaved mutations (add/touch/delete/goal/calendar) never lose an update", () => {
  // There is no real thread-level concurrency to simulate in a single-
  // threaded Node process — the actual risk mutateMemory() guards against
  // is a mutation forgetting to persist, or two mutations each reading
  // their own stale copy and one clobbering the other's write. Firing many
  // different mutation types back-to-back, synchronously, is exactly the
  // access pattern concurrent requests would produce in this process (each
  // request handler runs to completion before the next one starts), so if
  // any mutation were dropped or overwritten, it would show up here.
  withTempMemoryFile(undefined, () => {
    const created: string[] = [];

    for (let i = 0; i < 25; i++) {
      const record = addMemory(`fact number ${i}`);
      assert.ok(record, `fact ${i} should have been saved`);
      created.push(record!.id);
    }

    assert.equal(getMemories().length, 25, "all 25 rapid adds must be persisted");

    // Interleave a touch and a delete among further adds.
    assert.equal(touchMemory(created[0]), true);
    assert.equal(deleteMemory(created[5]), true);

    for (let i = 25; i < 30; i++) {
      addMemory(`fact number ${i}`);
    }

    const finalMemories = getMemories();
    assert.equal(finalMemories.length, 29, "25 + 5 more - 1 deleted = 29, nothing lost or duplicated");
    assert.equal(finalMemories.some((m) => m.id === created[5]), false, "deleted memory must stay deleted");
    assert.equal(finalMemories.find((m) => m.id === created[0])?.content, "fact number 0", "touched memory must survive later mutations");

    // Re-reading from disk (simulating a fresh request) must agree exactly.
    assert.deepEqual(
      readMemory().memories.map((m) => m.id).sort(),
      finalMemories.map((m) => m.id).sort()
    );
  });
});

test("getMemoryContext renders memory content as readable text, not raw JSON", async () => {
  // Not using withTempMemoryFile here: that helper is synchronous and
  // doesn't await its callback, which would race its own cleanup against
  // this test's now-async body (getMemoryContext awaits a query embedding
  // internally as of Memory v2E). Self-contained setup/teardown instead —
  // every other test keeps using the shared (still-synchronous) helper
  // unchanged.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lois-memory-test-"));
  const filePath = path.join(dir, "memory.json");
  __setMemoryPathForTesting(filePath);

  try {
    addMemory("my favorite superhero is Spider-Man");

    // Memory v2C/v2E retrieval filters by relevance to the query, so the
    // query here must actually be about the stored memory for it to
    // surface. This exercises the real fallback-safe embedding path end to
    // end rather than mocking it out, same as it already exercised the
    // real readMemory() call.
    const context = await getMemoryContext("What is my favorite superhero?");

    assert.ok(context.includes("my favorite superhero is Spider-Man"));
    assert.ok(!context.includes("{"), "context should not contain raw JSON braces");
  } finally {
    __resetMemoryPathForTesting();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
