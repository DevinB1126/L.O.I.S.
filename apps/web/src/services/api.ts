// Centralized backend communication for the LOIS / IGNIS frontend.
//
// This wraps the exact same requests that used to be scattered across
// App.tsx (same URLs, same methods, same response contracts). No backend
// behavior was changed as part of this refactor.

import type {
  Agent,
  Conversation,
  ConversationSummary,
  DocumentRecord,
  MemoryCategory,
  MemoryRecord,
  MemorySnapshot,
  Project
} from "../types";

const API_BASE = "http://localhost:3001";

export async function getMemory(): Promise<MemorySnapshot> {
  // cache: "no-store" — this state changes on every chat turn, so a
  // browser-cached/revalidated response (fetch()'s default cache mode)
  // must never be served here, matching the backend's Cache-Control:
  // no-store on this route.
  const response = await fetch(`${API_BASE}/memory`, { cache: "no-store" });
  return response.json();
}

export async function deleteMemory(id: string): Promise<void> {
  await fetch(`${API_BASE}/memories/${id}`, {
    method: "DELETE",
  });
}

export interface UpdateMemoryInput {
  content?: string;
  category?: MemoryCategory;
  importance?: number;
  pinned?: boolean;
}

export interface UpdateMemoryResult {
  success: boolean;
  memory?: MemoryRecord;
  /** Present on failure — e.g. "An equivalent memory already exists." */
  error?: string;
}

// Never throws on a validation/duplicate rejection from the backend (409,
// 400, 404) — those are ordinary, expected outcomes the Memory view needs
// to show inline (Objective 5/24), not exceptions. Only a genuine network
// failure rejects.
export async function updateMemory(id: string, updates: UpdateMemoryInput): Promise<UpdateMemoryResult> {
  const response = await fetch(`${API_BASE}/memories/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    return { success: false, error: typeof data.error === "string" ? data.error : "Failed to update memory." };
  }

  return { success: true, memory: data.memory };
}

export async function deleteCalendarEvent(eventId: string): Promise<void> {
  await fetch(`${API_BASE}/calendar/${eventId}`, {
    method: "DELETE",
  });
}

export async function completeGoal(goalId: string): Promise<void> {
  await fetch(`${API_BASE}/goals/${goalId}/complete`, {
    method: "PATCH",
  });
}

export async function deleteGoal(goalId: string): Promise<void> {
  await fetch(`${API_BASE}/goals/${goalId}`, {
    method: "DELETE",
  });
}

// Projects v1A: clears one specific conversation's transcript in place
// (the conversation record itself survives — see conversationService's
// clearMessages) rather than the old global "wipe everything" behavior.
export async function clearConversationMessages(conversationId: string): Promise<void> {
  await fetch(`${API_BASE}/conversations/${conversationId}/messages`, {
    method: "DELETE",
  });
}

// The backend cannot change the HTTP status code once it has already
// started streaming a reply (headers are committed on the first res.write).
// So if generation fails *after* some content was already sent, it appends
// this marker followed by a short description as the final chunk instead,
// then ends the stream normally (still HTTP 200). Consumers of
// streamChatMessage must check the accumulated text for this marker rather
// than assuming any 200 response completed successfully.
//
// Must match STREAM_ERROR_MARKER in apps/api/src/server.ts exactly.
export const STREAM_ERROR_MARKER = " LOIS_STREAM_ERROR ";

// Action Execution Layer v1 — same out-of-band-marker technique as
// STREAM_ERROR_MARKER above. When the backend actually executed a
// calendar/goal/memory action for this message, it appends this marker
// plus a JSON summary ({ type, success }) as the final chunk, after the
// real (grounded) confirmation text. Consumers strip everything from this
// marker onward before displaying the reply.
//
// Must match ACTION_RESULT_MARKER in apps/api/src/server.ts exactly.
export const ACTION_RESULT_MARKER = " LOIS_ACTION_RESULT ";

// `domain` says which slice of state changed (must match ActionDomain in
// apps/api/src/actions/assistantAction.ts) — Objective 8: the frontend
// must never infer this by parsing the reply text itself.
export interface StreamedActionSummary {
  type: string;
  success: boolean;
  domain: "calendar" | "goals" | "memory";
}

// Opens the streaming chat response and hands back the raw reader, exactly
// as App.tsx used to consume it inline. The streaming protocol itself is
// intentionally left untouched here (hardening is a separate v1.1 task) —
// this only adds the response.ok check that was missing, so a failed
// request (Ollama down, upstream error) is treated as an error instead of
// its JSON error body being read as if it were the chat reply.
export async function streamChatMessage(
  agent: Agent,
  message: string,
  conversationId?: string
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const response = await fetch(`${API_BASE}/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent, message, conversationId }),
  });

  if (!response.ok) {
    throw new Error(await describeFailedStreamResponse(response));
  }

  if (!response.body) {
    throw new Error("No streaming response body");
  }

  return response.body.getReader();
}

