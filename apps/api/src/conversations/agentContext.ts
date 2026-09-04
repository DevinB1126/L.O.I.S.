import { readMemory, MemoryRecord } from "../memory/memoryService";
import { retrieveRelevantMemories, formatRetrievedMemories, filterMemoriesByScope, RETRIEVAL_CONFIG } from "../memory/memoryRetriever";
import { getConversationById, Conversation, ChatMessage } from "./conversationService";
import { getProjectById } from "../projects/projectService";
import type { ProjectPromptContext } from "../agents/agentPrompt";
import type { RequestTimer } from "../perf/requestTimer";

// Projects v1A — Objective 12/13's context assembly, adapted to this
// codebase: the ONE place that turns (message, conversationId) into
// everything an agent prompt needs — global profile/preferences/goals/
// calendar (unchanged from pre-Projects behavior), relevant GLOBAL memories
// plus relevant CURRENT-PROJECT memories (never another project's —
// Objective 8/37), the active project's identity/description/instructions
// (Objective 4/5/10), and the CURRENT conversation's own recent history
// (never every chat in a project — Objective 13).
//
// Deliberately a separate module from memory/memoryService.ts rather than
// extending getMemoryContext() in place: this keeps memoryService decoupled
// from conversationService/projectService (no import cycle risk — this
// module depends on all three, but none of them depend on it or on each
// other). memoryService's own getMemoryContext() is left untouched as a
// fallback code path for any caller that doesn't have a conversationId.

const MAX_HISTORY_MESSAGES = 20;
const MAX_HISTORY_CHARS = 4000;

export interface AssembledContext {
  /** Profile, preferences, goals, relevant memories (global + project,
   *  separately labeled), and calendar. Handed to buildAgentPrompt as its
   *  `memoryContext` argument — Reasoning/UX pass: conversation history is
   *  now returned separately (see historyText below) rather than bundled
   *  in here, so the two become genuinely distinct top-level sections in
   *  the final prompt instead of one undifferentiated block (Objective A2:
   *  SYSTEM / PROJECT / MEMORY / CONVERSATION / CURRENT USER REQUEST are
   *  meant to be separable, not merged). */
  memoryContext: string;
  /** The current conversation's own recent history, formatted — separate
   *  from memoryContext so it gets its own labeled section in the final
   *  prompt (Objective 13/A2). */
  historyText: string;
  /** null when this conversation has no project (or none was resolved) —
   *  buildAgentPrompt omits the project block entirely in that case. */
  project: ProjectPromptContext | null;
  projectId: string | null;
  conversation: Conversation | null;
}

// Objective 43 — concise dev diagnostics only (never full conversation/
// memory content), never surfaced in the normal UI.
function logContextDebug(
  projectId: string | null,
  conversationId: string | undefined,
  globalCandidates: number,
  projectCandidates: number,
  selectedCount: number,
  instructionsApplied: boolean
): void {
  console.log(
    `[project-context] projectId=${projectId ?? "none"} conversationId=${conversationId ?? "none"} ` +
      `globalMemoryCandidates=${globalCandidates} projectMemoryCandidates=${projectCandidates} ` +
      `selected=${selectedCount} instructionsApplied=${instructionsApplied}`
  );
}

