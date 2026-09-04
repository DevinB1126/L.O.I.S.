import fs from "fs";
import path from "path";
import crypto from "crypto";
import { readMemory } from "../memory/memoryService";

// Projects v1A — Conversation/chat model and persistence.
//
// Before this, LOIS had no chat/thread concept at all: every turn (from
// either agent) was appended to ONE flat array (memory.json's
// `conversations: {agent,userMessage,assistantReply,timestamp}[]`) with no
// id, no title, and no way to have more than one conversation open at a
// time. This module replaces that as the source of truth going forward —
// see migrateLegacyConversationsIfNeeded() below for how the one existing
// flat log becomes the first real Conversation record, preserved exactly
// (Objective 36: existing conversations must survive; Objective 23: past
// chats are never silently discarded).
//
// A Conversation is a single chat THREAD. `projectId: null` means a normal/
// global chat (Objective 2/20) — the existing single-stream chat
// experience keeps working exactly as before, it's just now backed by one
// specific Conversation record instead of an untyped flat array. Multiple
// independent conversations (global or per-project) are fully supported;
// opening one never merges its transcript with another (Objective 3).
//
// Storage layout, mirroring documentService.ts's data/<feature>/
// convention:
//   apps/api/data/conversations/index.json — every conversation (including
//     its full message list), atomic write (temp-then-rename).
//
// Deliberately does NOT know about Project (see projects/projectService.ts)
// beyond storing a project's id as a plain string — no import of
// projectService here, so there is no circular dependency between the two
// services; project identity/instructions are resolved elsewhere
// (conversations/agentContext.ts) when building a prompt.

export type MessageRole = "user" | "assistant";
export type AgentName = "lois" | "ignis";

export type ChatMessage = {
  role: MessageRole;
  /** Only set on assistant messages — which agent produced this reply
   *  (Objective 11: attribution survives even though project context is
   *  shared between LOIS and IGNIS). */
  agent?: AgentName;
  text: string;
  timestamp: string;
};

export type Conversation = {
  id: string;
  title: string;
  /** null = normal/global chat (Objective 2). */
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  /** Objective 16 — set only on a COPY, points at the conversation it was
   *  copied from. Absent on every other conversation, including the
   *  original that was copied FROM. */
  copiedFromConversationId?: string;
};

/** What GET /conversations (the list endpoint) returns — metadata only,
 *  never the full message array, mirroring documentService's own
 *  metadata-only list pattern so listing stays cheap regardless of how
 *  long any individual chat has gotten. */
export type ConversationSummary = Omit<Conversation, "messages"> & { messageCount: number };

const MAX_TITLE_LENGTH = 200;
const DEFAULT_TITLE_FALLBACK_LENGTH = 60;

const DEFAULT_DATA_DIR = path.join(__dirname, "..", "..", "data", "conversations");

let dataDir = DEFAULT_DATA_DIR;

function getDataDir(): string {
  return dataDir;
}

function getIndexPath(): string {
  return path.join(getDataDir(), "index.json");
}

const CURRENT_INDEX_VERSION = 1;

type ConversationIndex = {
  schemaVersion: number;
  conversations: Conversation[];
};

function defaultIndex(): ConversationIndex {
  return { schemaVersion: CURRENT_INDEX_VERSION, conversations: [] };
}

// Called once at server startup (mirrors initDocumentStorage). Creates the
// directory and, on a fresh/first run, migrates the legacy flat
// memory.json conversation log into ONE Conversation (Objective 36) —
// never runs the migration again once conversations/index.json exists, so
// it's safe to call repeatedly.
export function initConversationStorage(): void {
  fs.mkdirSync(getDataDir(), { recursive: true });

  if (!fs.existsSync(getIndexPath())) {
    const migrated = migrateLegacyConversationsIfNeeded();
    writeIndex(migrated);
  }
}

