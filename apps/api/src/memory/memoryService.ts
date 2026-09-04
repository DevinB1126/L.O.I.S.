import fs from "fs";
import path from "path";
import { retrieveRelevantMemories, formatRetrievedMemories, RETRIEVAL_CONFIG } from "./memoryRetriever";
import type { CalendarRecurrence } from "../actions/assistantAction";
import { formatDateText } from "../actions/calendarRecurrence";

const DEFAULT_MEMORY_PATH = path.join(__dirname, "memory.json");

// Mutable only so tests can point the service at an isolated file — never
// reassigned by production code. See __setMemoryPathForTesting below.
let memoryPath = DEFAULT_MEMORY_PATH;

// ============================================================
// Types
// ============================================================

type Conversation = {
  agent: string;
  userMessage: string;
  assistantReply: string;
  timestamp: string;
};

// Action Execution Layer v1 — exported (was module-private) so the action
// executor/frontend types can reference it directly instead of duplicating
// the shape. `date`/`recurrence` are new; `dateText`/`timeText` are kept as
// display strings for the existing UI (CalendarView, RightPanels' SCHEDULE
// card) rather than ripped out, but are now DERIVED from `date`/`recurrence`
// at creation time (see addCalendarEvent) instead of guessed from raw text.
// Both new fields are optional so a pre-existing event created before this
// change (no `date`, no `recurrence`) stays a valid record — no migration
// needed, same purely-additive posture every other optional field on this
// file's records already uses (see MemoryRecord.embedding's own comment).
export type CalendarEvent = {
  id: string;
  title: string;
  dateText: string;
  timeText: string;
  /** ISO YYYY-MM-DD anchor date. Absent on events created before this
   *  change — those fall back to their original free-text dateText only. */
  date?: string;
  recurrence?: CalendarRecurrence;
  createdAt: string;
  updatedAt: string;
};

export type Goal = {
  id: string;
  title: string;
  completed: boolean;
  createdAt: string;
};

// Deliberately conservative — this is the foundation Memory v2B/v2C build
// on, not the final taxonomy. Extend this union when a real need shows up.
export type MemoryCategory =
  | "personal"
  | "preference"
  | "project"
  | "work"
  | "education"
  | "relationship"
  | "routine"
  | "interest"
  | "technical"
  | "other";

export const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  "personal",
  "preference",
  "project",
  "work",
  "education",
  "relationship",
  "routine",
  "interest",
  "technical",
  "other",
];

// "migration" is used exclusively for facts carried over from the legacy
// `facts: string[]` schema; new memories should use "user"/"assistant"/"system".
export type MemorySource = "user" | "assistant" | "system" | "migration";

// Projects v1A (Objective 6) — a memory either describes the user across
// every context ("global") or is specific to one project ("project"). This
// is a context-scope boundary, not a topic tag: a "project" memory is only
// ever a retrieval candidate inside its own project (see
// filterMemoriesByScope in memoryRetriever.ts) — it never leaks into
// global chat or a different project, regardless of how relevant its text
// might look.
export type MemoryScope = "global" | "project";

export type MemoryRecord = {
  id: string;
  content: string;
  category: MemoryCategory;
  /** 1 (minor) – 5 (critical). No automatic scoring yet — see Memory v2B. */
  importance: number;
  /** Memory v2D — user-marked as important enough to keep visually
   *  surfaced in the Memory view. Never bypasses the v2C relevance floor
   *  on its own; see PINNED_BOOST in memoryRetriever.ts. */
  pinned: boolean;
  /** Projects v1A — defaults to "global" for every pre-existing record
   *  (see migrateV3ToV4Shape below). Only ever "project" when created
   *  inside a project conversation (see memoryPipeline.ts). */
  scope: MemoryScope;
  /** Set if and only if scope === "project" — the owning project's id.
   *  Never set for a global memory. */
  projectId?: string;
  /** Memory v2E — semantic embedding of `content`, persisted directly on
   *  the record rather than in a separate index (see memoryEmbeddings.ts
   *  for the full rationale: this is what makes delete-integration free —
   *  deleting the record deletes its embedding, there is no second place
   *  that can drift out of sync). Genuinely optional, not defaulted: a
   *  record legitimately has no embedding until one has been generated,
   *  and "absent" is exactly the "needs (re)embedding" signal the
   *  backfill/staleness logic reads — no schemaVersion bump was needed for
   *  this, unlike `pinned` in v2D, since an old record simply lacking the
   *  key is already the correct, valid, "not yet embedded" state.
   *  embeddingModel records which model produced it, so a later change to
   *  EMBEDDING_MODEL can be detected as staleness instead of silently
   *  comparing vectors from two different models. */
  embedding?: number[];
  embeddingModel?: string;
  embeddingUpdatedAt?: string;
  createdAt: string;
  updatedAt: string;
  source: MemorySource;
};

export type MemoryData = {
  schemaVersion: number;
  profile: {
    name: string;
    favoriteColor: string;
    location: string;
    occupation: string;
  };
  preferences: string[];
  projects: string[];
  goals: Goal[];
  memories: MemoryRecord[];
  calendar: CalendarEvent[];
  conversations: Conversation[];
};

