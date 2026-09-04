import fs from "fs";
import path from "path";
import crypto from "crypto";

// Projects v1A — Project data model and persistence.
//
// A Project is a persistent context boundary/workspace (see the task's own
// "IMPORTANT ARCHITECTURAL PRINCIPLE"): global context (profile, global
// memories) stays available everywhere, but a project's own instructions
// and project-scoped memories (see memory/memoryRetriever.ts's
// filterMemoriesByScope) are only ever visible inside that project.
//
// Storage layout, mirroring documentService.ts's own data/<feature>/
// convention:
//   apps/api/data/projects/index.json — every project's metadata, atomic
//     write (temp-then-rename), same pattern as memoryService/
//     documentService.
//
// Deliberately NOT storage for conversations (see conversations/
// conversationService.ts) or project memories (see memory/memoryService.ts
// — a MemoryRecord.projectId just references a project's id, it isn't
// stored on the Project record itself). A Project row only ever holds its
// own identity/instructions/summary — never another entity's data.

export type Project = {
  id: string;
  name: string;
  description: string;
  /** Behavioral/contextual — included in the agent prompt while operating
   *  inside this project (Objective 4). Never affects conversations outside
   *  the project. */
  instructions: string;
  /** Objective 30 — architecture for a future project-level summary of
   *  accumulated project knowledge. Manually editable for v1A; nothing
   *  populates this automatically yet (no LLM summarization in this task). */
  contextSummary: string;
  createdAt: string;
  updatedAt: string;
  /** Objective 28 — archived projects persist and remain recoverable, they
   *  just drop out of the default active list. */
  archived: boolean;
};

const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;
// Raised from 4000 — a real user project (a full game-design/lore bible for
// a multi-system project) needed roughly 25-30k characters and was being
// hard-rejected (updateProject returns "invalid_instructions", surfaced to
// the user as "Invalid instructions") rather than silently truncated the
// way createProject's own initial-instructions path already was. 40000
// gives headroom for that kind of document to grow further while staying
// comfortably under express.json()'s default 100kb body-size limit.
//
// Tradeoff, by user's explicit choice over trimming the document: this
// entire block gets re-injected into EVERY chat prompt sent to LOIS/IGNIS
// inside that project (see agentPrompt.ts's buildProjectSection), and this
// app's own Performance Pass v1 measured that prompt size directly drives
// response latency on CPU-only Ollama inference — a project using anywhere
// near this full limit will see noticeably slower responses than a project
// with short instructions. This is a deliberate per-project cost the user
// accepted, not an oversight.
const MAX_INSTRUCTIONS_LENGTH = 40000;
const MAX_CONTEXT_SUMMARY_LENGTH = 4000;

const DEFAULT_DATA_DIR = path.join(__dirname, "..", "..", "data", "projects");

// Mutable only so tests can point the service at an isolated directory —
// never reassigned by production code. Every path below is a FUNCTION (not
// a frozen const computed once at module load) so the override actually
// takes effect wherever it's read, mirroring documentService.ts's own
// __setDocumentDataDirForTesting fix.
let dataDir = DEFAULT_DATA_DIR;

function getDataDir(): string {
  return dataDir;
}

function getIndexPath(): string {
  return path.join(getDataDir(), "index.json");
}

const CURRENT_INDEX_VERSION = 1;

type ProjectIndex = {
  schemaVersion: number;
  projects: Project[];
};

function defaultIndex(): ProjectIndex {
  return { schemaVersion: CURRENT_INDEX_VERSION, projects: [] };
}

export function initProjectStorage(): void {
  fs.mkdirSync(getDataDir(), { recursive: true });

  if (!fs.existsSync(getIndexPath())) {
    writeIndex(defaultIndex());
  }
}

