import { askOllama } from "../providers/ollamaProvider";
import { assembleAgentContext } from "../conversations/agentContext";
import { buildAgentPrompt } from "./agentPrompt";
import type { RequestTimer } from "../perf/requestTimer";
import { scheduleOllamaTask, OllamaPriority } from "../perf/ollamaScheduler";

// Projects v1A: conversationId is optional, threaded through to
// assembleAgentContext so /chat (non-streaming) builds the exact same
// project-aware prompt /chat/stream does (see agentRouter.streamAgentResponse's
// own comment on why the two paths must never diverge).
export async function loisAgent(message: string, conversationId?: string, timer?: RequestTimer): Promise<string> {
  const { memoryContext, historyText, project } = await assembleAgentContext(message, conversationId, timer);
  const prompt = buildAgentPrompt("lois", message, memoryContext, historyText, project);
  timer?.mark("promptAssembly");

  // Ollama Scheduler v1 (Objective 10) — same HIGH-priority path as the
  // streaming route, so /chat and /chat/stream both go through the
  // scheduler and neither can bypass it.
  const reply = await scheduleOllamaTask("chat-generate", OllamaPriority.HIGH, (signal) => askOllama(prompt, signal));
  timer?.mark("ollamaGeneration");

  return reply;
}
