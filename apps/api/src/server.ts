import express from "express";
import cors from "cors";
import multer from "multer";
import { routeAgent, streamAgentResponse, AgentName } from "./router/agentRouter";
import { createRequestTimer, formatPerfLine } from "./perf/requestTimer";
import {
  addConversation,
  addMemory,
  readMemory,
  addCalendarEvent,
  clearConversations,
  completeGoal,
  deleteGoal,
  deleteCalendarEvent,
  deleteMemory,
  getMemories,
  updateMemory,
  MEMORY_CATEGORIES,
  MemoryCategory,
  MemorySource
} from "./memory/memoryService";
import { OllamaRequestError } from "./providers/ollamaProvider";
import { processUserMessageForMemory } from "./memory/memoryPipeline";
import { tryHandleProfileUpdate } from "./memory/profileUpdatePipeline";
import { embedMemoryAsync, backfillMemoryEmbeddings } from "./memory/memoryEmbeddings";
import {
  initDocumentStorage,
  addDocument,
  listDocuments,
  getDocumentById,
  getDocumentContent,
  deleteDocument,
  removeAllDocumentsFromProject
} from "./documents/documentService";
import { MAX_DOCUMENT_SIZE_BYTES, MAX_DOCUMENT_SIZE_MB, isSupportedExtension } from "./documents/documentConfig";
import {
  initProjectStorage,
  listProjects,
  getProjectById,
  createProject,
  updateProject,
  archiveProject,
  unarchiveProject,
  deleteProject
} from "./projects/projectService";
import {
  initConversationStorage,
  listConversations,
  getConversationById,
  createConversation,
  renameConversation,
  deleteConversation,
  appendTurn,
  clearMessages,
  setConversationProject,
  copyConversationToProject,
  removeAllFromProject
} from "./conversations/conversationService";
import path from "path";
const app = express();

// Documents v1A — memoryStorage (buffer in memory, not multer's own disk
// storage) so documentService.ts keeps full control over the actual
// on-disk filename (Objective 10: always <id>.<ext>, never anything
// derived from the raw upload). limits.fileSize is the primary enforcement
// of MAX_DOCUMENT_SIZE_BYTES (Objective 9) — multer rejects an oversized
// upload before its full body is even buffered.
const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCUMENT_SIZE_BYTES }
});

// The HTTP status/headers for /chat/stream are committed the moment the
// first res.write() happens, so if generation fails *after* some reply
// content has already been sent to the client, we can no longer turn this
// into a clean HTTP error response. Instead, this marker plus a short
// description is written as the final chunk before ending the stream (still
// HTTP 200), and the frontend recognizes it to avoid treating the partial
// text as a successful reply (see STREAM_ERROR_MARKER in
// apps/web/src/services/api.ts — the two must match exactly).
const STREAM_ERROR_MARKER = " LOIS_STREAM_ERROR ";

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    status: "LOIS online",
    version: "0.1.0-alpha"
  });
});

app.patch("/goals/:id/complete", (req, res) => {
  const success = completeGoal(req.params.id);

  if (!success) {
    return res.status(404).json({
      error: "Goal not found"
    });
  }

  res.json({
    success: true
  });
});

app.delete("/goals/:id", (req, res) => {
  const success = deleteGoal(req.params.id);

  if (!success) {
    return res.status(404).json({
      error: "Goal not found"
    });
  }

  res.json({
    success: true
  });
});

app.get("/memory", (_req, res) => {
  const memory = readMemory();

  // Ruling out HTTP caching as a variable entirely: Express auto-generates
  // an ETag for every JSON response, which a browser's fetch() (default
  // cache mode) is allowed to revalidate against or serve from cache for.
  // This state changes on every chat turn, so it must never be cached.
  res.setHeader("Cache-Control", "no-store");

  res.json({
    profile: memory.profile,
    preferences: memory.preferences,
    projects: memory.projects,
    goals: memory.goals,
    memories: memory.memories,
    calendar: memory.calendar,
    conversations: memory.conversations.slice(-20)
  });
});