function isValidProject(value: unknown): value is Project {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;

  return (
    typeof r.id === "string" &&
    r.id.length > 0 &&
    typeof r.name === "string" &&
    typeof r.description === "string" &&
    typeof r.instructions === "string" &&
    typeof r.contextSummary === "string" &&
    typeof r.createdAt === "string" &&
    typeof r.updatedAt === "string" &&
    typeof r.archived === "boolean"
  );
}

// Never trust index.json blindly — drop malformed individual records
// (logging why) rather than letting one bad entry break the whole list,
// same posture as memoryService.sanitizeMemories / documentService.
// sanitizeDocuments.
function sanitizeProjects(value: unknown): Project[] {
  if (!Array.isArray(value)) return [];

  const valid: Project[] = [];

  for (const entry of value) {
    if (isValidProject(entry)) {
      valid.push(entry);
    } else {
      console.error("Dropping malformed project record from index.json:", entry);
    }
  }

  return valid;
}

function readIndex(): ProjectIndex {
  if (!fs.existsSync(getIndexPath())) {
    return defaultIndex();
  }

  let text: string;

  try {
    text = fs.readFileSync(getIndexPath(), "utf-8");
  } catch (error) {
    console.error("Failed to read projects/index.json:", error);
    return defaultIndex();
  }

  if (!text.trim()) {
    return defaultIndex();
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    console.error("projects/index.json is not valid JSON:", error);
    quarantineCorruptIndex();
    return defaultIndex();
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as Record<string, unknown>).projects)) {
    return defaultIndex();
  }

  return {
    schemaVersion: CURRENT_INDEX_VERSION,
    projects: sanitizeProjects((parsed as { projects: unknown }).projects),
  };
}

function quarantineCorruptIndex(): void {
  try {
    const quarantinePath = path.join(getDataDir(), `index.corrupt.${Date.now()}.json`);
    fs.copyFileSync(getIndexPath(), quarantinePath);
    console.error(`Corrupt projects index.json preserved at ${quarantinePath}`);
  } catch (error) {
    console.error("Failed to quarantine corrupt projects index.json:", error);
  }
}