export async function assembleAgentContext(
  message: string,
  conversationId?: string,
  timer?: RequestTimer
): Promise<AssembledContext> {
  const conversation = conversationId ? getConversationById(conversationId) ?? null : null;
  timer?.mark("conversationLoad");

  const projectId = conversation?.projectId ?? null;
  const project = projectId ? getProjectById(projectId) : undefined;
  timer?.mark("projectLoad");

  // Performance Pass v1 (Objective 7): previously called BOTH getMemories()
  // (its own full readMemory()) and readMemory() again a few lines below —
  // two full disk-read+parse+sanitize passes over the same memory.json for
  // one request. readMemory() is now called exactly once here and reused
  // for both the memory list and the profile/preferences/goals/calendar
  // data below.
  const data = readMemory();
  timer?.mark("memoryLoad");

  // Objective 8/9: the candidate pool is narrowed to global + the current
  // project BEFORE any scoring happens — ordinary v2C/v2E relevance rules
  // (including the small PROJECT_BOOST) still fully apply within that pool.
  const candidatePool = filterMemoriesByScope(data.memories, projectId);

  const { selected, scored } = await retrieveRelevantMemories({
    message,
    memories: candidatePool,
    maxMemories: RETRIEVAL_CONFIG.MAX_RETRIEVED_MEMORIES,
    maxCharacters: RETRIEVAL_CONFIG.MAX_MEMORY_CONTEXT_CHARS,
    timer,
  });

  // Objective 12 lists global and current-project memories as two separate
  // context items — formatted as two labeled sections rather than merged,
  // so it's always clear (to a human reading a debug log, or the model
  // itself) which memory came from where.
  const globalSelected = selected.filter((m) => m.scope !== "project");
  const projectSelected = selected.filter((m) => m.scope === "project");

  const historyText = conversation
    ? formatConversationHistory(conversation.messages)
    : formatLegacyRecentConversations(data.conversations);

  const projectMemorySection = project
    ? `\nRelevant "${project.name}" Project Memories:\n${formatRetrievedMemories(projectSelected)}\n`
    : "";

  const memoryContext = `
User Profile:
- Name: ${data.profile.name}
- Favorite Color: ${data.profile.favoriteColor || "Unknown"}
- Location: ${data.profile.location || "Unknown"}
- Occupation: ${data.profile.occupation || "Unknown"}

Preferences:
${formatList(data.preferences)}

Projects:
${formatList(data.projects)}

Goals:
${data.goals.length > 0 ? data.goals.map((g) => `- ${g.completed ? "[Complete]" : "[Active]"} ${g.title}`).join("\n") : "- None"}

Relevant Global Memories:
${formatRetrievedMemories(globalSelected)}
${projectMemorySection}
Calendar:
${data.calendar.length > 0 ? data.calendar.slice(-5).map((e) => `- ${e.title} (${e.dateText}, ${e.timeText})`).join("\n") : "- None"}
`;

  logContextDebug(
    projectId,
    conversationId,
    scored.filter((s) => s.memory.scope !== "project").length,
    scored.filter((s) => s.memory.scope === "project").length,
    selected.length,
    Boolean(project?.instructions)
  );

  return {
    memoryContext,
    historyText,
    project: project ? { name: project.name, description: project.description, instructions: project.instructions } : null,
    projectId,
    conversation,
  };
}

// Objective 13: only the CURRENT conversation's own transcript, capped by
// BOTH message count and character budget (whichever is reached first) —
// never every chat in a project, and never unbounded even for one very
// long-running single chat.
function formatConversationHistory(messages: ChatMessage[]): string {
  if (messages.length === 0) return "- None (new conversation)";

  const recent = messages.slice(-MAX_HISTORY_MESSAGES);
  const lines: string[] = [];
  let used = 0;

  // Walk backwards from the most recent message so the budget always keeps
  // the FRESHEST messages when it has to cut something, then reverse for
  // chronological reading order.
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i];
    const label = m.role === "user" ? "User" : m.agent === "ignis" ? "IGNIS" : "LOIS";
    const line = `${label}: ${m.text}`;

    if (used + line.length > MAX_HISTORY_CHARS) break;

    lines.unshift(line);
    used += line.length;
  }

  return lines.length > 0 ? lines.join("\n") : "- None";
}

// Fallback for the (rare, safety-net-only) case where no conversationId
// was provided at all — reproduces exactly what getMemoryContext() in
// memoryService.ts already did, so behavior for that path is unchanged.
function formatLegacyRecentConversations(
  conversations: { agent: string; userMessage: string; assistantReply: string }[]
): string {
  return conversations.length > 0
    ? conversations
        .slice(-5)
        .map((c) => `User: ${c.userMessage}\nAssistant: ${c.assistantReply}`)
        .join("\n\n")
    : "- None";
}

function formatList(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None";
}

// Re-exported so callers only need one import for both the assembly
// function and the MemoryRecord type it operates on, if needed.
export type { MemoryRecord };