app.get("/memories", (_req, res) => {
  res.json({
    memories: getMemories()
  });
});

app.post("/memories", (req, res) => {
  const { content, category, importance, source } = req.body as {
    content?: string;
    category?: MemoryCategory;
    importance?: number;
    source?: MemorySource;
  };

  if (!content || !content.trim()) {
    return res.status(400).json({
      error: "Content is required"
    });
  }

  const memory = addMemory(content, { category, importance, source });

  if (!memory) {
    // Empty after cleanup, or a duplicate of an existing memory — nothing
    // new was created, but this isn't an error condition.
    return res.status(200).json({
      success: true,
      duplicate: true
    });
  }

  // Memory v2E (Objective 4): embed on creation, same fire-and-forget
  // posture as the PATCH route's re-embed — never holds up this response.
  embedMemoryAsync(memory.id).catch((error: unknown) => {
    console.error(`[memory-embeddings] failed to embed new memory ${memory.id.slice(0, 8)}:`, error);
  });

  res.status(201).json({
    success: true,
    memory
  });
});

app.delete("/conversations", (_req, res) => {
  clearConversations();

  res.json({
    success: true,
    message: "Conversation history cleared"
  });
});

app.delete("/calendar/:id", (req, res) => {
  const success = deleteCalendarEvent(req.params.id);

  if (!success) {
    return res.status(404).json({
      error: "Calendar event not found"
    });
  }

  res.json({
    success: true
  });
});

app.delete("/memories/:id", (req, res) => {
  const success = deleteMemory(req.params.id);

  if (!success) {
    return res.status(404).json({
      error: "Memory not found"
    });
  }

  res.json({
    success: true
  });
});

// Memory v2D — search/editing/pinning management. Explicit allow-list of
// editable fields, each validated by type before being handed to
// updateMemory() (Objective 21): id/createdAt/source are never read off
// req.body at all, so there is no path for a client to touch them, and
// there is deliberately no Object.assign(memory, req.body) anywhere here.
app.patch("/memories/:id", (req, res) => {
  const body = req.body as {
    content?: unknown;
    category?: unknown;
    importance?: unknown;
    pinned?: unknown;
  };

  const updates: { content?: string; category?: MemoryCategory; importance?: number; pinned?: boolean } = {};

  if (body.content !== undefined) {
    if (typeof body.content !== "string") {
      return res.status(400).json({ error: "content must be a string" });
    }
    updates.content = body.content;
  }

  if (body.category !== undefined) {
    if (typeof body.category !== "string" || !(MEMORY_CATEGORIES as readonly string[]).includes(body.category)) {
      return res.status(400).json({ error: "Invalid category" });
    }
    updates.category = body.category as MemoryCategory;
  }

  if (body.importance !== undefined) {
    if (typeof body.importance !== "number") {
      return res.status(400).json({ error: "importance must be a number" });
    }
    updates.importance = body.importance;
  }

  if (body.pinned !== undefined) {
    if (typeof body.pinned !== "boolean") {
      return res.status(400).json({ error: "pinned must be a boolean" });
    }
    updates.pinned = body.pinned;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No valid fields to update" });
  }

  const result = updateMemory(req.params.id, updates);

  if (!result.ok) {
    if (result.reason === "not_found") {
      return res.status(404).json({ error: "Memory not found" });
    }

    if (result.reason === "duplicate") {
      return res.status(409).json({ error: "An equivalent memory already exists." });
    }

    return res.status(400).json({ error: `Invalid ${result.reason.replace("invalid_", "")}` });
  }

  // Memory v2E (Objective 14): a content edit already synchronously cleared
  // the old (now-wrong) embedding inside updateMemory() itself — this is
  // just what regenerates it. Fire-and-forget so the PATCH response isn't
  // held up waiting on an Ollama call; the memory is correctly left
  // without a current embedding (falls back to lexical-only for it) until
  // this resolves.
  if (updates.content !== undefined) {
    embedMemoryAsync(result.memory.id).catch((error: unknown) => {
      console.error(`[memory-embeddings] failed to re-embed memory ${result.memory.id.slice(0, 8)} after edit:`, error);
    });
  }

  res.json({
    success: true,
    memory: result.memory
  });
});