// Objective 36 — the ONE existing conversation (LOIS's entire chat history
// to date lives as a single flat array with no thread boundaries at all)
// becomes a single Conversation titled "General", projectId: null (never
// auto-assigned to a project — Objective 36 is explicit that the user
// chooses which past chats to include in a project). Every message,
// timestamp, and the agent attribution on each reply is preserved exactly;
// nothing is summarized, reworded, or dropped. If there is no legacy
// history at all, this just returns an empty index — the frontend lazily
// creates a fresh default conversation on first use (see App.tsx).
function migrateLegacyConversationsIfNeeded(): ConversationIndex {
  let legacy: { agent: string; userMessage: string; assistantReply: string; timestamp: string }[] = [];

  try {
    legacy = readMemory().conversations;
  } catch (error) {
    console.error("[conversations] failed to read legacy conversation log for migration:", error);
    return defaultIndex();
  }

  if (!Array.isArray(legacy) || legacy.length === 0) {
    return defaultIndex();
  }

  const messages: ChatMessage[] = legacy.flatMap((turn) => [
    { role: "user" as const, text: turn.userMessage, timestamp: turn.timestamp },
    {
      role: "assistant" as const,
      agent: turn.agent === "ignis" ? ("ignis" as const) : ("lois" as const),
      text: turn.assistantReply,
      timestamp: turn.timestamp,
    },
  ]);

  const firstTimestamp = legacy[0]?.timestamp ?? new Date().toISOString();
  const lastTimestamp = legacy[legacy.length - 1]?.timestamp ?? firstTimestamp;

  const migrated: Conversation = {
    id: crypto.randomUUID(),
    title: deriveTitleFromFirstMessage(legacy[0]?.userMessage) ?? "General",
    projectId: null,
    createdAt: firstTimestamp,
    updatedAt: lastTimestamp,
    messages,
  };

  console.log(`[conversations] migrated ${legacy.length} legacy turns into one Conversation ("${migrated.title}")`);

  return { schemaVersion: CURRENT_INDEX_VERSION, conversations: [migrated] };
}

function isValidChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  return (
    (m.role === "user" || m.role === "assistant") &&
    typeof m.text === "string" &&
    typeof m.timestamp === "string" &&
    (m.agent === undefined || m.agent === "lois" || m.agent === "ignis")
  );
}

function isValidConversation(value: unknown): value is Conversation {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;

  return (
    typeof c.id === "string" &&
    c.id.length > 0 &&
    typeof c.title === "string" &&
    (c.projectId === null || typeof c.projectId === "string") &&
    typeof c.createdAt === "string" &&
    typeof c.updatedAt === "string" &&
    Array.isArray(c.messages) &&
    (c.messages as unknown[]).every(isValidChatMessage) &&
    (c.copiedFromConversationId === undefined || typeof c.copiedFromConversationId === "string")
  );
}

// Never trust index.json blindly — drop malformed individual conversations
// (logging why) rather than letting one bad entry break the whole list.
function sanitizeConversations(value: unknown): Conversation[] {
  if (!Array.isArray(value)) return [];

  const valid: Conversation[] = [];

  for (const entry of value) {
    if (isValidConversation(entry)) {
      valid.push(entry);
    } else {
      console.error("Dropping malformed conversation record from index.json:", entry);
    }
  }

  return valid;
}

function readIndex(): ConversationIndex {
  if (!fs.existsSync(getIndexPath())) {
    return defaultIndex();
  }

  let text: string;

  try {
    text = fs.readFileSync(getIndexPath(), "utf-8");
  } catch (error) {
    console.error("Failed to read conversations/index.json:", error);
    return defaultIndex();
  }

  if (!text.trim()) {
    return defaultIndex();
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    console.error("conversations/index.json is not valid JSON:", error);
    quarantineCorruptIndex();
    return defaultIndex();
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as Record<string, unknown>).conversations)) {
    return defaultIndex();
  }

  return {
    schemaVersion: CURRENT_INDEX_VERSION,
    conversations: sanitizeConversations((parsed as { conversations: unknown }).conversations),
  };
}

