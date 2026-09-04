// Unit tests for Documents v1A's PDF parser (Objective 5), against real
// PDF fixtures (not mocked — pdf-parse is a local library, no Ollama/
// network dependency, so exercising it directly is fast and deterministic).
//
// Fixtures:
//   sample-with-text.pdf — a real, machine-readable PDF generated via
//     macOS's `cupsfilter` from a plain-text source containing the
//     sentence used in the assertions below.
//   sample-no-text.pdf — a minimal hand-written PDF with a valid page but
//     no content stream at all (no text-showing operators), i.e. exactly
//     the "no extractable text" case Objective 5 asks to be reported
//     honestly rather than silently producing an empty success.
//
// Run with: npm run test --workspace=api

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { parsePdf } from "./pdfParser";
import { DocumentParseError } from "./parserTypes";

const FIXTURES_DIR = path.join(__dirname, "__fixtures__");

function readFixture(name: string): Buffer {
  return fs.readFileSync(path.join(FIXTURES_DIR, name));
}

test("parsePdf extracts text from a real machine-readable PDF (Objective 5)", async () => {
  const text = await parsePdf(readFixture("sample-with-text.pdf"));
  assert.ok(
    text.includes("Hello LOIS. This is a test document about React and TypeScript."),
    `expected the known source sentence in the extracted text, got: ${JSON.stringify(text)}`
  );
});

test("parsePdf reports honestly when a PDF has no extractable text (Objective 5)", async () => {
  await assert.rejects(
    () => parsePdf(readFixture("sample-no-text.pdf")),
    (error: unknown) => {
      assert.ok(error instanceof DocumentParseError);
      assert.match((error as Error).message, /no extractable text/i);
      assert.match((error as Error).message, /scanned/i);
      return true;
    }
  );
});

test("parsePdf rejects a buffer that isn't a PDF at all", async () => {
  await assert.rejects(() => parsePdf(Buffer.from("not a pdf at all", "utf-8")), DocumentParseError);
});
