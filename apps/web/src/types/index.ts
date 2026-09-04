// Shared frontend types for the LOIS / IGNIS HUD.
//
// These were originally declared inline at the top of App.tsx. Moved here
// verbatim (structure unchanged) so they can be reused across hooks,
// services, and components without duplication.

export type Agent = "lois" | "ignis";

export type HudView = "chat" | "memory" | "goals" | "calendar" | "voice" | "documents" | "projects";

export type VoiceState = "standby" | "listening" | "thinking" | "speaking";

export type StoredConversation = {
  agent: Agent;
  userMessage: string;
  assistantReply: string;
  timestamp: string;
};

export type Goal = {
  id: string;
  title: string;
  completed: boolean;
  createdAt: string;
};

// Action Execution Layer v1 — must match CalendarRecurrence in
// apps/api/src/actions/assistantAction.ts.
export type CalendarRecurrenceFrequency = "daily" | "weekly" | "monthly" | "yearly";

export type CalendarRecurrence = {
  frequency: CalendarRecurrenceFrequency;
  interval: number;
};

// Must match CalendarEvent in apps/api/src/memory/memoryService.ts.
// `date`/`recurrence` are optional — absent on any event created before
// this change (no migration was needed on the backend, so none is needed
// here either; the UI just shows those exactly as before).
export type CalendarEvent = {
  id: string;
  title: string;
  dateText: string;
  timeText: string;
  date?: string;
  recurrence?: CalendarRecurrence;
  createdAt: string;
  updatedAt: string;
};

// Deliberately conservative — this is the foundation later Memory v2 stages
// build on, not the final taxonomy. Must match MemoryCategory in
// apps/api/src/memory/memoryService.ts.
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

// Same list as MEMORY_CATEGORIES in apps/api/src/memory/memoryService.ts —
// kept as a separate literal (not shared across the network boundary) so
// the category filter/editor in MemoryView always has a synchronous,
// definite list to render, matching the pattern already used for
// server-side pattern lists that mirror each other (see cleanGoalPhrase /
// EXPLICIT_GOAL_PATTERNS in the API). Update both together if a category
// is ever added.
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

// "migration" identifies facts carried over from the legacy `facts: string[]`
// schema. Must match MemorySource in apps/api/src/memory/memoryService.ts.
export type MemorySource = "user" | "assistant" | "system" | "migration";

// Projects v1A — must match MemoryScope in
// apps/api/src/memory/memoryService.ts.
export type MemoryScope = "global" | "project";

export type MemoryRecord = {
  id: string;
  content: string;
  category: MemoryCategory;
  /** 1 (minor) – 5 (critical). */
  importance: number;
  /** Memory v2D — user-marked as worth keeping visually surfaced. */
  pinned: boolean;
  /** Projects v1A — "global" for every memory that predates this feature
   *  and every memory created outside a project. Only "project" for a
   *  memory created inside a project conversation (see projectId). */
  scope: MemoryScope;
  /** Set if and only if scope === "project". */
  projectId?: string;
  createdAt: string;
  updatedAt: string;
  source: MemorySource;
};

export type MemoryData = {
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
};

// The /memory endpoint returns MemoryData plus the raw conversation log,
// which is used separately to rehydrate chat history on load.
export type MemorySnapshot = MemoryData & {
  conversations: StoredConversation[];
};

export type ChatMessage = {
  role: "user" | "assistant";
  agent?: Agent;
  text: string;
  /** Projects v1A — present on messages loaded from a Conversation record;
   *  absent on a message still being composed/streamed locally before the
   *  backend has persisted it. Optional so existing rendering code that
   *  never looked at a timestamp keeps working unchanged. */
  timestamp?: string;
};

// ============================================================
// Projects v1A — project workspaces, chats, shared agent context
// ============================================================

// Must match Project in apps/api/src/projects/projectService.ts.
export type Project = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  contextSummary: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
};

// Must match ConversationSummary in
// apps/api/src/conversations/conversationService.ts — metadata only, no
// message bodies (that's what GET /conversations returns for a list).
export type ConversationSummary = {
  id: string;
  title: string;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  copiedFromConversationId?: string;
};

// Must match Conversation in
// apps/api/src/conversations/conversationService.ts — the full record,
// including messages (what GET /conversations/:id returns).
export type Conversation = {
  id: string;
  title: string;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  copiedFromConversationId?: string;
};

// Documents v1A — local file ingestion, parsing, metadata, and document
// management. Must match DocumentFileType in
// apps/api/src/documents/documentConfig.ts.
export type DocumentFileType = "txt" | "md" | "json" | "csv" | "pdf" | "docx" | "code";

// Must match DocumentStatus in apps/api/src/documents/documentService.ts.
export type DocumentStatus = "ready" | "processing" | "error";

// The shape the backend actually sends over the wire — PublicDocumentRecord
// in documentService.ts, i.e. DocumentRecord with storagePath stripped
// (Objective 15: never expose an arbitrary filesystem path to the
// frontend). Deliberately does NOT include the extracted text itself
// (Objective 1) — that's fetched separately, on demand, via
// getDocumentContent.
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
  textLength: number;
  contentHash: string;
  /** Projects v1A follow-up — null/undefined means a global document, not
   *  attached to any project. */
  projectId?: string | null;
  error?: string;
};