function quarantineCorruptIndex(): void {
  try {
    const quarantinePath = path.join(getDataDir(), `index.corrupt.${Date.now()}.json`);
    fs.copyFileSync(getIndexPath(), quarantinePath);
    console.error(`Corrupt conversations index.json preserved at ${quarantinePath}`);
  } catch (error) {
    console.error("Failed to quarantine corrupt conversations index.json:", error);
  }
}

function writeIndex(index: ConversationIndex): void {
  fs.mkdirSync(getDataDir(), { recursive: true });
  const tempPath = `${getIndexPath()}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(index, null, 2));
  fs.renameSync(tempPath, getIndexPath());
}

function mutateIndex<T>(mutator: (index: ConversationIndex) => T): T {
  const index = readIndex();
  const result = mutator(index);
  writeIndex(index);
  return result;
}

function toSummary(conversation: Conversation): ConversationSummary {
  const { messages, ...rest } = conversation;
  return { ...rest, messageCount: messages.length };
}

export type ListConversationsFilter = {
  /** Omit entirely to list ALL conversations. Pass a project's id to list
   *  only that project's chats, or `null` to list only global/unassigned
   *  chats (Objective 14's "existing global/unassigned chats" picker). */
  projectId?: string | null;
};

// Objective 3/22 — metadata only (no message bodies), newest-updated-first.
export function listConversations(filter: ListConversationsFilter = {}): ConversationSummary[] {
  const conversations = readIndex().conversations;

  const filtered =
    filter.projectId === undefined ? conversations : conversations.filter((c) => c.projectId === filter.projectId);

  return [...filtered].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(toSummary);
}

export function getConversationById(id: string): Conversation | undefined {
  return readIndex().conversations.find((c) => c.id === id);
}

export function conversationCountForProject(projectId: string): number {
  return readIndex().conversations.filter((c) => c.projectId === projectId).length;
}

function deriveTitleFromFirstMessage(firstUserMessage: string | undefined): string | null {
  if (!firstUserMessage) return null;
  const trimmed = firstUserMessage.trim();
  if (trimmed.length === 0) return null;

  return trimmed.length > DEFAULT_TITLE_FALLBACK_LENGTH
    ? `${trimmed.slice(0, DEFAULT_TITLE_FALLBACK_LENGTH).trimEnd()}…`
    : trimmed;
}

export type CreateConversationInput = {
  /** null (or omitted) = global/unassigned chat. */
  projectId?: string | null;
  title?: string;
};

// Objective 19 — stable id (crypto.randomUUID, never an array index),
// empty transcript, immediately usable by either agent. Objective 18 — a
// sensible default title ("New Chat") when none is given; no LLM call.
export function createConversation(input: CreateConversationInput = {}): Conversation {
  const now = new Date().toISOString();

  const conversation: Conversation = {
    id: crypto.randomUUID(),
    title: (input.title ?? "").trim().slice(0, MAX_TITLE_LENGTH) || "New Chat",
    projectId: input.projectId ?? null,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };

  mutateIndex((index) => {
    index.conversations.push(conversation);
  });

  return conversation;
}

export type RenameConversationResult = { ok: true; conversation: Conversation } | { ok: false; reason: "not_found" | "invalid_title" };

export function renameConversation(id: string, title: string): RenameConversationResult {
  return mutateIndex((index) => {
    const conversation = index.conversations.find((c) => c.id === id);
    if (!conversation) return { ok: false, reason: "not_found" };

    const trimmed = title.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_TITLE_LENGTH) {
      return { ok: false, reason: "invalid_title" };
    }

    conversation.title = trimmed;
    conversation.updatedAt = new Date().toISOString();

    return { ok: true, conversation };
  });
}

export function deleteConversation(id: string): boolean {
  return mutateIndex((index) => {
    const originalLength = index.conversations.length;
    index.conversations = index.conversations.filter((c) => c.id !== id);
    return index.conversations.length !== originalLength;
  });
}

// Appends one full turn (user message + assistant reply) to a conversation
// — the ONLY way normal chat activity grows a conversation's transcript.
// Auto-titles from the first user message (Objective 18) the first time a
// conversation receives any messages at all, so a freshly created "New
// Chat" becomes readable without requiring the user to rename it or an LLM
// title-generation call.
export function appendTurn(
  id: string,
  agent: AgentName,
  userMessage: string,
  assistantReply: string
): Conversation | null {
  return mutateIndex((index) => {
    const conversation = index.conversations.find((c) => c.id === id);
    if (!conversation) return null;

    const now = new Date().toISOString();
    const wasEmpty = conversation.messages.length === 0;

    conversation.messages.push(
      { role: "user", text: userMessage, timestamp: now },
      { role: "assistant", agent, text: assistantReply, timestamp: now }
    );

    if (wasEmpty && conversation.title === "New Chat") {
      const derived = deriveTitleFromFirstMessage(userMessage);
      if (derived) conversation.title = derived;
    }

    conversation.updatedAt = now;

    return conversation;
  });
}

// Empties a conversation's transcript in place — the conversation record
// (id, title, projectId) is untouched, only its messages are cleared.
// Distinct from deleteConversation (Objective 17-style distinction: this is
// "clear this chat's history", not "remove this chat").
export function clearMessages(id: string): boolean {
  return mutateIndex((index) => {
    const conversation = index.conversations.find((c) => c.id === id);
    if (!conversation) return false;
    conversation.messages = [];
    conversation.updatedAt = new Date().toISOString();
    return true;
  });
}

// Objective 15/17 — the single primitive both "Move to Project" (projectId
// = a real project id) and "Remove from Project" (projectId = null) are
// built on. Preserves the conversation's id, all messages, all timestamps,
// and its title — only projectId changes. Never duplicates the chat.
export function setConversationProject(id: string, projectId: string | null): Conversation | null {
  return mutateIndex((index) => {
    const conversation = index.conversations.find((c) => c.id === id);
    if (!conversation) return null;

    conversation.projectId = projectId;
    conversation.updatedAt = new Date().toISOString();

    return conversation;
  });
}

// Objective 16 — creates an entirely NEW conversation (new id, new
// createdAt/updatedAt) with the same messages, assigned to the target
// project. The original conversation is never modified. copiedFromConversationId
// records provenance without being load-bearing for anything else.
export function copyConversationToProject(id: string, projectId: string): Conversation | null {
  const source = getConversationById(id);
  if (!source) return null;

  const now = new Date().toISOString();

  const copy: Conversation = {
    id: crypto.randomUUID(),
    title: source.title,
    projectId,
    createdAt: now,
    updatedAt: now,
    // Deep-copied (not the same array reference) so a later mutation of
    // one conversation's messages can never affect the other.
    messages: source.messages.map((m) => ({ ...m })),
    copiedFromConversationId: source.id,
  };

  mutateIndex((index) => {
    index.conversations.push(copy);
  });

  return copy;
}

// Used by DELETE /projects/:id (Objective 42's recommended safe behavior):
// every conversation belonging to a deleted project is returned to
// global/unassigned rather than being cascade-deleted along with it.
export function removeAllFromProject(projectId: string): number {
  return mutateIndex((index) => {
    let count = 0;
    const now = new Date().toISOString();

    for (const conversation of index.conversations) {
      if (conversation.projectId === projectId) {
        conversation.projectId = null;
        conversation.updatedAt = now;
        count++;
      }
    }

    return count;
  });
}

// ============================================================
// Test-only data directory override — mirrors documentService's
// __setDocumentDataDirForTesting.
// ============================================================

export function __setConversationDataDirForTesting(dir: string): void {
  dataDir = dir;
}

export function __resetConversationDataDirForTesting(): void {
  dataDir = DEFAULT_DATA_DIR;
}
