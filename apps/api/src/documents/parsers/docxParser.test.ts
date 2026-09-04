// Unit tests for Documents v1A's optional DOCX parser, against a real
// fixture (generated via macOS's `textutil -convert docx`, not mocked —
// mammoth is a local library, no Ollama/network dependency).
// Run with: npm run test --workspace=api

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { parseDocx } from "./docxParser";
import { DocumentParseError } from "./parserTypes";

const FIXTURES_DIR = path.join(__dirname, "__fixtures__");

test("parseDocx extracts text from a real DOCX file", async () => {
  const buffer = fs.readFileSync(path.join(FIXTURES_DIR, "sample.docx"));
  const text = await parseDocx(buffer);
  assert.ok(
    text.includes("Hello LOIS. This is a test document about React and TypeScript."),
    `expected the known source sentence in the extracted text, got: ${JSON.stringify(text)}`
  );
});

test("parseDocx rejects a buffer that isn't a valid DOCX", async () => {
  await assert.rejects(() => parseDocx(Buffer.from("not a docx at all", "utf-8")), DocumentParseError);
});
