// Unit tests for Documents v1A's CSV parser. Run with: npm run test --workspace=api

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "./csvParser";
import { DocumentParseError } from "./parserTypes";

test("parseCsv preserves a simple header/row table structure (Objective 8)", async () => {
  const text = await parseCsv(Buffer.from("name,role\nDevin,Engineer\nLOIS,Assistant", "utf-8"));
  assert.equal(text, "name | role\n---" + "-+-" + "---\nDevin | Engineer\nLOIS | Assistant");
});

test("parseCsv handles a quoted field containing a comma", async () => {
  const text = await parseCsv(Buffer.from('name,note\nDevin,"likes React, TypeScript"', "utf-8"));
  assert.ok(text.includes("likes React, TypeScript"), "the comma inside quotes must survive as part of one field");
});

test("parseCsv handles a quoted field containing an embedded newline", async () => {
  const text = await parseCsv(Buffer.from('name,bio\nDevin,"Line one\nLine two"', "utf-8"));
  assert.ok(text.includes("Line one\nLine two"), "the embedded newline inside quotes must survive within one field");
});

test("parseCsv handles an escaped double-quote inside a quoted field", async () => {
  const text = await parseCsv(Buffer.from('name,quote\nDevin,"She said ""hello"""', "utf-8"));
  assert.ok(text.includes('She said "hello"'), 'escaped "" must become a literal "');
});

test("parseCsv rejects an empty file", async () => {
  await assert.rejects(() => parseCsv(Buffer.from("", "utf-8")), DocumentParseError);
});

test("parseCsv pads short rows so the table stays readable with a ragged input", async () => {
  const text = await parseCsv(Buffer.from("a,b,c\n1,2\n3,4,5", "utf-8"));
  const lines = text.split("\n");
  // Header + separator + 2 data rows.
  assert.equal(lines.length, 4);
});