// ============================================================
// Projects v1A — Project routes (Objective 21-28)
// ============================================================

app.get("/projects", (req, res) => {
  const includeArchived = req.query.includeArchived === "true";
  res.json({ projects: listProjects({ includeArchived }) });
});

app.post("/projects", (req, res) => {
  const { name, description, instructions } = req.body as {
    name?: unknown;
    description?: unknown;
    instructions?: unknown;
  };

  if (typeof name !== "string") {
    return res.status(400).json({ error: "A project name is required." });
  }

  const result = createProject({
    name,
    description: typeof description === "string" ? description : undefined,
    instructions: typeof instructions === "string" ? instructions : undefined
  });

  if (!result.ok) {
    return res.status(400).json({ error: "Project name cannot be empty or too long." });
  }

  res.status(201).json({ success: true, project: result.project });
});

app.get("/projects/:id", (req, res) => {
  const project = getProjectById(req.params.id);

  if (!project) {
    return res.status(404).json({ error: "Project not found" });
  }

  res.json({ project });
});

// Objective 27 — basic editing (rename/description/instructions/summary).
app.patch("/projects/:id", (req, res) => {
  const body = req.body as {
    name?: unknown;
    description?: unknown;
    instructions?: unknown;
    contextSummary?: unknown;
  };

  const updates: { name?: string; description?: string; instructions?: string; contextSummary?: string } = {};

  if (body.name !== undefined) {
    if (typeof body.name !== "string") return res.status(400).json({ error: "name must be a string" });
    updates.name = body.name;
  }
  if (body.description !== undefined) {
    if (typeof body.description !== "string") return res.status(400).json({ error: "description must be a string" });
    updates.description = body.description;
  }
  if (body.instructions !== undefined) {
    if (typeof body.instructions !== "string") return res.status(400).json({ error: "instructions must be a string" });
    updates.instructions = body.instructions;
  }
  if (body.contextSummary !== undefined) {
    if (typeof body.contextSummary !== "string") return res.status(400).json({ error: "contextSummary must be a string" });
    updates.contextSummary = body.contextSummary;
  }

  const result = updateProject(req.params.id, updates);

  if (!result.ok) {
    if (result.reason === "not_found") {
      return res.status(404).json({ error: "Project not found" });
    }
    return res.status(400).json({ error: `Invalid ${result.reason.replace("invalid_", "")}` });
  }

  res.json({ success: true, project: result.project });
});

// Objective 28 — archiving is the primary "remove from active list"
// action; the project and everything referencing it stays fully intact.
app.patch("/projects/:id/archive", (req, res) => {
  const success = archiveProject(req.params.id);
  if (!success) return res.status(404).json({ error: "Project not found" });
  res.json({ success: true });
});

app.patch("/projects/:id/unarchive", (req, res) => {
  const success = unarchiveProject(req.params.id);
  if (!success) return res.status(404).json({ error: "Project not found" });
  res.json({ success: true });
});

// Objective 42 — deletion never cascade-deletes a project's chats OR its
// documents: both are returned to global/unassigned FIRST, then the
// project record itself is removed. This orchestration lives here (not
// inside any one service) so projectService/conversationService/
// documentService never need to depend on each other.
app.delete("/projects/:id", (req, res) => {
  const project = getProjectById(req.params.id);

  if (!project) {
    return res.status(404).json({ error: "Project not found" });
  }

  const returnedChatCount = removeAllFromProject(req.params.id);
  const returnedDocumentCount = removeAllDocumentsFromProject(req.params.id);
  deleteProject(req.params.id);

  res.json({ success: true, chatsReturnedToGlobal: returnedChatCount, documentsReturnedToGlobal: returnedDocumentCount });
});