async function describeFailedStreamResponse(response: Response): Promise<string> {
  try {
    const data = await response.json();
    if (data && typeof data.error === "string") return data.error;
  } catch {
    // Body wasn't JSON (or was already consumed) — fall back below.
  }

  return `Chat stream request failed with status ${response.status}`;
}

// =========================================
// Documents v1A
// =========================================

export interface UploadDocumentResult {
  success: boolean;
  document?: DocumentRecord;
  /** Present on failure — a message meant to be shown to the user as-is
   *  (Objective 23: never a raw "500 INTERNAL ERROR"). */
  error?: string;
}

// Never throws on an ordinary rejection (unsupported type, oversized file,
// empty file) — those are expected outcomes the Documents view shows
// inline, matching the posture updateMemory already takes above. Only a
// genuine network failure (backend unreachable) rejects.
// Projects v1A follow-up: an optional projectId scopes the upload to that
// project at creation time — omit for a global document.
export async function uploadDocument(file: File, projectId?: string): Promise<UploadDocumentResult> {
  const formData = new FormData();
  formData.append("file", file);
  if (projectId) formData.append("projectId", projectId);

  let response: Response;

  try {
    response = await fetch(`${API_BASE}/documents`, {
      method: "POST",
      body: formData,
    });
  } catch {
    return { success: false, error: "Could not reach LOIS core. Is the backend running?" };
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    return { success: false, error: typeof data.error === "string" ? data.error : "Failed to upload this document." };
  }

  return { success: true, document: data.document };
}

// Projects v1A follow-up: filter shape mirrors getConversations' own —
// pass projectId to list one project's documents, scopeGlobal to list only
// unassigned ones, or omit both to list everything (unchanged default).
export async function getDocuments(filter: { projectId?: string; scopeGlobal?: boolean } = {}): Promise<DocumentRecord[]> {
  const params = new URLSearchParams();
  if (filter.scopeGlobal) params.set("scope", "global");
  else if (filter.projectId) params.set("projectId", filter.projectId);

  const query = params.toString();
  const response = await fetch(`${API_BASE}/documents${query ? `?${query}` : ""}`, { cache: "no-store" });
  if (!response.ok) return [];

  const data = await response.json().catch(() => ({}));
  return Array.isArray(data.documents) ? data.documents : [];
}

export async function getDocument(id: string): Promise<DocumentRecord | null> {
  const response = await fetch(`${API_BASE}/documents/${id}`, { cache: "no-store" });
  if (!response.ok) return null;

  const data = await response.json().catch(() => ({}));
  return data.document ?? null;
}

export interface DocumentContentResult {
  content: string | null;
  /** Explains why content is null — still processing, extraction failed,
   *  or the document/backend couldn't be reached. */
  message?: string;
}

export async function getDocumentContent(id: string): Promise<DocumentContentResult> {
  let response: Response;

  try {
    response = await fetch(`${API_BASE}/documents/${id}/content`, { cache: "no-store" });
  } catch {
    return { content: null, message: "Could not reach LOIS core. Is the backend running?" };
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    return { content: null, message: typeof data.error === "string" ? data.error : "Failed to load this document." };
  }

  return { content: data.content ?? null, message: data.message };
}

export async function deleteDocument(id: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/documents/${id}`, { method: "DELETE" });
    return response.ok;
  } catch {
    return false;
  }
}

// =========================================
// Projects v1A — Projects
// =========================================

export async function getProjects(includeArchived = false): Promise<Project[]> {
  const url = includeArchived ? `${API_BASE}/projects?includeArchived=true` : `${API_BASE}/projects`;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) return [];

  const data = await response.json().catch(() => ({}));
  return Array.isArray(data.projects) ? data.projects : [];
}

export async function getProject(id: string): Promise<Project | null> {
  const response = await fetch(`${API_BASE}/projects/${id}`, { cache: "no-store" });
  if (!response.ok) return null;

  const data = await response.json().catch(() => ({}));
  return data.project ?? null;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  instructions?: string;
}

export interface ProjectResult {
  success: boolean;
  project?: Project;
  error?: string;
}

// Never throws on an ordinary rejection (empty/too-long name) — that's an
// expected outcome the Projects view shows inline. Only a genuine network
// failure rejects.
export async function createProject(input: CreateProjectInput): Promise<ProjectResult> {
  const response = await fetch(`${API_BASE}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    return { success: false, error: typeof data.error === "string" ? data.error : "Failed to create project." };
  }

  return { success: true, project: data.project };
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  instructions?: string;
  contextSummary?: string;
}

