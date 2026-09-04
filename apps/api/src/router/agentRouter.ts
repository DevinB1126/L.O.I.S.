import { loisAgent } from "../agents/lois";
import { ignisAgent } from "../agents/ignis";
import { AgentName, buildAgentPrompt } from "../agents/agentPrompt";
import { streamOllamaResponse, StreamOptions } from "../providers/ollamaProvider";
import { assembleAgentContext } from "../conversations/agentContext";
import type { RequestTimer } from "../perf/requestTimer";
import { scheduleOllamaTask, OllamaPriority } from "../perf/ollamaScheduler";

// Re-exported for backward compatibility — this used to be declared here
// directly; it now lives alongside the prompt-construction logic it
// describes, in agents/agentPrompt.ts.
export type { AgentName };

/** Non-streaming agent path (used by /chat). Projects v1A: conversationId
 *  is optional so any existing caller that doesn't pass one keeps getting
 *  exactly the old global-only behavior (assembleAgentContext falls back
 *  to the legacy flat conversation log when no conversation is found). */
export async function routeAgent(
  agent: AgentName,
  message: string,
  conversationId?: string,
  timer?: RequestTimer
): Promise<string> {
  if (agent === "ignis") {
    return ignisAgent(message, conversationId, timer);
  }

  return loisAgent(message, conversationId, timer);
}

/**
 * Streaming counterpart to routeAgent(), used by /chat/stream.
 *
 * This builds the exact same prompt as the non-streaming path — same
 * persona, same memory/project context, same conversation history, same
 * message — via assembleAgentContext() + buildAgentPrompt(), so LOIS/IGNIS
 * behavior cannot diverge between streamed and non-streamed responses.
 * Only the Ollama call itself (streaming vs. single-shot) differs.
 *
 * Performance Pass v1 (Phase 1) — marks "promptAssembly" (buildAgentPrompt
 * itself is pure string concatenation, but this also captures the small
 * gap between assembleAgentContext resolving and the Ollama call starting),
 * "ollamaRequestStart"/"ollamaGeneration" around the model call, and
 * "timeToFirstOllamaChunk" the first time `onChunk` is actually invoked —
 * the single most important number for perceived speed (Phase 2: TTFT).
 */
export async function streamAgentResponse(
  agent: AgentName,
  message: string,
  onChunk: (chunk: string) => void,
  options?: StreamOptions,
  conversationId?: string,
  timer?: RequestTimer
): Promise<string> {
  const { memoryContext, historyText, project } = await assembleAgentContext(message, conversationId, timer);
  const prompt = buildAgentPrompt(agent, message, memoryContext, historyText, project);
  timer?.mark("promptAssembly");

  let firstChunkSeen = false;

  function timedOnChunk(chunk: string): void {
    if (!firstChunkSeen) {
      firstChunkSeen = true;
      timer?.mark("timeToFirstOllamaChunk");
    }
    onChunk(chunk);
  }

  // Ollama Scheduler v1 (Objective 10) — chat generation always goes
  // through the scheduler at HIGH priority, so a still-running/queued
  // background task (memory extraction, memory embedding) never gets to
  // occupy Ollama ahead of an interactive request. `options.signal` (the
  // Express route's client-disconnect controller, when present) is passed
  // as `externalSignal` so a still-QUEUED request is cancelled immediately
  // if the browser disconnects before it starts; the scheduler's own
  // per-attempt signal (composing that same externalSignal plus, in
  // principle, preemption — though HIGH-priority tasks are never
  // preempted, see ollamaScheduler.ts) is what actually reaches
  // streamOllamaResponse, replacing the raw options.signal.
  const result = await scheduleOllamaTask(
    "chat-stream",
    OllamaPriority.HIGH,
    (signal) => streamOllamaResponse(prompt, timedOnChunk, { ...options, signal }),
    { externalSignal: options?.signal }
  );
  timer?.mark("ollamaGeneration");

  return result;
}