// ============================================================
// Projects v1A — Conversation/chat routes (Objective 2-3, 14-20)
// ============================================================

// ?projectId=<uuid> lists one project's chats; ?scope=global lists only
// unassigned chats (Objective 14's "existing global/unassigned chats"
// picker); omitting both lists every conversation.
app.get("/conversations", (req, res) => {
  const { projectId, scope } = req.query as { projectId?: string; scope?: string };

  if (scope === "global") {
    return res.json({ conversations: listConversations({ projectId: null }) });
  }

  if (typeof projectId === "string" && projectId.length > 0) {
    return res.json({ conversations: listConversations({ projectId }) });
  }

  res.json({ conversations: listConversations() });
});

// Objective 19 — creates a stable, empty conversation, optionally assigned
// to a project. No LLM call, no messages yet.
app.post("/conversations", (req, res) => {
  const { projectId, title } = req.body as { projectId?: unknown; title?: unknown };

  if (projectId !== undefined && projectId !== null && typeof projectId !== "string") {
    return res.status(400).json({ error: "projectId must be a string or null" });
  }

  if (typeof projectId === "string" && !getProjectById(projectId)) {
    return res.status(404).json({ error: "Project not found" });
  }

  const conversation = createConversation({
    projectId: projectId ?? null,
    title: typeof title === "string" ? title : undefined
  });

  res.status(201).json({ success: true, conversation });
});

app.get("/conversations/:id", (req, res) => {
  const conversation = getConversationById(req.params.id);

  if (!conversation) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  res.json({ conversation });
});

// Objective 18 — rename only; every other field has its own dedicated
// route (move/copy/remove-from-project) so intent is always explicit in
// the URL, not inferred from an arbitrary PATCH body.
app.patch("/conversations/:id", (req, res) => {
  const { title } = req.body as { title?: unknown };

  if (typeof title !== "string") {
    return res.status(400).json({ error: "title must be a string" });
  }

  const result = renameConversation(req.params.id, title);

  if (!result.ok) {
    if (result.reason === "not_found") return res.status(404).json({ error: "Conversation not found" });
    return res.status(400).json({ error: "Title cannot be empty or too long." });
  }

  res.json({ success: true, conversation: result.conversation });
});

app.delete("/conversations/:id", (req, res) => {
  const success = deleteConversation(req.params.id);

  if (!success) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  res.json({ success: true });
});

// Clears a conversation's transcript in place — distinct from DELETE
// (Objective 17-style distinction: this keeps the chat, just empties it).
// Used by the "CLEAR CHAT" control in the HUD.
app.delete("/conversations/:id/messages", (req, res) => {
  const success = clearMessages(req.params.id);

  if (!success) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  res.json({ success: true });
});

// Objective 15 — MOVE: preserves id/messages/timestamps/title, just
// reassigns projectId. No duplicate is created.
app.post("/conversations/:id/move", (req, res) => {
  const { projectId } = req.body as { projectId?: unknown };

  if (typeof projectId !== "string" || projectId.length === 0) {
    return res.status(400).json({ error: "A target projectId is required." });
  }

  if (!getProjectById(projectId)) {
    return res.status(404).json({ error: "Target project not found" });
  }

  const moved = setConversationProject(req.params.id, projectId);

  if (!moved) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  res.json({ success: true, conversation: moved });
});

// Objective 16 — COPY: creates a NEW conversation with a new id, same
// messages, assigned to the target project. The original is untouched.
app.post("/conversations/:id/copy", (req, res) => {
  const { projectId } = req.body as { projectId?: unknown };

  if (typeof projectId !== "string" || projectId.length === 0) {
    return res.status(400).json({ error: "A target projectId is required." });
  }

  if (!getProjectById(projectId)) {
    return res.status(404).json({ error: "Target project not found" });
  }

  const copy = copyConversationToProject(req.params.id, projectId);

  if (!copy) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  res.status(201).json({ success: true, conversation: copy });
});