// write-to-temp-then-rename — same rationale as memoryService/
// documentService: rename is atomic on the same filesystem, so a crash
// mid-write leaves the previous good index intact.
function writeIndex(index: ProjectIndex): void {
  fs.mkdirSync(getDataDir(), { recursive: true });
  const tempPath = `${getIndexPath()}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(index, null, 2));
  fs.renameSync(tempPath, getIndexPath());
}

// Same serialized read-modify-write shape as memoryService's mutateMemory()
// / documentService's mutateIndex() — race-safe under Node's single-
// threaded synchronous execution as long as nothing async happens between
// the read and the write, which this enforces structurally.
function mutateIndex<T>(mutator: (index: ProjectIndex) => T): T {
  const index = readIndex();
  const result = mutator(index);
  writeIndex(index);
  return result;
}

// Objective 22 — default active list excludes archived projects. Sorted
// newest-updated-first, same convention as documentService.listDocuments().
export function listProjects(options: { includeArchived?: boolean } = {}): Project[] {
  const projects = readIndex().projects;
  const filtered = options.includeArchived ? projects : projects.filter((p) => !p.archived);
  return [...filtered].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getProjectById(id: string): Project | undefined {
  return readIndex().projects.find((p) => p.id === id);
}

export type CreateProjectInput = {
  name: string;
  description?: string;
  instructions?: string;
};

export type CreateProjectResult = { ok: true; project: Project } | { ok: false; reason: "invalid_name" };

// Objective 1/23 — stable crypto.randomUUID() identity, never the name
// (two projects may share a name). Only name is required; description/
// instructions default to empty strings, not undefined, so every Project
// record always has the full shape (simpler for callers/UI than optional
// fields that need their own "not set" branch everywhere).
export function createProject(input: CreateProjectInput): CreateProjectResult {
  const name = (input.name ?? "").trim();

  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    return { ok: false, reason: "invalid_name" };
  }

  const description = (input.description ?? "").trim().slice(0, MAX_DESCRIPTION_LENGTH);
  const instructions = (input.instructions ?? "").trim().slice(0, MAX_INSTRUCTIONS_LENGTH);
  const now = new Date().toISOString();

  const project: Project = {
    id: crypto.randomUUID(),
    name,
    description,
    instructions,
    contextSummary: "",
    createdAt: now,
    updatedAt: now,
    archived: false,
  };

  mutateIndex((index) => {
    index.projects.push(project);
  });

  return { ok: true, project };
}

export type UpdateProjectInput = {
  name?: string;
  description?: string;
  instructions?: string;
  contextSummary?: string;
};

export type UpdateProjectResult =
  | { ok: true; project: Project }
  | { ok: false; reason: "not_found" | "invalid_name" | "invalid_description" | "invalid_instructions" | "invalid_context_summary" };

// Objective 27 — basic editing (rename/description/instructions). Each
// provided field is validated independently; an omitted field is left
// exactly as it was, same posture as memoryService.updateMemory.
export function updateProject(id: string, updates: UpdateProjectInput): UpdateProjectResult {
  return mutateIndex((index) => {
    const project = index.projects.find((p) => p.id === id);
    if (!project) return { ok: false, reason: "not_found" };

    if (updates.name !== undefined) {
      const trimmed = updates.name.trim();
      if (trimmed.length === 0 || trimmed.length > MAX_NAME_LENGTH) {
        return { ok: false, reason: "invalid_name" };
      }
      project.name = trimmed;
    }

    if (updates.description !== undefined) {
      if (updates.description.length > MAX_DESCRIPTION_LENGTH) {
        return { ok: false, reason: "invalid_description" };
      }
      project.description = updates.description.trim();
    }

    if (updates.instructions !== undefined) {
      if (updates.instructions.length > MAX_INSTRUCTIONS_LENGTH) {
        return { ok: false, reason: "invalid_instructions" };
      }
      project.instructions = updates.instructions.trim();
    }

    if (updates.contextSummary !== undefined) {
      if (updates.contextSummary.length > MAX_CONTEXT_SUMMARY_LENGTH) {
        return { ok: false, reason: "invalid_context_summary" };
      }
      project.contextSummary = updates.contextSummary.trim();
    }

    project.updatedAt = new Date().toISOString();

    return { ok: true, project };
  });
}

// Objective 28 — archiving is the primary "remove from active list" action;
// the project and everything referencing it (chats, memories) is untouched
// and fully recoverable via unarchiveProject.
export function archiveProject(id: string): boolean {
  return mutateIndex((index) => {
    const project = index.projects.find((p) => p.id === id);
    if (!project) return false;
    project.archived = true;
    project.updatedAt = new Date().toISOString();
    return true;
  });
}

export function unarchiveProject(id: string): boolean {
  return mutateIndex((index) => {
    const project = index.projects.find((p) => p.id === id);
    if (!project) return false;
    project.archived = false;
    project.updatedAt = new Date().toISOString();
    return true;
  });
}

// Objective 42 — deletion itself never touches conversations/memories; the
// caller (server.ts) is responsible for deciding what happens to a
// project's chats BEFORE calling this (the recommended, implemented
// behavior: return them to global/unassigned — see the DELETE /projects/:id
// route, which calls conversationService.removeAllFromProject() first).
// Keeping that orchestration in server.ts rather than here avoids
// projectService needing to depend on conversationService at all.
export function deleteProject(id: string): boolean {
  return mutateIndex((index) => {
    const originalLength = index.projects.length;
    index.projects = index.projects.filter((p) => p.id !== id);
    return index.projects.length !== originalLength;
  });
}

// ============================================================
// Test-only data directory override — mirrors documentService's
// __setDocumentDataDirForTesting.
// ============================================================

export function __setProjectDataDirForTesting(dir: string): void {
  dataDir = dir;
}

export function __resetProjectDataDirForTesting(): void {
  dataDir = DEFAULT_DATA_DIR;
}
