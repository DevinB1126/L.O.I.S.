import fs from "fs";
import path from "path";
import crypto from "crypto";
import { DocumentFileType, fileTypeForExtension } from "./documentConfig";
import { extractDocumentText, DocumentParseError } from "./documentTextExtractor";

// Documents v1A — local file ingestion, parsing, metadata, and document
// management foundation.
//
// Storage layout (Objective 2), all under apps/api/data/documents/ — NOT
// apps/web/public, since these are application data, not static site
// assets:
//   index.json        — document metadata (this module's own atomic-write
//                        JSON index, same temp-then-rename pattern
//                        memoryService.ts's writeMemoryFile already uses)
//   files/<id>.<ext>   — the original uploaded bytes, unchanged
//   extracted/<id>.txt — extracted plain text (Objective 1: kept OUT of
//                        the metadata object so listing documents stays
//                        cheap regardless of how much text a document has)
//
// Responsibilities kept deliberately separate (Objective 11/12):
//   documentConfig          — size limit + supported-extension whitelist
//   documentTextExtractor   — routes a fileType to the right parser
//   parsers/*                — one parser per format, parsing only
//   documentService (here)   — validation, storage, the index, and the
//                              only place that decides what counts as a
//                              document at all

export type DocumentStatus = "ready" | "processing" | "error";

export type DocumentRecord = {
  id: string;
  originalName: string;
  displayName: string;
  fileType: DocumentFileType;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  source: "upload";
  status: DocumentStatus;
  /** Length of the extracted text, not a copy of it (Objective 1). */
  textLength: number;
  /** SHA-256 of the original file bytes (Objective 27/28) — stored for
   *  future duplicate/change detection, never used to reject an upload or
   *  as the record's identity. */
  contentHash: string;
  /** Projects v1A follow-up — null/undefined means a global document, not
   *  attached to any project. Set to a real project's id to scope a
   *  document to that project (see listDocuments' filter and
   *  removeAllDocumentsFromProject). Purely organizational for now: no
   *  RAG/embeddings/chunking is implied by this field. */
  projectId?: string | null;
  /** Internal only — a path RELATIVE to data/documents/, never an absolute
   *  OS path, and never sent to the frontend (see toPublicDocument /
   *  Objective 15's "do not expose arbitrary filesystem paths"). */
  storagePath?: string;
  error?: string;
};

/** What actually leaves this module via the API — storagePath stripped. */
export type PublicDocumentRecord = Omit<DocumentRecord, "storagePath">;

const DEFAULT_DATA_DIR = path.join(__dirname, "..", "..", "data", "documents");

// Mutable only so tests can point the service at an isolated directory —
// never reassigned by production code. Mirrors memoryService's own
// __setMemoryPathForTesting; every path below is a FUNCTION (not a
// frozen const computed once at module load) specifically so the override
// actually takes effect wherever it's set, including mid-process in tests.
let dataDir = DEFAULT_DATA_DIR;

function getDataDir(): string {
  return dataDir;
}

function getFilesDir(): string {
  return path.join(getDataDir(), "files");
}

function getExtractedDir(): string {
  return path.join(getDataDir(), "extracted");
}

function getIndexPath(): string {
  return path.join(getDataDir(), "index.json");
}

const CURRENT_INDEX_VERSION = 1;

type DocumentIndex = {
  schemaVersion: number;
  documents: DocumentRecord[];
};

function defaultIndex(): DocumentIndex {
  return { schemaVersion: CURRENT_INDEX_VERSION, documents: [] };
}

// Called once at server startup (Objective 2/3) — creates the directory
// tree and a fresh index.json if this is a new clone/first run. Safe to
// call repeatedly; every step is a no-op if already done.
export function initDocumentStorage(): void {
  fs.mkdirSync(getFilesDir(), { recursive: true });
  fs.mkdirSync(getExtractedDir(), { recursive: true });

  if (!fs.existsSync(getIndexPath())) {
    writeIndex(defaultIndex());
  }
}

function isValidDocumentRecord(value: unknown): value is DocumentRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;

  return (
    typeof r.id === "string" &&
    r.id.length > 0 &&
    typeof r.originalName === "string" &&
    typeof r.displayName === "string" &&
    typeof r.fileType === "string" &&
    typeof r.mimeType === "string" &&
    typeof r.sizeBytes === "number" &&
    typeof r.createdAt === "string" &&
    typeof r.updatedAt === "string" &&
    r.source === "upload" &&
    (r.status === "ready" || r.status === "processing" || r.status === "error") &&
    typeof r.textLength === "number" &&
    typeof r.contentHash === "string" &&
    (r.projectId === undefined || r.projectId === null || typeof r.projectId === "string") &&
    (r.storagePath === undefined || typeof r.storagePath === "string") &&
    (r.error === undefined || typeof r.error === "string")
  );
}