// Objective 17 — sets projectId back to null. Distinct from DELETE: the
// chat and all its messages survive, it just returns to global/unassigned.
app.post("/conversations/:id/remove-from-project", (req, res) => {
  const removed = setConversationProject(req.params.id, null);

  if (!removed) {
    return res.status(404).json({ error: "Conversation not found" });
  }

  res.json({ success: true, conversation: removed });
});

// Documents v1A — upload endpoint (Objective 13). Extension is validated
// here, BEFORE any file touches disk (documentService.addDocument() also
// re-checks defensively, but this is the primary gate so an unsupported
// format never gets as far as a parser). Processing is synchronous, as
// the task explicitly allows for this stage — the response IS the final
// DocumentRecord, not a "queued" placeholder.
// Projects v1A follow-up — multer puts non-file multipart fields on
// req.body just like a normal form post, so a `projectId` field travels
// alongside the file in the same request. Optional: an upload with no
// projectId (or an empty one) stays a global document, unchanged from
// before.
app.post("/documents", documentUpload.single("file"), async (req, res) => {
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: "No file was provided." });
  }

  if (file.buffer.length === 0) {
    return res.status(400).json({ error: "The uploaded file is empty." });
  }

  const ext = path.extname(file.originalname).toLowerCase();

  if (!isSupportedExtension(ext)) {
    return res.status(400).json({
      error: `Unsupported file type "${ext || "(none)"}". Supported: .txt, .md, .json, .csv, .pdf, .docx, and common source-code files.`
    });
  }

  const rawProjectId = typeof req.body?.projectId === "string" ? req.body.projectId.trim() : "";

  if (rawProjectId && !getProjectById(rawProjectId)) {
    return res.status(404).json({ error: "Target project not found" });
  }

  try {
    const document = await addDocument({
      originalName: file.originalname,
      mimeType: file.mimetype,
      buffer: file.buffer,
      projectId: rawProjectId || null
    });

    res.status(201).json({ success: true, document });
  } catch (error) {
    console.error("[documents] upload failed:", error);
    res.status(500).json({ error: "Failed to process this document." });
  }
});

// Metadata only (Objective 14) — never the extracted text for every
// document in the list, which is exactly why extracted content lives in
// its own file per document rather than inline on the record.
// ?projectId=<uuid> lists one project's documents; ?scope=global lists
// only unassigned documents; omitting both lists everything (mirrors
// GET /conversations' own filter shape).
app.get("/documents", (req, res) => {
  const { projectId, scope } = req.query as { projectId?: string; scope?: string };

  if (scope === "global") {
    return res.json({ documents: listDocuments({ projectId: null }) });
  }

  if (typeof projectId === "string" && projectId.length > 0) {
    return res.json({ documents: listDocuments({ projectId }) });
  }

  res.json({ documents: listDocuments() });
});

app.get("/documents/:id", (req, res) => {
  const document = getDocumentById(req.params.id);

  if (!document) {
    return res.status(404).json({ error: "Document not found" });
  }

  res.json({ document });
});

app.get("/documents/:id/content", (req, res) => {
  const document = getDocumentById(req.params.id);

  if (!document) {
    return res.status(404).json({ error: "Document not found" });
  }

  const content = getDocumentContent(req.params.id);

  // A document can genuinely exist with no readable content — still
  // "processing", or extraction failed (status: "error"). That's not a
  // 404 (the document record IS real); it's an honest "nothing to show
  // yet" response the frontend renders as a message, not raw text.
  if (content === null) {
    return res.json({
      content: null,
      message: document.error ?? "No extracted content is available for this document."
    });
  }

  res.json({ content });
});

// Objective 16 — removes the index record, the original file, and the
// extracted text together; deleteDocument() itself is what guarantees
// none of the three outlives the others.
app.delete("/documents/:id", (req, res) => {
  const success = deleteDocument(req.params.id);

  if (!success) {
    return res.status(404).json({ error: "Document not found" });
  }

  res.json({ success: true });
});