// v3 (Memory v2D): added MemoryRecord.pinned.
// v4 (Projects v1A): added MemoryRecord.scope/projectId — every pre-v4
// record defaults to scope:"global" (see sanitizeMemories below), same
// purely-additive posture the v2->v3 bump used: no record dropped,
// recreated, or re-IDed.
const CURRENT_SCHEMA_VERSION = 4;
const DEFAULT_CATEGORY: MemoryCategory = "other";
const DEFAULT_IMPORTANCE = 3;
const MAX_MEMORY_CONTENT_LENGTH = 300;

// The only fields updateProfile() will ever touch — closed set, not
// arbitrary object mutation from user text (see updateProfile below).
export type ProfileField = "name" | "favoriteColor" | "location" | "occupation";

export const PROFILE_FIELDS: readonly ProfileField[] = ["name", "favoriteColor", "location", "occupation"];

export function isProfileField(value: unknown): value is ProfileField {
  return typeof value === "string" && (PROFILE_FIELDS as readonly string[]).includes(value);
}

const MAX_PROFILE_VALUE_LENGTH = 100;

// ============================================================
// Test-only file path override
// ============================================================
//
// memoryService is inherently file-bound (it always operates on "the"
// memory.json), so tests need a way to point it at a throwaway file instead
// of the user's real one. Production code (server.ts) never calls these.

export function __setMemoryPathForTesting(testPath: string): void {
  memoryPath = testPath;
}

export function __resetMemoryPathForTesting(): void {
  memoryPath = DEFAULT_MEMORY_PATH;
}

// ============================================================
// Defaults, validation, migration
// ============================================================

function defaultMemoryData(): MemoryData {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    profile: { name: "", favoriteColor: "", location: "", occupation: "" },
    preferences: [],
    projects: [],
    goals: [],
    memories: [],
    calendar: [],
    conversations: [],
  };
}

function isMemoryCategory(value: unknown): value is MemoryCategory {
  return typeof value === "string" && (MEMORY_CATEGORIES as readonly string[]).includes(value);
}

function isMemorySource(value: unknown): value is MemorySource {
  return value === "user" || value === "assistant" || value === "system" || value === "migration";
}

function isMemoryScope(value: unknown): value is MemoryScope {
  return value === "global" || value === "project";
}

// Deliberately does NOT require `pinned` or `scope`/`projectId` — this is
// what lets a pre-v3 record (no `pinned`), a pre-v4 record (no `scope`),
// and a current record (has both) all validate here, so sanitizeMemories()
// below can be the single place that defaults missing/invalid fields,
// whether a record came from a normal read of an already-current file or
// from migrating an older one. Each field IS still type-checked when
// present, so a corrupt value never silently passes through.
function isValidMemoryRecordShape(
  value: unknown
): value is Omit<MemoryRecord, "pinned" | "scope" | "projectId"> & { pinned?: unknown; scope?: unknown; projectId?: unknown } {
  if (!value || typeof value !== "object") return false;

  const record = value as Record<string, unknown>;

  return (
    typeof record.id === "string" &&
    record.id.length > 0 &&
    typeof record.content === "string" &&
    record.content.length > 0 &&
    isMemoryCategory(record.category) &&
    typeof record.importance === "number" &&
    record.importance >= 1 &&
    record.importance <= 5 &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string" &&
    isMemorySource(record.source) &&
    (record.pinned === undefined || typeof record.pinned === "boolean") &&
    (record.scope === undefined || isMemoryScope(record.scope)) &&
    (record.projectId === undefined || typeof record.projectId === "string")
  );
}

function isValidEmbeddingVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "number" && Number.isFinite(v));
}

// The app should not blindly trust memory.json — drop malformed individual
// records (logging why) instead of letting one bad entry break everything.
// Also the single place `pinned` gets normalized: missing (pre-v3 record)
// or invalid defaults to false, never dropping the record over it.
//
// Memory v2E: embedding/embeddingModel/embeddingUpdatedAt are validated as
// a trio, not individually — a partially-corrupt embedding (e.g. a vector
// with no model recorded, which would make staleness-checking ambiguous)
// is dropped back to "no embedding" rather than kept half-broken. Losing
// an embedding here just means it gets regenerated on the next backfill
// pass (see memoryEmbeddings.ts) — never a reason to drop the memory
// itself.
function sanitizeMemories(value: unknown): MemoryRecord[] {
  if (!Array.isArray(value)) return [];

  const valid: MemoryRecord[] = [];

  for (const entry of value) {
    if (!isValidMemoryRecordShape(entry)) {
      console.error("Dropping malformed memory record from memory.json:", entry);
      continue;
    }

    // Projects v1A: scope defaults to "global" for any pre-v4 record (no
    // scope at all) or an invalid one — never dropped over it, matching
    // `pinned`'s own normalize-don't-discard posture. A "project" scope
    // record MUST carry a real projectId; one that doesn't (corrupt data)
    // is demoted back to "global" rather than kept as an orphaned project
    // memory pointing at nothing, which would be unfilterable by
    // filterMemoriesByScope.
    const scope: MemoryScope = isMemoryScope(entry.scope) ? entry.scope : "global";
    const projectId = typeof entry.projectId === "string" && entry.projectId.length > 0 ? entry.projectId : undefined;
    const scopeValid = scope === "global" ? true : projectId !== undefined;

    if (!scopeValid) {
      console.error(`Memory ${entry.id} had scope "project" with no valid projectId — demoted to "global"`);
    }

    const { scope: _rawScope, projectId: _rawProjectId, ...entryWithoutScopeFields } = entry;

    const sanitized: MemoryRecord = {
      ...entryWithoutScopeFields,
      pinned: typeof entry.pinned === "boolean" ? entry.pinned : false,
      scope: scopeValid ? scope : "global",
      ...(scopeValid && scope === "project" ? { projectId } : {}),
    };

    if (
      isValidEmbeddingVector(entry.embedding) &&
      typeof entry.embeddingModel === "string" &&
      entry.embeddingModel.length > 0 &&
      typeof entry.embeddingUpdatedAt === "string"
    ) {
      sanitized.embedding = entry.embedding;
      sanitized.embeddingModel = entry.embeddingModel;
      sanitized.embeddingUpdatedAt = entry.embeddingUpdatedAt;
    } else if (entry.embedding !== undefined) {
      console.error(`Dropping malformed embedding metadata on memory ${entry.id} — will be regenerated`);
    }

    valid.push(sanitized);
  }

  return valid;
}

