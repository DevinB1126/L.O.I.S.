// Unit tests for Documents v1A's document service: storage, the index,
// metadata shape, deletion, persistence, and filename safety. Uses Node's
// built-in test runner (node:test), always against a throwaway temp
// directory via __setDocumentDataDirForTesting — never the real
// apps/api/data/documents/.
//
// Run with: npm run test --workspace=api

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import {
  __setDocumentDataDirForTesting,
  __resetDocumentDataDirForTesting,
  initDocumentStorage,
  addDocument,
  listDocuments,
  getDocumentById,
  getDocumentContent,
  deleteDocument,
  removeAllDocumentsFromProject,
  documentCountForProject,
} from "./documentService";

function withTempDocumentDataDir(run: (dir: string) => void | Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lois-documents-test-"));
  __setDocumentDataDirForTesting(dir);
  initDocumentStorage();

  const result = run(dir);

  if (result instanceof Promise) {
    return result.finally(() => {
      __resetDocumentDataDirForTesting();
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }

  __resetDocumentDataDirForTesting();
  fs.rmSync(dir, { recursive: true, force: true });
  return undefined;
}

test("addDocument stores a .txt file and marks it ready", async () => {
  await withTempDocumentDataDir(async () => {
    const doc = await addDocument({
      originalName: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Hello LOIS, this is a plain text note.", "utf-8"),
    });

    assert.equal(doc.status, "ready");
    assert.equal(doc.fileType, "txt");
    assert.equal(doc.originalName, "notes.txt");
    assert.equal(doc.displayName, "notes.txt");
    assert.ok(doc.textLength > 0);
    assert.equal(doc.error, undefined);
  });
});

test("addDocument stores a .json file, pretty-printed, and marks it ready", async () => {
  await withTempDocumentDataDir(async () => {
    const doc = await addDocument({
      originalName: "config.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ hello: "world" }), "utf-8"),
    });

    assert.equal(doc.status, "ready");
    assert.equal(doc.fileType, "json");

    const content = getDocumentContent(doc.id);
    assert.ok(content);
    assert.match(content as string, /"hello": "world"/);
  });
});

test("addDocument stores a .csv file and marks it ready", async () => {
  await withTempDocumentDataDir(async () => {
    const doc = await addDocument({
      originalName: "data.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("name,age\nDevin,30\n", "utf-8"),
    });

    assert.equal(doc.status, "ready");
    assert.equal(doc.fileType, "csv");
    const content = getDocumentContent(doc.id);
    assert.ok(content?.includes("name"));
    assert.ok(content?.includes("Devin"));
  });
});

test("addDocument marks status 'error' for malformed JSON but still keeps the record and original file", async () => {
  await withTempDocumentDataDir(async () => {
    const doc = await addDocument({
      originalName: "broken.json",
      mimeType: "application/json",
      buffer: Buffer.from("{ this is not valid json", "utf-8"),
    });

    assert.equal(doc.status, "error");
    assert.ok(doc.error && doc.error.length > 0);

    // The record still exists and is listed — a parse failure doesn't
    // silently discard the upload.
    const found = getDocumentById(doc.id);
    assert.ok(found);
    assert.equal(found?.status, "error");

    // No extracted content is available for an errored document.
    assert.equal(getDocumentContent(doc.id), null);
  });
});

test("listDocuments returns metadata only (no storagePath) and sorts newest first", async () => {
  await withTempDocumentDataDir(async () => {
    const first = await addDocument({
      originalName: "first.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("first document", "utf-8"),
    });
    // Ensure distinct createdAt ordering even on a fast filesystem/clock.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await addDocument({
      originalName: "second.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("second document", "utf-8"),
    });

    const docs = listDocuments();
    assert.equal(docs.length, 2);
    assert.equal(docs[0].id, second.id, "newest document should be first");
    assert.equal(docs[1].id, first.id);

    for (const doc of docs) {
      assert.equal((doc as Record<string, unknown>).storagePath, undefined);
      // Metadata-only: no full extracted text embedded in the list.
      assert.equal((doc as Record<string, unknown>).content, undefined);
    }
  });
});

test("getDocumentById returns a single document's metadata, or undefined when missing", async () => {
  await withTempDocumentDataDir(async () => {
    const doc = await addDocument({
      originalName: "single.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("single document content", "utf-8"),
    });

    const found = getDocumentById(doc.id);
    assert.equal(found?.id, doc.id);

    assert.equal(getDocumentById("00000000-0000-0000-0000-000000000000"), undefined);
  });
});

