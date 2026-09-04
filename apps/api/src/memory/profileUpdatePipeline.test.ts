// Unit tests for the profile-state synchronization fix's orchestration
// layer: tryHandleProfileUpdate ties detection (memoryExtractor) and
// persistence (memoryService) together and is what guarantees the reply
// text can never claim success unless the mutation actually happened.
// Always operates on a throwaway temp file via __setMemoryPathForTesting,
// never the real memory.json.
//
// Run with: npm run test --workspace=api

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { __setMemoryPathForTesting, __resetMemoryPathForTesting, readMemory, getMemories } from "./memoryService";
import { tryHandleProfileUpdate } from "./profileUpdatePipeline";

function withTempMemoryFile(run: (filePath: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lois-profile-pipeline-test-"));
  const filePath = path.join(dir, "memory.json");

  __setMemoryPathForTesting(filePath);

  try {
    run(filePath);
  } finally {
    __resetMemoryPathForTesting();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("tryHandleProfileUpdate: a canonical statement is handled, persists the value, and the reply claims success only because it really happened", () => {
  withTempMemoryFile(() => {
    const outcome = tryHandleProfileUpdate("lois", "My favorite color is red.");

    assert.equal(outcome.handled, true);
    assert.ok(outcome.reply);
    assert.match(outcome.reply!, /red/i);
    assert.doesNotMatch(outcome.reply!, /couldn't|wasn't able|rejected/i);

    assert.equal(readMemory().profile.favoriteColor, "red");
  });
});

test("tryHandleProfileUpdate: a non-profile message is not handled at all", () => {
  withTempMemoryFile(() => {
    const outcome = tryHandleProfileUpdate("lois", "I like video games.");
    assert.equal(outcome.handled, false);
    assert.equal(outcome.reply, undefined);
  });
});

test("tryHandleProfileUpdate: a canonical profile statement never also creates a generic MemoryRecord", () => {
  withTempMemoryFile(() => {
    tryHandleProfileUpdate("lois", "My favorite color is red.");

    assert.equal(getMemories().length, 0, "profile updates must not duplicate into memories[]");
  });
});

test("tryHandleProfileUpdate: IGNIS gets IGNIS-flavored wording, LOIS gets LOIS-flavored wording", () => {
  withTempMemoryFile(() => {
    const loisOutcome = tryHandleProfileUpdate("lois", "My favorite color is red.");
    assert.match(loisOutcome.reply!, /Devin/);

    const ignisOutcome = tryHandleProfileUpdate("ignis", "My occupation is software engineer.");
    assert.match(ignisOutcome.reply!, /Devin/);
    // Different enough tone: LOIS's success wording starts with "Devin,"; IGNIS's does not.
    assert.doesNotMatch(ignisOutcome.reply!, /^Devin,/);
  });
});