function needsMigration(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return true;

  const data = raw as Record<string, unknown>;

  return data.schemaVersion !== CURRENT_SCHEMA_VERSION || !Array.isArray(data.memories);
}

// v1 -> v2: `facts: string[]` becomes `memories: MemoryRecord[]`. Every other
// top-level section is carried over unchanged (goals/calendar/conversations/
// profile/preferences/projects are separate concepts from memories and are
// never folded into MemoryRecord — see Objective 17).
function migrateLegacyData(raw: Record<string, unknown>): MemoryData {
  const now = new Date().toISOString();
  const base = defaultMemoryData();

  const legacyFacts = Array.isArray(raw.facts) ? raw.facts : [];

  const migratedMemories: MemoryRecord[] = legacyFacts
    .filter((fact): fact is string => typeof fact === "string" && fact.trim().length > 0)
    .map((content) => ({
      id: crypto.randomUUID(),
      content,
      category: DEFAULT_CATEGORY,
      importance: DEFAULT_IMPORTANCE,
      pinned: false,
      scope: "global" as const,
      createdAt: now,
      updatedAt: now,
      source: "migration" as const,
    }));

  const profile =
    raw.profile && typeof raw.profile === "object"
      ? { ...base.profile, ...(raw.profile as Record<string, unknown>) }
      : base.profile;

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    profile: profile as MemoryData["profile"],
    preferences: Array.isArray(raw.preferences) ? (raw.preferences as string[]) : [],
    projects: Array.isArray(raw.projects) ? (raw.projects as string[]) : [],
    goals: Array.isArray(raw.goals) ? (raw.goals as Goal[]) : [],
    memories: migratedMemories,
    calendar: Array.isArray(raw.calendar) ? (raw.calendar as CalendarEvent[]) : [],
    conversations: Array.isArray(raw.conversations) ? (raw.conversations as Conversation[]) : [],
  };
}

// Snapshots pre-migration content as memory.v1.backup.json, once. Never
// overwrites an existing backup — the user's original data takes priority
// over migration elegance.
function backupLegacyFileIfNeeded(): void {
  const backupPath = path.join(path.dirname(memoryPath), "memory.v1.backup.json");

  if (fs.existsSync(backupPath)) return;
  if (!fs.existsSync(memoryPath)) return;

  try {
    fs.copyFileSync(memoryPath, backupPath);
  } catch (error) {
    console.error("Failed to create memory.v1.backup.json:", error);
  }
}

// Snapshots pre-v3 (pre-pinning) content as memory.v2.backup.json, once,
// before the schema bump runs — mirrors backupLegacyFileIfNeeded above for
// the v1->v2 migration. Never overwrites an existing backup.
function backupPreV3IfNeeded(): void {
  const backupPath = path.join(path.dirname(memoryPath), "memory.v2.backup.json");

  if (fs.existsSync(backupPath)) return;
  if (!fs.existsSync(memoryPath)) return;

  try {
    fs.copyFileSync(memoryPath, backupPath);
  } catch (error) {
    console.error("Failed to create memory.v2.backup.json:", error);
  }
}

// Projects v1A (Objective 35/36 — "back up data before destructive
// migration"): snapshots pre-v4 (pre-scope) content as memory.v3.backup.json,
// once, before every memory record gets a scope:"global" field added.
// Purely additive like the v2->v3 bump, but still backed up on the same
// principle — never overwrites an existing backup.
function backupPreV4IfNeeded(): void {
  const backupPath = path.join(path.dirname(memoryPath), "memory.v3.backup.json");

  if (fs.existsSync(backupPath)) return;
  if (!fs.existsSync(memoryPath)) return;

  try {
    fs.copyFileSync(memoryPath, backupPath);
  } catch (error) {
    console.error("Failed to create memory.v3.backup.json:", error);
  }
}