export async function updateProject(id: string, updates: UpdateProjectInput): Promise<ProjectResult> {
  const response = await fetch(`${API_BASE}/projects/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    return { success: false, error: typeof data.error === "string" ? data.error : "Failed to update project." };
  }

  return { success: true, project: data.project };
}

export async function archiveProject(id: string): Promise<boolean> {
  const response = await fetch(`${API_BASE}/projects/${id}/archive`, { method: "PATCH" });
  return response.ok;
}

export async function unarchiveProject(id: string): Promise<boolean> {
  const response = await fetch(`${API_BASE}/projects/${id}/unarchive`, { method: "PATCH" });
  return response.ok;
}

// Objective 42 — the backend returns the project's chats to global/
// unassigned before deleting the project record; nothing is cascade-deleted.
export async function deleteProject(id: string): Promise<boolean> {
  const response = await fetch(`${API_BASE}/projects/${id}`, { method: "DELETE" });
  return response.ok;
}

// =========================================
// Projects v1A — Conversations / chats
// =========================================

export async function getConversations(filter: { projectId?: string; scopeGlobal?: boolean } = {}): Promise<ConversationSummary[]> {
  const params = new URLSearchParams();
  if (filter.scopeGlobal) params.set("scope", "global");
  else if (filter.projectId) params.set("projectId", filter.projectId);

  const query = params.toString();
  const response = await fetch(`${API_BASE}/conversations${query ? `?${query}` : ""}`, { cache: "no-store" });
  if (!response.ok) return [];

  const data = await response.json().catch(() => ({}));
  return Array.isArray(data.conversations) ? data.conversations : [];
}

export async function getConversation(id: string): Promise<Conversation | null> {
  const response = await fetch(`${API_BASE}/conversations/${id}`, { cache: "no-store" });
  if (!response.ok) return null;

  const data = await response.json().catch(() => ({}));
  return data.conversation ?? null;
}

// Objective 19 — creates a stable, empty conversation, optionally assigned
// to a project immediately.
export async function createConversation(input: { projectId?: string | null; title?: string } = {}): Promise<Conversation | null> {
  const response = await fetch(`${API_BASE}/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!response.ok) return null;

  const data = await response.json().catch(() => ({}));
  return data.conversation ?? null;
}

export interface RenameConversationResult {
  success: boolean;
  conversation?: Conversation;
  error?: string;
}

export async function renameConversation(id: string, title: string): Promise<RenameConversationResult> {
  const response = await fetch(`${API_BASE}/conversations/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    return { success: false, error: typeof data.error === "string" ? data.error : "Failed to rename chat." };
  }

  return { success: true, conversation: data.conversation };
}

export async function deleteConversation(id: string): Promise<boolean> {
  const response = await fetch(`${API_BASE}/conversations/${id}`, { method: "DELETE" });
  return response.ok;
}

// Objective 15 — MOVE: same id, same messages, reassigned projectId.
export async function moveConversationToProject(id: string, projectId: string): Promise<Conversation | null> {
  const response = await fetch(`${API_BASE}/conversations/${id}/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId }),
  });

  if (!response.ok) return null;

  const data = await response.json().catch(() => ({}));
  return data.conversation ?? null;
}

// Objective 16 — COPY: a brand new conversation id, original untouched.
export async function copyConversationToProject(id: string, projectId: string): Promise<Conversation | null> {
  const response = await fetch(`${API_BASE}/conversations/${id}/copy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId }),
  });

  if (!response.ok) return null;

  const data = await response.json().catch(() => ({}));
  return data.conversation ?? null;
}

// Objective 17 — sets projectId back to null; the chat and its messages
// survive, distinct from deleteConversation.
export async function removeConversationFromProject(id: string): Promise<Conversation | null> {
  const response = await fetch(`${API_BASE}/conversations/${id}/remove-from-project`, { method: "POST" });
  if (!response.ok) return null;

  const data = await response.json().catch(() => ({}));
  return data.conversation ?? null;
}
