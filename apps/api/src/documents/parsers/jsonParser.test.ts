// Unit tests for Documents v1A's JSON parser. Run with: npm run test --workspace=api

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJson } from "./jsonParser";
import { DocumentParseError } from "./parserTypes";

test("parseJson validates and pretty-prints valid JSON (Objective 7)", async () => {
  const text = await parseJson(Buffer.from('{"a":1,"b":[1,2,3]}', "utf-8"));
  assert.equal(text, JSON.stringify({ a: 1, b: [1, 2, 3] }, null, 2));
});

test("parseJson does not flatten nested structure", async () => {
  const input = { user: { name: "Devin", tags: ["a", "b"] }, active: true };
  const text = await parseJson(Buffer.from(JSON.stringify(input), "utf-8"));
  assert.deepEqual(JSON.parse(text), input, "round-tripping the pretty-printed text must reproduce the original structure exactly");
});

test("parseJson rejects malformed JSON with a clear message (Objective 7)", async () => {
  await assert.rejects(
    () => parseJson(Buffer.from('{"a": 1,', "utf-8")),
    (error: unknown) => {
      assert.ok(error instanceof DocumentParseError);
      assert.match((error as Error).message, /not valid JSON/i);
      return true;
    }
  );
});

test("parseJson rejects an empty file", async () => {
  await assert.rejects(() => parseJson(Buffer.from("", "utf-8")), DocumentParseError);
});

test("parseJson accepts a top-level array", async () => {
  const text = await parseJson(Buffer.from("[1,2,3]", "utf-8"));
  assert.deepEqual(JSON.parse(text), [1, 2, 3]);
});