test("getDocumentContent returns extracted text for a ready document, null for an unknown id", async () => {
  await withTempDocumentDataDir(async () => {
    const doc = await addDocument({
      originalName: "content-check.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("some extracted content here", "utf-8"),
    });

    assert.equal(getDocumentContent(doc.id), "some extracted content here");
    assert.equal(getDocumentContent("00000000-0000-0000-0000-000000000000"), null);
  });
});

test("deleteDocument removes the index record, the original file, and the extracted text, without touching other documents", async () => {
  await withTempDocumentDataDir(async (dir) => {
    const keep = await addDocument({
      originalName: "keep.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("keep me", "utf-8"),
    });
    const remove = await addDocument({
      originalName: "remove.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("remove me", "utf-8"),
    });

    const filesDir = path.join(dir, "files");
    const extractedDir = path.join(dir, "extracted");

    const removeFilePath = fs.readdirSync(filesDir).find((f) => f.startsWith(remove.id));
    assert.ok(removeFilePath, "original file for the doc to delete should exist before deletion");
    assert.ok(fs.existsSync(path.join(extractedDir, `${remove.id}.txt`)));

    const result = deleteDocument(remove.id);
    assert.equal(result, true);

    // The deleted document's artifacts are gone.
    assert.equal(getDocumentById(remove.id), undefined);
    assert.ok(!fs.readdirSync(filesDir).some((f) => f.startsWith(remove.id)));
    assert.ok(!fs.existsSync(path.join(extractedDir, `${remove.id}.txt`)));

    // The other document is completely untouched.
    assert.ok(getDocumentById(keep.id));
    assert.equal(getDocumentContent(keep.id), "keep me");
    assert.ok(fs.readdirSync(filesDir).some((f) => f.startsWith(keep.id)));

    // Deleting an id that no longer exists reports failure, not a crash.
    assert.equal(deleteDocument(remove.id), false);
  });
});

test("the index survives a fresh read (restart persistence)", async () => {
  await withTempDocumentDataDir(async () => {
    const doc = await addDocument({
      originalName: "persisted.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("this should still be here after 'restart'", "utf-8"),
    });

    // listDocuments/getDocumentById/getDocumentContent all re-read
    // index.json from disk on every call rather than caching in memory, so
    // calling them again simulates what a fresh process start would see.
    const reloaded = getDocumentById(doc.id);
    assert.ok(reloaded);
    assert.equal(reloaded?.status, "ready");
    assert.equal(getDocumentContent(doc.id), "this should still be here after 'restart'");
    assert.equal(listDocuments().length, 1);
  });
});

test("two uploads with the same original filename get distinct IDs and distinct storage files", async () => {
  await withTempDocumentDataDir(async (dir) => {
    const a = await addDocument({
      originalName: "duplicate.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("version A", "utf-8"),
    });
    const b = await addDocument({
      originalName: "duplicate.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("version B", "utf-8"),
    });

    assert.notEqual(a.id, b.id);
    assert.equal(a.originalName, b.originalName);

    assert.equal(getDocumentContent(a.id), "version A");
    assert.equal(getDocumentContent(b.id), "version B");
    assert.equal(listDocuments().length, 2);
  });
});

test("addDocument computes a SHA-256 contentHash from the file bytes, not used as the id", async () => {
  await withTempDocumentDataDir(async () => {
    const buffer = Buffer.from("hash me please", "utf-8");
    const doc = await addDocument({ originalName: "hashme.txt", mimeType: "text/plain", buffer });

    const expectedHash = crypto.createHash("sha256").update(buffer).digest("hex");
    assert.equal((doc as unknown as { contentHash: string }).contentHash, expectedHash);
    assert.notEqual(doc.id, expectedHash);
  });
});

test("malformed entries in index.json are dropped without crashing the whole list", async () => {
  await withTempDocumentDataDir(async (dir) => {
    const good = await addDocument({
      originalName: "good.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("a perfectly valid document", "utf-8"),
    });

    const indexPath = path.join(dir, "index.json");
    const raw = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    raw.documents.push({ id: "not-a-real-record", missingEverythingElse: true });
    fs.writeFileSync(indexPath, JSON.stringify(raw, null, 2));

    const docs = listDocuments();
    assert.equal(docs.length, 1);
    assert.equal(docs[0].id, good.id);
  });
});