// If memory.json exists but isn't valid JSON, preserve it under a
// timestamped name instead of silently discarding it, then fall back to a
// fresh structure so the app keeps working.
function quarantineCorruptFile(): void {
  try {
    const quarantinePath = path.join(path.dirname(memoryPath), `memory.corrupt.${Date.now()}.json`);
    fs.copyFileSync(memoryPath, quarantinePath);
    console.error(`Corrupt memory.json preserved at ${quarantinePath}`);
  } catch (error) {
    console.error("Failed to quarantine corrupt memory.json:", error);
  }
}

// ============================================================
// File I/O
// ============================================================

function readRawFile(): unknown {
  if (!fs.existsSync(memoryPath)) {
    return null;
  }

  let text: string;

  try {
    text = fs.readFileSync(memoryPath, "utf-8");
  } catch (error) {
    console.error("Failed to read memory.json:", error);
    return null;
  }

  if (!text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    console.error("memory.json is not valid JSON:", error);
    quarantineCorruptFile();
    return null;
  }
}

// write-to-temp-then-rename: rename is atomic on the same filesystem, so a
// crash mid-write leaves the previous good file intact instead of a
// truncated/corrupt one. Everything in this module is synchronous fs I/O
// with no `await` between a read and its matching write, so within this
// single-process server there is no interleaving window for one request's
// write to race another's — the temp+rename swap exists for crash-safety,
// not for cross-request locking (a lightweight lock was judged unnecessary
// complexity for a single local-dev Node process; revisit if that changes).
function writeMemoryFile(data: MemoryData): void {
  const tempPath = `${memoryPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, memoryPath);
}

export function readMemory(): MemoryData {
  const raw = readRawFile();

  if (needsMigration(raw)) {
    let migrated: MemoryData;

    if (raw && typeof raw === "object") {
      const rawObj = raw as Record<string, unknown>;

      if (Array.isArray(rawObj.memories)) {
        // Already has a memories[] array (v2, v3, or any version we don't
        // specifically recognize that kept this shape) — a light schema
        // bump, not a full re-derivation: back up, then let
        // sanitizeMemories() (which defaults missing/invalid `pinned` and
        // `scope`/`projectId`) normalize every existing record in place.
        // Never reads `facts`, never regenerates an id, never drops or
        // recreates a record — every other top-level section passes
        // through untouched. Both backups are idempotent (no-op once
        // already taken), so this safely covers a v2 file, a v3 file, or
        // anything in between in one pass.
        backupPreV3IfNeeded();
        backupPreV4IfNeeded();

        migrated = {
          ...defaultMemoryData(),
          ...rawObj,
          schemaVersion: CURRENT_SCHEMA_VERSION,
          memories: sanitizeMemories(rawObj.memories),
        } as MemoryData;
      } else {
        // True legacy v1 shape (`facts: string[]`, no memories[] at all).
        backupLegacyFileIfNeeded();
        migrated = migrateLegacyData(rawObj);
      }
    } else {
      migrated = defaultMemoryData();
    }

    writeMemoryFile(migrated);

    return migrated;
  }

  const data = raw as MemoryData;

  return {
    ...data,
    memories: sanitizeMemories(data.memories),
  };
}

export function saveMemory(data: MemoryData): void {
  writeMemoryFile(data);
}

// Every mutation below follows the same read -> modify -> write shape.
// Node's single-threaded, synchronous-I/O execution model already makes
// that shape safe from lost updates *as long as* nothing async is ever
// inserted between the read and the write — but until now that was only a
// convention each function had to individually honor, not something the
// code structurally guaranteed. mutateMemory() is that guarantee made
// explicit: it owns the read/save pair itself, so a mutator (a) can never
// forget to call saveMemory(), (b) can never accidentally read a second,
// independent copy of the data partway through (there's exactly one
// readMemory() call per mutation), and (c) if a future edit ever made the
// read or the write async, the mismatch between mutateMemory's synchronous
// signature and an async mutator would surface as a type error instead of
// silently reopening a lost-update window. This is deliberately still a
// plain in-process function, not a queue/lock/database — a heavier
// mechanism isn't warranted for a single local-dev Node process, per the
// project's own persistence design (see writeMemoryFile above).
function mutateMemory<T>(mutator: (memory: MemoryData) => T): T {
  const memory = readMemory();
  const result = mutator(memory);
  saveMemory(memory);
  return result;
}

// ============================================================
// Profile updates
// ============================================================
//
// The ONLY sanctioned way profile.* fields change (usability pass: fixes a
// bug where LOIS's chat reply claimed "I've updated your profile" while
// nothing had actually been mutated — the LLM reply and persistence were
// completely disconnected). Callers detect intent deterministically (see
// detectProfileUpdateIntent in memoryExtractor.ts) and must never pass a
// field name that didn't come from that closed ProfileField union — there
// is no path from raw user text to an arbitrary object key here.
//
// Returns the updated profile on success, or null if the value failed
// validation — callers (profileUpdatePipeline.ts) use that boolean to
// decide what to actually tell the user, so a claimed success can never
// diverge from what was actually persisted.
export function updateProfile(field: ProfileField, value: string): MemoryData["profile"] | null {
  const cleaned = value.trim();

  if (cleaned.length === 0 || cleaned.length > MAX_PROFILE_VALUE_LENGTH) {
    return null;
  }

  return mutateMemory((memory) => {
    // Single-valued canonical field: this assignment *is* "old value
    // replaced" — there is no array to append to and no second copy of
    // the old value left behind anywhere in `profile`.
    memory.profile[field] = cleaned;
    return memory.profile;
  });
}

// ============================================================
// Memory record operations
// ============================================================

function normalizeImportance(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) return DEFAULT_IMPORTANCE;
  return Math.min(5, Math.max(1, Math.round(value)));
}

export function getMemories(): MemoryRecord[] {
  return readMemory().memories;
}

export function getMemoryById(id: string): MemoryRecord | undefined {
  return readMemory().memories.find((memory) => memory.id === id);
}

export interface AddMemoryOptions {
  category?: MemoryCategory;
  importance?: number;
  source?: MemorySource;
  /** Projects v1A (Objective 6) — defaults to "global" when omitted, the
   *  same behavior every pre-existing caller already gets. Passing
   *  scope:"project" REQUIRES a projectId (see the guard below) — there is
   *  no way to create an orphaned project memory through this function. */
  scope?: MemoryScope;
  projectId?: string;
}

// Preserves the exact control flow of the legacy addFact(): the "remember
// that..." cleanup and the profile/preferences/projects/goals side effects
// (updateStructuredMemory) always run, even when the content turns out to
// be a duplicate or empty — only the memory record itself is conditionally
// created. Returns the created record, or null if nothing was added
// (duplicate or empty content after cleanup).
//
// Projects v1A: duplicate-detection is scope-aware (Objective 6/9's own
// context-isolation principle applied to dedup, not just retrieval) — a
// project memory only ever collides with an EXISTING memory in that SAME
// project, and a global memory only ever collides with another global one.
// A project fact that happens to reuse wording from an unrelated global
// fact (or a different project's fact) is not a duplicate of it.
export function addMemory(content: string, options: AddMemoryOptions = {}): MemoryRecord | null {
  return mutateMemory((memory) => {
    const cleanedContent = cleanRememberPhrase(content);
    const scope: MemoryScope = options.scope === "project" && options.projectId ? "project" : "global";
    const projectId = scope === "project" ? options.projectId : undefined;

    const alreadyExists = memory.memories.some(
      (existing) =>
        existing.content.toLowerCase() === cleanedContent.toLowerCase() &&
        existing.scope === scope &&
        existing.projectId === projectId
    );

    let created: MemoryRecord | null = null;

    if (!alreadyExists && cleanedContent.length > 0) {
      const now = new Date().toISOString();

      created = {
        id: crypto.randomUUID(),
        content: cleanedContent,
        category: options.category && isMemoryCategory(options.category) ? options.category : DEFAULT_CATEGORY,
        importance: normalizeImportance(options.importance),
        pinned: false,
        scope,
        ...(projectId ? { projectId } : {}),
        createdAt: now,
        updatedAt: now,
        source: options.source ?? "user",
      };

      memory.memories.push(created);
    }

    // Legacy structured-memory side effects (profile/preferences/projects[
    // strings]/goals) are unrelated to Projects v1A's scope concept — left
    // running unconditionally, unchanged, regardless of the new memory's
    // scope (Objective 17 of the original Memory v2B task already
    // established these as a separate concern from MemoryRecord storage).
    updateStructuredMemory(memory, cleanedContent);

    return created;
  });
}

// Bumps updatedAt without changing content/category/importance — used by
// the Memory v2B pipeline to record that an exact-duplicate candidate
// reaffirmed an existing memory, without creating a second record for it.
export function touchMemory(id: string): boolean {
  return mutateMemory((memory) => {
    const record = memory.memories.find((existing) => existing.id === id);

    if (!record) return false;

    record.updatedAt = new Date().toISOString();

    return true;
  });
}

export function deleteMemory(id: string): boolean {
  return mutateMemory((memory) => {
    const originalLength = memory.memories.length;

    memory.memories = memory.memories.filter((existing) => existing.id !== id);

    return memory.memories.length !== originalLength;
  });
}

// ============================================================
// Memory v2D — search/editing/pinning management
// ============================================================

// Every field a caller is allowed to change via updateMemory(). Explicitly
// NOT id/createdAt/source — see server.ts's PATCH /memories/:id, which
// only ever reads these four keys off a request body (Objective 21: no
// Object.assign(memory, req.body) anywhere near this).
export interface UpdateMemoryInput {
  content?: string;
  category?: MemoryCategory;
  importance?: number;
  pinned?: boolean;
}

export type UpdateMemoryResult =
  | { ok: true; memory: MemoryRecord }
  | {
      ok: false;
      reason: "not_found" | "invalid_content" | "invalid_category" | "invalid_importance" | "invalid_pinned" | "duplicate";
    };

// Edits a memory's content/category/importance/pinned IN PLACE — same id,
// same createdAt, same source, always. `updatedAt` is the only bookkeeping
// field this ever touches on the caller's behalf (Objective 4). Each
// provided field is individually validated (Objective 5/21); an omitted
// field is left exactly as it was. A content change that would exactly
// duplicate a DIFFERENT existing memory is rejected outright rather than
// silently creating a second copy of the same fact (Objective 5/24).
export function updateMemory(id: string, updates: UpdateMemoryInput): UpdateMemoryResult {
  return mutateMemory((memory) => {
    const record = memory.memories.find((existing) => existing.id === id);

    if (!record) {
      return { ok: false, reason: "not_found" };
    }

    let nextContent = record.content;

    if (updates.content !== undefined) {
      const cleaned = updates.content.trim();

      if (cleaned.length === 0 || cleaned.length > MAX_MEMORY_CONTENT_LENGTH) {
        return { ok: false, reason: "invalid_content" };
      }

      // Projects v1A: scope-aware, matching addMemory's own dedup posture —
      // an edited memory only collides with another memory in the SAME
      // scope (same project, or global-vs-global), never across a project
      // boundary.
      const duplicate = memory.memories.some(
        (other) =>
          other.id !== id &&
          other.content.toLowerCase() === cleaned.toLowerCase() &&
          other.scope === record.scope &&
          other.projectId === record.projectId
      );

      if (duplicate) {
        return { ok: false, reason: "duplicate" };
      }

      nextContent = cleaned;
    }

    let nextCategory = record.category;

    if (updates.category !== undefined) {
      if (!isMemoryCategory(updates.category)) {
        return { ok: false, reason: "invalid_category" };
      }

      nextCategory = updates.category;
    }

    let nextImportance = record.importance;

    if (updates.importance !== undefined) {
      if (!Number.isInteger(updates.importance) || updates.importance < 1 || updates.importance > 5) {
        return { ok: false, reason: "invalid_importance" };
      }

      nextImportance = updates.importance;
    }

    let nextPinned = record.pinned;

    if (updates.pinned !== undefined) {
      if (typeof updates.pinned !== "boolean") {
        return { ok: false, reason: "invalid_pinned" };
      }

      nextPinned = updates.pinned;
    }

    // Every field validated above — only now does the record actually
    // change, so a rejected update never partially applies.
    const contentChanged = nextContent !== record.content;

    record.content = nextContent;
    record.category = nextCategory;
    record.importance = nextImportance;
    record.pinned = nextPinned;
    record.updatedAt = new Date().toISOString();

    // Memory v2E / Objective 14: an embedding represents specific text —
    // once that text changes, the old vector is actively wrong (not just
    // stale), so it's cleared synchronously here, in the same mutation,
    // rather than left in place until a background regeneration happens to
    // run. category/importance/pinned changes deliberately do NOT reach
    // this branch (Objective 4) since the embedding input is content only.
    if (contentChanged) {
      delete record.embedding;
      delete record.embeddingModel;
      delete record.embeddingUpdatedAt;
    }

    return { ok: true, memory: record };
  });
}

// Memory v2E — the only writer of embedding/embeddingModel/embeddingUpdatedAt.
// Deliberately separate from updateMemory(): generating an embedding is an
// async Ollama call (see memoryEmbeddings.ts), while every other mutation
// in this file is synchronous. Callers await the embedding generation
// first, then call this narrow, synchronous setter to persist the result
// through the same mutateMemory() path everything else uses — no second,
// divergent write mechanism. Silently no-ops if the memory was deleted (or
// its content changed again) before the async embedding call resolved,
// rather than resurrecting/half-applying a result for a record that has
// since moved on.
export function setMemoryEmbedding(id: string, embedding: number[], model: string): boolean {
  return mutateMemory((memory) => {
    const record = memory.memories.find((existing) => existing.id === id);

    if (!record) return false;

    record.embedding = embedding;
    record.embeddingModel = model;
    record.embeddingUpdatedAt = new Date().toISOString();

    return true;
  });
}

// ============================================================
// Calendar
// ============================================================

export interface AddCalendarEventInput {
  title: string;
  /** ISO YYYY-MM-DD. */
  date: string;
  timeText?: string;
  recurrence?: CalendarRecurrence;
}

// Action Execution Layer v1 — replaces the old `(input: string): void`
// signature, which took a raw, un-parsed message and guessed a date from a
// tiny fixed keyword list (today/tomorrow/weekday names only — nothing
// resembling a real calendar date like "March 20", and no concept of
// recurrence at all). That was the concrete root cause of the reported
// birthday bug: even on the one route that ever called it, this function
// could not have represented "March 20 every year" no matter what phrasing
// reached it. Callers now do real parsing (see actionExtractor.ts) BEFORE
// calling this, so this function's only job is persisting an already-valid
// structured event and returning it — the same "service functions never
// parse user text themselves" boundary the rest of this module already
// keeps for goals/memories.
export function addCalendarEvent(input: AddCalendarEventInput): CalendarEvent {
  return mutateMemory((memory) => {
    const now = new Date().toISOString();

    const event: CalendarEvent = {
      id: crypto.randomUUID(),
      title: input.title,
      date: input.date,
      dateText: formatDateText(input.date, input.recurrence),
      timeText: input.timeText ?? "time not set",
      recurrence: input.recurrence,
      createdAt: now,
      updatedAt: now,
    };

    memory.calendar.push(event);

    return event;
  });
}

export function deleteCalendarEvent(eventId: string): boolean {
  return mutateMemory((memory) => {
    const originalLength = memory.calendar.length;

    memory.calendar = memory.calendar.filter((event) => event.id !== eventId);

    return memory.calendar.length !== originalLength;
  });
}

// ============================================================
// Conversations
// ============================================================

export function clearConversations(): void {
  mutateMemory((memory) => {
    memory.conversations = [];
  });
}

export function addConversation(
  agent: string,
  userMessage: string,
  assistantReply: string
): void {
  mutateMemory((memory) => {
    memory.conversations.push({
      agent,
      userMessage,
      assistantReply,
      timestamp: new Date().toISOString()
    });
  });
}

// ============================================================
// Deterministic natural-language triggers (unchanged from v1)
// ============================================================

function cleanRememberPhrase(input: string): string {
  return input
    .replace(/^remember that\s+/i, "")
    .replace(/^remember:\s*/i, "")
    .replace(/^please remember that\s+/i, "")
    .replace(/^lois,?\s+remember that\s+/i, "")
    .replace(/^lois,?\s+remember:\s*/i, "")
    .trim()
    .replace(/\.$/, "");
}

// Mirrors EXPLICIT_GOAL_PATTERNS in memoryExtractor.ts (kept as a separate
// literal list rather than a shared import to avoid a circular dependency
// between the two modules — the same tradeoff cleanRememberPhrase below
// already makes against EXPLICIT_MEMORY_PATTERNS). Update both lists
// together if a new goal-command phrasing is added.
function cleanGoalPhrase(input: string): string {
  return input
    .replace(/^add goal:?\s*/i, "")
    .replace(/^add a goal:?\s*/i, "")
    .replace(/^create goal:?\s*/i, "")
    .replace(/^create a goal:?\s*/i, "")
    .replace(/^new goal:?\s*/i, "")
    .replace(/^set goal:?\s*/i, "")
    .replace(/^set a goal:?\s*/i, "")
    .replace(/^my goal is\s*/i, "")
    .replace(/^one of my goals is\s*/i, "")
    .replace(/^i want to\s*/i, "")
    .replace(/^my goal is to\s*/i, "")
    .replace(/\.$/, "")
    .trim();
}

function addGoal(memory: MemoryData, title: string): void {
  const exists = memory.goals.some(
    (goal) => goal.title.toLowerCase() === title.toLowerCase()
  );

  if (exists) return;

  memory.goals.push({
    id: crypto.randomUUID(),
    title,
    completed: false,
    createdAt: new Date().toISOString()
  });
}

// Usability pass: the entry point for explicit "add goal: ..."-style
// commands (see isExplicitGoalCommand in memoryExtractor.ts /
// processExplicitGoalCommand in memoryPipeline.ts). Deliberately separate
// from addMemory() — a goal command should create a Goal and nothing else,
// never also a generic MemoryRecord (that duplication across two systems
// is exactly the architectural issue this fixes). Reuses the same
// cleanGoalPhrase() + case-insensitive title dedup that
// updateStructuredMemory()'s looser goal detection already relies on, so
// the two paths can never disagree about what counts as a duplicate goal.
export function addGoalFromCommand(text: string): Goal | null {
  return mutateMemory((memory) => {
    const cleanedGoal = cleanGoalPhrase(text);

    if (!cleanedGoal) return null;

    const exists = memory.goals.some((goal) => goal.title.toLowerCase() === cleanedGoal.toLowerCase());
    if (exists) return null;

    const goal: Goal = {
      id: crypto.randomUUID(),
      title: cleanedGoal,
      completed: false,
      createdAt: new Date().toISOString(),
    };

    memory.goals.push(goal);

    return goal;
  });
}

export function completeGoal(goalId: string): boolean {
  return mutateMemory((memory) => {
    const goal = memory.goals.find((item) => item.id === goalId);

    if (!goal) return false;

    goal.completed = true;

    return true;
  });
}

export function deleteGoal(goalId: string): boolean {
  return mutateMemory((memory) => {
    const originalLength = memory.goals.length;

    memory.goals = memory.goals.filter((goal) => goal.id !== goalId);

    return memory.goals.length !== originalLength;
  });
}

// Action Execution Layer v2 (Objective 2/3/4) — atomically makes the
// ACTIVE (non-completed) goals collection equal to exactly `titles`,
// through the same mutateMemory() read-mutate-write-atomically path every
// other mutation in this file uses (never raw JSON manipulation from a
// caller).
//
// Semantics (Objective 3): a completed goal is a historical record — this
// function never reads, matches against, reactivates, or deletes a
// completed goal, no matter what titles are requested. Only the active
// subset is replaced. This mirrors how the rest of the app already treats
// the active/completed distinction (e.g. RightPanels' CURRENT GOALS card
// already filters out completed goals before rendering — "active" and
// "historical" are already meaningfully different lists here, not a new
// distinction invented for this function).
//
// ID stability (Objective 4): a requested title that case-insensitively
// matches an EXISTING active goal's title keeps that goal's id/createdAt
// untouched (not identified by array position); a genuinely new title
// gets a fresh id. An active goal whose title isn't in the new list is
// dropped — that is the entire point of "replace".
export function replaceGoals(titles: string[]): Goal[] {
  return mutateMemory((memory) => {
    const activeGoals = memory.goals.filter((goal) => !goal.completed);
    const completedGoals = memory.goals.filter((goal) => goal.completed);
    const now = new Date().toISOString();

    const nextActive: Goal[] = titles.map((title) => {
      const existing = activeGoals.find((goal) => goal.title.toLowerCase() === title.toLowerCase());

      return (
        existing ?? {
          id: crypto.randomUUID(),
          title,
          completed: false,
          createdAt: now,
        }
      );
    });

    memory.goals = [...completedGoals, ...nextActive];

    return nextActive;
  });
}

// Side effects on profile/preferences/projects/goals triggered by fact-like
// text. Deliberately separate from MemoryRecord storage (Objective 17) —
// goals stay goals, profile stays profile, etc.
function updateStructuredMemory(memory: MemoryData, fact: string): void {
  const lowerFact = fact.toLowerCase();

  if (lowerFact.includes("favorite color is")) {
    memory.profile.favoriteColor = extractAfterPhrase(fact, "favorite color is");
  }

  if (lowerFact.includes("i live in")) {
    memory.profile.location = extractAfterPhrase(fact, "i live in");
  }

  if (lowerFact.includes("i am a") || lowerFact.includes("i'm a")) {
    memory.profile.occupation = fact;
  }

  if (lowerFact.includes("i prefer") || lowerFact.includes("my preference is")) {
    addUnique(memory.preferences, fact);
  }

  if (lowerFact.includes("project") || lowerFact.includes("app")) {
    addUnique(memory.projects, fact);
  }

  if (
    lowerFact.includes("goal is") ||
    lowerFact.includes("my goal is") ||
    lowerFact.includes("one of my goals is") ||
    lowerFact.includes("i want to") ||
    lowerFact.startsWith("add goal")
  ) {
    const cleanedGoal = cleanGoalPhrase(fact);
    addGoal(memory, cleanedGoal);
  }
}

function extractAfterPhrase(input: string, phrase: string): string {
  const index = input.toLowerCase().indexOf(phrase.toLowerCase());

  if (index === -1) return input;

  return input.slice(index + phrase.length).trim().replace(/\.$/, "");
}

function addUnique(list: string[], value: string): void {
  if (!list.includes(value)) {
    list.push(value);
  }
}

// ============================================================
// Agent prompt context
// ============================================================

// Memory v2C: `message` is the current user message and is used as the
// retrieval query (Objective 12 — never the assistant's reply or the system
// prompt). Only the memories that clear the relevance floor, ranked and
// budgeted by retrieveRelevantMemories(), are injected — this replaced the
// old behavior of unconditionally dumping every stored memory into every
// prompt (memory.memories.map(...) with no filtering at all).
//
// Profile/preferences/projects/goals/calendar/conversations are unrelated
// top-level structures (Objective 17/19) and are intentionally left as-is:
// still always included in full, not retrieval-filtered. Note there is a
// real, pre-existing overlap risk here — `preferences`/`projects` are
// populated by the same keyword-triggered side effects
// (updateStructuredMemory) that can also produce a MemoryRecord for the
// same stated fact via Memory v2B extraction, so the same underlying fact
// can legitimately appear in both the "Preferences"/"Projects" section
// below AND in "Relevant Memories" if it's retrieval-relevant. Resolving
// that duplication would mean reworking the v1 profile/preferences/projects
// data model, which is explicitly out of scope for this task.
// Memory v2E: async now, purely because retrieveRelevantMemories needs to
// await one embedding call for the query (Objective 6) — retrieval itself
// still degrades gracefully to synchronous-equivalent lexical-only
// behavior if that call fails, it just can't be a synchronous function
// signature anymore either way.
export async function getMemoryContext(message: string): Promise<string> {
  const memory = readMemory();

  const { selected } = await retrieveRelevantMemories({
    message,
    memories: memory.memories,
    maxMemories: RETRIEVAL_CONFIG.MAX_RETRIEVED_MEMORIES,
    maxCharacters: RETRIEVAL_CONFIG.MAX_MEMORY_CONTEXT_CHARS,
  });

  return `
User Profile:
- Name: ${memory.profile.name}
- Favorite Color: ${memory.profile.favoriteColor || "Unknown"}
- Location: ${memory.profile.location || "Unknown"}
- Occupation: ${memory.profile.occupation || "Unknown"}

Preferences:
${formatList(memory.preferences)}

Projects:
${formatList(memory.projects)}

Goals:
${memory.goals.length > 0
  ? memory.goals
      .map((goal) => `- ${goal.completed ? "[Complete]" : "[Active]"} ${goal.title}`)
      .join("\n")
  : "- None"}

Relevant Memories:
${formatRetrievedMemories(selected)}

Calendar:
${memory.calendar.length > 0
  ? memory.calendar
      .slice(-5)
      .map((event) => `- ${event.title} (${event.dateText}, ${event.timeText})`)
      .join("\n")
  : "- None"}

Recent Conversations:
${memory.conversations
  .slice(-5)
  .map((c) => `User: ${c.userMessage}\nAssistant: ${c.assistantReply}`)
  .join("\n\n")}
`;
}

function formatList(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None";
}