// The index should not blindly trust index.json — drop malformed
// individual records (logging why) instead of letting one bad entry break
// the whole list, same posture as memoryService's sanitizeMemories.
function sanitizeDocuments(value: unknown): DocumentRecord[] {
  if (!Array.isArray(value)) return [];

  const valid: DocumentRecord[] = [];

  for (const entry of value) {
    if (isValidDocumentRecord(entry)) {
      valid.push(entry);
    } else {
      console.error("Dropping malformed document record from index.json:", entry);
    }
  }

  return valid;
}

function readIndex(): DocumentIndex {
  if (!fs.existsSync(getIndexPath())) {
    return defaultIndex();
  }

  let text: string;

  try {
    text = fs.readFileSync(getIndexPath(), "utf-8");
  } catch (error) {
    console.error("Failed to read documents index.json:", error);
    return defaultIndex();
  }

  if (!text.trim()) {
    return defaultIndex();
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    console.error("documents/index.json is not valid JSON:", error);
    quarantineCorruptIndex();
    return defaultIndex();
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as Record<string, unknown>).documents)) {
    return defaultIndex();
  }

  return {
    schemaVersion: CURRENT_INDEX_VERSION,
    documents: sanitizeDocuments((parsed as { documents: unknown }).documents),
  };
}

function quarantineCorruptIndex(): void {
  try {
    const quarantinePath = path.join(getDataDir(), `index.corrupt.${Date.now()}.json`);
    fs.copyFileSync(getIndexPath(), quarantinePath);
    console.error(`Corrupt documents index.json preserved at ${quarantinePath}`);
  } catch (error) {
    console.error("Failed to quarantine corrupt documents index.json:", error);
  }
}

