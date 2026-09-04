// Unit tests for Documents v1A's supported-extension whitelist. Run with:
// npm run test --workspace=api

import { test } from "node:test";
import assert from "node:assert/strict";
import { isSupportedExtension, fileTypeForExtension } from "./documentConfig";

test("isSupportedExtension recognizes every required v1A format", () => {
  for (const ext of [".txt", ".md", ".json", ".csv", ".pdf", ".docx"]) {
    assert.equal(isSupportedExtension(ext), true, `${ext} should be supported`);
  }
});

test("isSupportedExtension is case-insensitive", () => {
  assert.equal(isSupportedExtension(".TXT"), true);
  assert.equal(isSupportedExtension(".Md"), true);
  assert.equal(isSupportedExtension(".PDF"), true);
});

test("isSupportedExtension recognizes optional source-code extensions (Objective 24)", () => {
  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".py", ".java", ".cs", ".go", ".rs", ".html", ".css", ".yaml", ".yml"]) {
    assert.equal(isSupportedExtension(ext), true, `${ext} should be supported`);
  }
});

test("isSupportedExtension rejects an unsupported extension", () => {
  assert.equal(isSupportedExtension(".exe"), false);
  assert.equal(isSupportedExtension(".zip"), false);
  assert.equal(isSupportedExtension(""), false);
});

test("fileTypeForExtension maps to the right category", () => {
  assert.equal(fileTypeForExtension(".txt"), "txt");
  assert.equal(fileTypeForExtension(".md"), "md");
  assert.equal(fileTypeForExtension(".markdown"), "md");
  assert.equal(fileTypeForExtension(".json"), "json");
  assert.equal(fileTypeForExtension(".csv"), "csv");
  assert.equal(fileTypeForExtension(".pdf"), "pdf");
  assert.equal(fileTypeForExtension(".docx"), "docx");
  assert.equal(fileTypeForExtension(".py"), "code");
});

test("fileTypeForExtension returns null for an unsupported extension", () => {
  assert.equal(fileTypeForExtension(".exe"), null);
});
