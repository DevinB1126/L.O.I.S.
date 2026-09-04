import { askOllama } from "../providers/ollamaProvider";
import { assembleAgentContext } from "../conversations/agentContext";
import { buildAgentPrompt } from "./agentPrompt";
import type { RequestTimer } from "../perf/requestTimer";
import { scheduleOllamaTask, OllamaPriority } from "../perf/ollamaScheduler";

// Projects v1A: conversationId is optional, threaded through to
// assembleAgentContext so /chat (non-streaming) builds the exact same
// project-aware prompt /chat/stream does.
export async function ignisAgent(message: string, conversationId?: string, timer?: RequestTimer): Promise<string> {
  const { memoryContext, historyText, project } = await assembleAgentContext(message, conversationId, timer);
  const prompt = buildAgentPrompt("ignis", message, memoryContext, historyText, project);
  timer?.mark("promptAssembly");

  // Ollama Scheduler v1 (Objective 10) — same HIGH-priority path as LOIS's
  // /chat handler and both agents' streaming route, so no agent can bypass
  // the scheduler.
  const reply = await scheduleOllamaTask("chat-generate", OllamaPriority.HIGH, (signal) => askOllama(prompt, signal));
  timer?.mark("ollamaGeneration");

  return reply;
}