// write-to-temp-then-rename — identical rationale to memoryService's
// writeMemoryFile: rename is atomic on the same filesystem, so a crash
// mid-write leaves the previous good index intact.
function writeIndex(index: DocumentIndex): void {
  fs.mkdirSync(getDataDir(), { recursive: true });
  const tempPath = `${getIndexPath()}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(index, null, 2));
  fs.renameSync(tempPath, getIndexPath());
}

// Same serialized read-modify-write shape as memoryService's
// mutateMemory() — see that function's comment for the full rationale
// (single-threaded synchronous Node means this is race-safe without a
// queue/lock, as long as nothing async happens between the read and the
// write, which this enforces structurally).
function mutateIndex<T>(mutator: (index: DocumentIndex) => T): T {
  const index = readIndex();
  const result = mutator(index);
  writeIndex(index);
  return result;
}

export function toPublicDocument(record: DocumentRecord): PublicDocumentRecord {
  const { storagePath, ...rest } = record;
  return rest;
}

export type ListDocumentsFilter = {
  /** Omit to list every document. Pass a project's id to list only that
   *  project's documents, or `null` to list only global/unassigned ones
   *  (mirrors conversationService.listConversations' own filter shape). */
  projectId?: string | null;
};

export function listDocuments(filter: ListDocumentsFilter = {}): PublicDocumentRecord[] {
  const documents = readIndex().documents;

  const filtered =
    filter.projectId === undefined
      ? documents
      : documents.filter((d) => (d.projectId ?? null) === filter.projectId);

  // Newest first (Objective 14).
  return [...filtered].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(toPublicDocument);
}

export function documentCountForProject(projectId: string): number {
  return readIndex().documents.filter((d) => d.projectId === projectId).length;
}

export function getDocumentById(id: string): PublicDocumentRecord | undefined {
  const record = readIndex().documents.find((d) => d.id === id);
  return record ? toPublicDocument(record) : undefined;
}

// Returns null for "no content available" (document not found, still
// processing, or extraction failed) — callers (server.ts) turn that into
// an honest 404/empty response, never a raw filesystem error.
export function getDocumentContent(id: string): string | null {
  const record = readIndex().documents.find((d) => d.id === id);
  if (!record) return null;

  const extractedPath = path.join(getExtractedDir(), `${id}.txt`);
  if (!fs.existsSync(extractedPath)) return null;

  try {
    return fs.readFileSync(extractedPath, "utf-8");
  } catch (error) {
    console.error(`Failed to read extracted content for document ${id}:`, error);
    return null;
  }
}

export interface AddDocumentInput {
  originalName: string;
  mimeType: string;
  buffer: Buffer;
  /** Optional — attaches the document to a project at upload time. Omit
   *  (or pass null) for a global document. The route (server.ts) is
   *  responsible for validating the id actually names a real project
   *  before calling this — documentService itself doesn't depend on
   *  projectService, same posture conversationService already takes. */
  projectId?: string | null;
}

// Strips control characters from the name shown in the UI — the raw
// originalName is still kept as-is in the record for reference, this is
// only the display-safe derivative (Objective 1's displayName/originalName
// split).
function sanitizeDisplayName(name: string): string {
  const cleaned = name.replace(/[\x00-\x1f\x7f]/g, "").trim();
  return cleaned.length > 0 ? cleaned : "Untitled";
}

// The core orchestration (Objective 13): generate a stable ID (Objective
// 26 — crypto.randomUUID, never an array index or the filename), store the
// original bytes under that ID (Objective 10 — never the uploaded
// filename), attempt extraction, and persist a record either way. A
// two-file upload sharing a name gets two entirely distinct IDs/paths
// (Objective 27) — nothing here ever keys off originalName.
export async function addDocument(input: AddDocumentInput): Promise<PublicDocumentRecord> {
  const id = crypto.randomUUID();
  const ext = path.extname(input.originalName).toLowerCase();
  const fileType = fileTypeForExtension(ext);

  if (!fileType) {
    // The route already validates this before calling in — this is a
    // defensive backstop, not the primary check, same posture
    // sanitizeMemories takes toward its own caller.
    throw new Error(`Unsupported file type: ${ext || "(no extension)"}`);
  }

  const contentHash = crypto.createHash("sha256").update(input.buffer).digest("hex");
  const now = new Date().toISOString();
  const storageFileName = `${id}${ext}`;

  const record: DocumentRecord = {
    id,
    originalName: input.originalName,
    displayName: sanitizeDisplayName(input.originalName),
    fileType,
    mimeType: input.mimeType,
    sizeBytes: input.buffer.length,
    createdAt: now,
    updatedAt: now,
    source: "upload",
    status: "processing",
    textLength: 0,
    contentHash,
    projectId: input.projectId ?? null,
    storagePath: path.join("files", storageFileName),
  };

  fs.mkdirSync(getFilesDir(), { recursive: true });
  fs.writeFileSync(path.join(getFilesDir(), storageFileName), input.buffer);

  try {
    const text = await extractDocumentText(fileType, input.buffer);
    fs.mkdirSync(getExtractedDir(), { recursive: true });
    fs.writeFileSync(path.join(getExtractedDir(), `${id}.txt`), text, "utf-8");
    record.status = "ready";
    record.textLength = text.length;
  } catch (error) {
    // A parse failure still leaves a real document record (status:
    // "error") rather than silently discarding the upload or pretending
    // it succeeded (Objective 5/22) — the original file is already saved
    // above either way.
    record.status = "error";
    record.error = error instanceof DocumentParseError ? error.message : "Failed to extract text from this file.";

    if (!(error instanceof DocumentParseError)) {
      console.error(`[documents] unexpected parse failure for ${id}:`, error);
    }
  }

  mutateIndex((index) => {
    index.documents.push(record);
  });

  return toPublicDocument(record);
}

// Objective 16: removes the index record, the original file, AND the
// extracted text — no ghost content survives in any of the three places.
// The index removal happens as one mutateIndex() call (matching
// memoryService.deleteMemory's shape); file cleanup happens after, since
// those are separate physical files, not part of the index.json write
// itself.
export function deleteDocument(id: string): boolean {
  const removedRecord = mutateIndex((index) => {
    const record = index.documents.find((d) => d.id === id);
    if (!record) return null;

    index.documents = index.documents.filter((d) => d.id !== id);
    return record;
  });

  if (!removedRecord) return false;

  const ext = path.extname(removedRecord.originalName).toLowerCase();
  safeUnlink(path.join(getFilesDir(), `${removedRecord.id}${ext}`));
  safeUnlink(path.join(getExtractedDir(), `${removedRecord.id}.txt`));

  return true;
}

// Used by DELETE /projects/:id (same safety principle as
// conversationService.removeAllFromProject — Objective 42 of Projects
// v1A): a deleted project's documents are returned to global/unassigned
// rather than being cascade-deleted along with it. Files/extracted text
// are untouched either way; only the projectId field changes.
export function removeAllDocumentsFromProject(projectId: string): number {
  return mutateIndex((index) => {
    let count = 0;
    const now = new Date().toISOString();

    for (const document of index.documents) {
      if (document.projectId === projectId) {
        document.projectId = null;
        document.updatedAt = now;
        count++;
      }
    }

    return count;
  });
}

function safeUnlink(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error(`Failed to delete file ${filePath}:`, error);
  }
}

// ============================================================
// Test-only data directory override — mirrors memoryService's
// __setMemoryPathForTesting so document tests never touch real user data.
// ============================================================

export function __setDocumentDataDirForTesting(dir: string): void {
  dataDir = dir;
}

export function __resetDocumentDataDirForTesting(): void {
  dataDir = DEFAULT_DATA_DIR;
}
