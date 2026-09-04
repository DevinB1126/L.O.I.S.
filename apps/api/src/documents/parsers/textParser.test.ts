// Unit tests for Documents v1A's plain-text/Markdown/source-code parser.
// Run with: npm run test --workspace=api

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseText } from "./textParser";
import { DocumentParseError } from "./parserTypes";

test("parseText returns UTF-8 text verbatim", async () => {
  const text = await parseText(Buffer.from("Hello, LOIS.\nSecond line.", "utf-8"));
  assert.equal(text, "Hello, LOIS.\nSecond line.");
});

test("parseText preserves line breaks exactly (Objective 6)", async () => {
  const text = await parseText(Buffer.from("line one\nline two\n\nline four", "utf-8"));
  assert.equal(text, "line one\nline two\n\nline four");
});

test("parseText does not convert Markdown to HTML (Objective 6)", async () => {
  const markdown = "# Heading\n\n**bold** and _italic_\n\n- item one\n- item two";
  const text = await parseText(Buffer.from(markdown, "utf-8"));
  assert.equal(text, markdown, "Markdown source must be stored as-is, not rendered");
  assert.ok(!text.includes("<h1>") && !text.includes("<strong>"), "must not contain HTML");
});

test("parseText rejects an empty file", async () => {
  await assert.rejects(() => parseText(Buffer.from("", "utf-8")), DocumentParseError);
  await assert.rejects(() => parseText(Buffer.from("   \n  ", "utf-8")), DocumentParseError);
});

test("parseText handles source code content (Objective 24)", async () => {
  const code = 'export function add(a: number, b: number): number {\n  return a + b;\n}\n';
  const text = await parseText(Buffer.from(code, "utf-8"));
  assert.equal(text, code);
});