test("a traversal-style original filename cannot escape the storage directory", async () => {
  await withTempDocumentDataDir(async (dir) => {
    const doc = await addDocument({
      originalName: "../../../../etc/passwd.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("attempted traversal payload", "utf-8"),
    });

    // The original (untrusted) name is preserved as metadata only...
    assert.equal(doc.originalName, "../../../../etc/passwd.txt");

    // ...but the file was actually written safely inside files/, named by
    // the generated document id, never by the untrusted path.
    const filesDir = path.join(dir, "files");
    const writtenFiles = fs.readdirSync(filesDir);
    assert.ok(writtenFiles.every((f) => !f.includes("..") && !f.includes(path.sep)));
    assert.ok(writtenFiles.some((f) => f.startsWith(doc.id)));

    // Nothing was written outside the temp data directory.
    const parentOfDir = path.dirname(dir);
    const siblingEntries = fs.readdirSync(parentOfDir);
    assert.ok(!siblingEntries.includes("etc"));

    assert.equal(getDocumentContent(doc.id), "attempted traversal payload");
  });
});

test("addDocument rejects a truly unsupported extension defensively", async () => {
  await withTempDocumentDataDir(async () => {
    await assert.rejects(() =>
      addDocument({
        originalName: "virus.exe",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("binary junk", "utf-8"),
      })
    );
  });
});

// ============================================================
// Projects v1A follow-up — project-scoped documents
// ============================================================

test("addDocument with no projectId defaults to a global document (projectId: null)", async () => {
  await withTempDocumentDataDir(async () => {
    const doc = await addDocument({
      originalName: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("global note", "utf-8"),
    });

    assert.equal(doc.projectId, null);
  });
});

test("addDocument attaches a document to a project when given a projectId", async () => {
  await withTempDocumentDataDir(async () => {
    const doc = await addDocument({
      originalName: "spec.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Project spec", "utf-8"),
      projectId: "project-abc",
    });

    assert.equal(doc.projectId, "project-abc");
  });
});

test("listDocuments filters by projectId, and by scope:null for unassigned documents", async () => {
  await withTempDocumentDataDir(async () => {
    const globalDoc = await addDocument({
      originalName: "global.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("global content", "utf-8"),
    });
    const projectDoc = await addDocument({
      originalName: "project.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("project content", "utf-8"),
      projectId: "project-abc",
    });
    const otherProjectDoc = await addDocument({
      originalName: "other.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("other project content", "utf-8"),
      projectId: "project-xyz",
    });

    const globalList = listDocuments({ projectId: null });
    assert.deepEqual(globalList.map((d) => d.id).sort(), [globalDoc.id].sort());

    const projectAbcList = listDocuments({ projectId: "project-abc" });
    assert.deepEqual(projectAbcList.map((d) => d.id), [projectDoc.id]);

    const projectXyzList = listDocuments({ projectId: "project-xyz" });
    assert.deepEqual(projectXyzList.map((d) => d.id), [otherProjectDoc.id]);

    // Omitting the filter still lists everything (unchanged from before).
    assert.equal(listDocuments().length, 3);
  });
});

test("documentCountForProject counts only that project's documents", async () => {
  await withTempDocumentDataDir(async () => {
    await addDocument({ originalName: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a"), projectId: "proj-a" });
    await addDocument({ originalName: "b.txt", mimeType: "text/plain", buffer: Buffer.from("b"), projectId: "proj-a" });
    await addDocument({ originalName: "c.txt", mimeType: "text/plain", buffer: Buffer.from("c"), projectId: "proj-b" });
    await addDocument({ originalName: "d.txt", mimeType: "text/plain", buffer: Buffer.from("d") });

    assert.equal(documentCountForProject("proj-a"), 2);
    assert.equal(documentCountForProject("proj-b"), 1);
  });
});

test("removeAllDocumentsFromProject returns every one of a project's documents to global, without affecting other projects", async () => {
  await withTempDocumentDataDir(async () => {
    const a = await addDocument({ originalName: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a"), projectId: "proj-to-delete" });
    const b = await addDocument({ originalName: "b.txt", mimeType: "text/plain", buffer: Buffer.from("b"), projectId: "proj-to-delete" });
    const unrelated = await addDocument({ originalName: "c.txt", mimeType: "text/plain", buffer: Buffer.from("c"), projectId: "other-project" });

    const count = removeAllDocumentsFromProject("proj-to-delete");
    assert.equal(count, 2);

    assert.equal(getDocumentById(a.id)?.projectId, null);
    assert.equal(getDocumentById(b.id)?.projectId, null);
    assert.equal(getDocumentById(unrelated.id)?.projectId, "other-project", "unrelated project's documents untouched");

    // The documents themselves (and their extracted content) survive —
    // this is a reassignment, not a deletion.
    assert.equal(getDocumentContent(a.id), "a");
  });
});