app.post("/chat/stream", async (req, res) => {
  // Performance Pass v1 (Phase 1) — one timer per request, never shared
  // across requests (see requestTimer.ts's own header for why).
  const timer = createRequestTimer();

  const { agent, message, conversationId } = req.body as {
    agent?: AgentName;
    message?: string;
    conversationId?: string;
  };

  if (!message) {
    return res.status(400).json({
      error: "Message is required",
    });
  }

  const selectedAgent: AgentName = agent === "ignis" ? "ignis" : "lois";

  // Projects v1A: when a conversationId is given (the frontend always
  // provides one once wired up), that conversation's projectId becomes
  // this turn's project scope for memory extraction, and the turn is
  // persisted into that specific chat's own transcript rather than the
  // legacy flat log. Omitting conversationId (any older/direct caller)
  // falls back to exactly the pre-Projects-v1A behavior — nothing breaks.
  const targetConversation = conversationId ? getConversationById(conversationId) : undefined;
  const targetProjectId = targetConversation?.projectId ?? null;

  function persistTurn(userMessage: string, assistantReply: string): void {
    if (conversationId && targetConversation) {
      appendTurn(conversationId, selectedAgent, userMessage, assistantReply);
    } else {
      addConversation(selectedAgent, userMessage, assistantReply);
    }
  }

  // If the browser disconnects (tab closed, request aborted, etc.) while
  // Ollama is still generating, stop the upstream generation instead of
  // burning tokens/CPU on a response nobody will receive, and skip saving
  // an incomplete reply as if it were a normal conversation.
  //
  // NOTE: this listens on `res` ("close"), not `req`. Node's IncomingMessage
  // fires its own "close" as soon as the request body has been fully read
  // (i.e. almost immediately for a small JSON POST body) — that is NOT the
  // same thing as the client disconnecting, and using it here aborted every
  // single streaming request within a few milliseconds of it starting.
  // `res` only closes once the response itself ends (normally, via
  // res.end() — where writableEnded is already true — or abnormally, if the
  // underlying connection drops before that).
  const abortController = new AbortController();
  let clientDisconnected = false;

  res.on("close", () => {
    if (!res.writableEnded) {
      clientDisconnected = true;
      abortController.abort();
    }
  });

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Profile-state synchronization fix: a canonical profile statement
  // ("My favorite color is red.") is handled here, deterministically,
  // BEFORE any LLM call — the mutation either really happens or it
  // doesn't, and the reply text is built directly from that real outcome.
  // This intentionally bypasses streamAgentResponse (no LLM call at all
  // for this message) and processUserMessageForMemory (a canonical
  // profile fact must not also become a generic MemoryRecord). Written as
  // a single chunk so the frontend's streaming reader consumes it exactly
  // like any other reply.
  const profileUpdate = tryHandleProfileUpdate(selectedAgent, message);

  if (profileUpdate.handled) {
    const reply = profileUpdate.reply!;
    res.write(reply);
    persistTurn(message, reply);
    res.end();
    console.log(formatPerfLine("[perf]", { agent: selectedAgent, path: "profileUpdate", total: `${timer.elapsedTotal()}ms` }));
    return;
  }

  try {
    const fullReply = await streamAgentResponse(
      selectedAgent,
      message,
      (chunk) => {
        res.write(chunk);
      },
      { signal: abortController.signal },
      conversationId,
      timer
    );

    if (clientDisconnected) {
      return;
    }

    // Persisted exactly once, after the full reply has streamed
    // successfully — never per-chunk, and never on a failed/aborted run.
    persistTurn(message, fullReply);
    timer.mark("conversationPersistence");

    // Memory extraction is deliberately not awaited: it runs against the
    // user's message (not the reply, so it doesn't need to wait on
    // anything above), and awaiting it here would add its own Ollama
    // round-trip to the visible response latency for no benefit. It can
    // never throw out of this call (see memoryPipeline's own try/catch),
    // so a failure here cannot affect this request either way. Projects
    // v1A: scoped to the active conversation's project, if any.
    //
    // Performance Pass v1 (Objective 2 confirmed already true here, not
    // newly introduced): this call starts AFTER the response has already
    // been generated and persisted — it can never delay time-to-first-
    // token or total completion time for THIS request. Its own duration is
    // logged separately, on its own line, once it finishes in the
    // background, specifically so it's visible for profiling without ever
    // being folded into (and inflating) the request's own total.
    const extractionStart = process.hrtime.bigint();
    processUserMessageForMemory(message, { projectId: targetProjectId })
      .then((result) => {
        const ms = Math.round((Number(process.hrtime.bigint() - extractionStart) / 1e6) * 100) / 100;
        console.log(
          formatPerfLine("[perf-background]", {
            stage: "memoryExtraction",
            agent: selectedAgent,
            saved: result.saved.length,
            duplicates: result.duplicates.length,
            rejected: result.rejected.length,
            ms: `${ms}ms`,
          })
        );
      })
      .catch((error) => {
        console.error("[memory] pipeline failed for streamed chat:", error);
      });

    res.end();

    const marks = timer.entries();
    console.log(
      formatPerfLine("[perf]", {
        agent: selectedAgent,
        path: "generate",
        ...Object.fromEntries(marks.map(({ label, ms }) => [label, `${ms}ms`])),
        total: `${timer.elapsedTotal()}ms`,
      })
    );
  } catch (error) {
    if (clientDisconnected || isAbortError(error)) {
      console.warn(`Stream aborted (client disconnected) for agent=${selectedAgent}`);
      return;
    }

    console.error("Stream chat error:", error);

    const description = describeStreamError(error);

    if (!res.headersSent) {
      // Nothing has been written yet, so we can still send a proper
      // structured error response with an accurate status code.
      const status = error instanceof OllamaRequestError ? 502 : 500;
      res.status(status).json({ error: description });
      return;
    }

    // Partial reply text has already been flushed to the client, so the
    // HTTP status is already committed to 200 and cannot be changed. Make
    // the failure visible in-stream via the shared marker instead of
    // pretending the response completed normally, and close the connection.
    // The partial reply is intentionally NOT persisted to conversation
    // history.
    res.write(`${STREAM_ERROR_MARKER}${description}`);
    res.end();
  }
});

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function describeStreamError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Unknown streaming error";
}

app.post("/chat", async (req, res) => {
  const timer = createRequestTimer();

  try {
    const { agent, message, conversationId } = req.body as {
      agent?: AgentName;
      message?: string;
      conversationId?: string;
    };

    if (!message) {
      return res.status(400).json({
        error: "Message is required"
      });
    }

    const selectedAgent: AgentName = agent === "ignis" ? "ignis" : "lois";

    // Projects v1A — same posture as /chat/stream: an active conversation's
    // projectId scopes memory extraction, and the turn is persisted into
    // that specific chat rather than the legacy flat log. No conversationId
    // falls back to exactly the pre-Projects-v1A behavior.
    const targetConversation = conversationId ? getConversationById(conversationId) : undefined;
    const targetProjectId = targetConversation?.projectId ?? null;

    function persistTurn(userMessage: string, assistantReply: string): void {
      if (conversationId && targetConversation) {
        appendTurn(conversationId, selectedAgent, userMessage, assistantReply);
      } else {
        addConversation(selectedAgent, userMessage, assistantReply);
      }
    }

    // Profile-state synchronization fix — see the matching block in
    // /chat/stream for the full rationale. Same deterministic
    // detect-then-mutate-then-reply path, no LLM call for this message.
    const profileUpdate = tryHandleProfileUpdate(selectedAgent, message);

    if (profileUpdate.handled) {
      const reply = profileUpdate.reply!;
      persistTurn(message, reply);

      return res.json({
        agent: selectedAgent,
        reply
      });
    }

    const reply = await routeAgent(selectedAgent, message, conversationId, timer);

    persistTurn(message, reply);
    timer.mark("conversationPersistence");

    const lowerMessage = message.toLowerCase();

const shouldSaveCalendarEvent =
  lowerMessage.startsWith("add calendar event") ||
  lowerMessage.startsWith("add event") ||
  lowerMessage.startsWith("schedule:") ||
  lowerMessage.startsWith("schedule ") ||
  lowerMessage.includes("add to my calendar") ||
  lowerMessage.includes("put on my calendar") ||
  lowerMessage.includes("add a birthday") ||
  lowerMessage.includes("birthday on") ||
  lowerMessage.includes("birthday is");

if (shouldSaveCalendarEvent) {
  addCalendarEvent(message);
}

// Memory v2B: explicit "remember that..."/"save this..." commands are
// handled first and are authoritative; anything else runs through
// intelligent extraction (category/importance/confidence, duplicate
// detection, sensitive-content guard). Not awaited for the same reason as
// in /chat/stream — it operates on `message`, not `reply`, and a failure
// here can never affect this response either way. Projects v1A: scoped to
// the active conversation's project, if any.
processUserMessageForMemory(message, { projectId: targetProjectId }).catch((error) => {
  console.error("[memory] pipeline failed for non-streamed chat:", error);
});

    res.json({
      agent: selectedAgent,
      reply
    });

    const marks = timer.entries();
    console.log(
      formatPerfLine("[perf]", {
        agent: selectedAgent,
        path: "generate-nonstream",
        ...Object.fromEntries(marks.map(({ label, ms }) => [label, `${ms}ms`])),
        total: `${timer.elapsedTotal()}ms`,
      })
    );
  } catch (error) {
    console.error("Chat error:", error);

    res.status(500).json({
      error: "LOIS encountered an internal error"
    });
  }
});

// Documents v1A — turns multer's LIMIT_FILE_SIZE (and any other multer
// failure) into the same clean-JSON-error shape every other route uses,
// instead of Express's default HTML error page (Objective 22: "PDF
// contains no extractable text" is better than "500 INTERNAL ERROR", and
// a raw multer stack trace is worse than that). Must be declared with all
// four params (err, req, res, next) — Express only treats a middleware as
// an error handler when the signature has exactly four.
app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: `File is too large. Maximum size is ${MAX_DOCUMENT_SIZE_MB}MB.` });
    }

    return res.status(400).json({ error: `Upload failed: ${err.message}` });
  }

  next(err);
});

const PORT = 3001;

app.listen(PORT, () => {
  console.log(`LOIS API running on port ${PORT}`);

  // Documents v1A — creates data/documents/{files,extracted}/ and a fresh
  // index.json on a new clone/first run. Synchronous and cheap (directory
  // creation, not file parsing), so this runs before the backfill call
  // below rather than needing its own fire-and-forget treatment.
  initDocumentStorage();

  // Projects v1A — creates data/projects/ (empty index on first run).
  initProjectStorage();

  // Projects v1A — creates data/conversations/, and on a fresh/first run
  // migrates the legacy flat memory.json conversation log into one
  // "General" Conversation (see conversationService's own migration
  // comment). Runs AFTER initProjectStorage/initDocumentStorage but before
  // the async embedding backfill below — synchronous, cheap, and must
  // complete before the server can accept any /chat or /conversations
  // request.
  initConversationStorage();

  // Memory v2E (Objective 5): lazy backfill, fire-and-forget — never
  // delays the server from listening (the callback above has already run
  // by the time this executes), regardless of how many memories need
  // embedding or how long Ollama takes to respond. Catches both
  // never-embedded memories and ones made stale by an EMBEDDING_MODEL
  // change (Objective 20) — isEmbeddingStale() doesn't distinguish the two.
  backfillMemoryEmbeddings().catch((error: unknown) => {
    console.error("[memory-embeddings] startup backfill failed:", error);
  });
});
