import { useCallback, useEffect, useState } from "react";
import * as api from "../services/api";
import type { Agent, ChatMessage, MemoryData, VoiceState } from "../types";

// Groups chat state together with the actions that mutate it, so
// consumers (App.tsx, ConversationPanel, Composer) take one cohesive
// object instead of a pile of unrelated props.
export interface ChatController {
  message: string;
  setMessage: (value: string) => void;
  messages: ChatMessage[];
  isLoading: boolean;
  sendMessage: (overrideMessage?: string) => Promise<void>;
  clearVisibleChat: () => Promise<void>;
}

export interface UseChatOptions {
  agent: Agent;
  /** Projects v1A — the ONE Conversation this instance renders/sends into.
   *  Global chat and every project chat now go through this same hook,
   *  parameterized by which conversation is active (Objective 25: reuse
   *  the same chat interface, don't build a separate renderer) — undefined
   *  only during the brief moment before App.tsx has resolved/created the
   *  default global conversation on first load. */
  conversationId: string | undefined;
  voiceState: VoiceState;
  setVoiceState: (state: VoiceState) => void;
  speak: (text: string) => void;
  refreshMemory: () => Promise<MemoryData | null>;
}

// Owns chat message state, submission, streaming response handling, chat
// loading state, and conversation history/refresh. Projects v1A: rewritten
// to load/persist through one specific Conversation (via conversationId)
// instead of always reading/writing the single legacy flat conversation
// log — the SAME hook now serves both the plain global Chat view and any
// project chat, just pointed at a different id.
export function useChat({
  agent,
  conversationId,
  voiceState,
  setVoiceState,
  speak,
  refreshMemory,
}: UseChatOptions): ChatController {
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const loadConversationHistory = useCallback(async () => {
    if (!conversationId) {
      setMessages([]);
      return;
    }

    try {
      const conversation = await api.getConversation(conversationId);
      setMessages(conversation?.messages ?? []);
    } catch (error) {
      console.error("Failed to load conversation history:", error);
    }
  }, [conversationId]);

  // Re-loads whenever the active conversation changes (switching chats,
  // switching projects, or returning to global) — Objective 26: no stale
  // transcript from the previous conversation is ever left on screen.
  useEffect(() => {
    loadConversationHistory();
  }, [loadConversationHistory]);

  const sendMessage = useCallback(
    async (overrideMessage?: string) => {
      const currentMessage = overrideMessage ?? message;

      if (!currentMessage.trim() || !conversationId) return;

      setMessages((prev) => [...prev, { role: "user", text: currentMessage }]);
      setMessage("");
      setIsLoading(true);
      setVoiceState("thinking");

      // Tracks whether we successfully got a response/reader back from the
      // backend, so a failure can be classified as "never connected" vs.
      // "connected, then the stream itself failed" (see describeChatError).
      let streamStarted = false;

      try {
        const reader = await api.streamChatMessage(agent, currentMessage, conversationId);
        streamStarted = true;

        const assistantMessage: ChatMessage = {
          role: "assistant",
          agent,
          text: "",
        };

        setMessages((prev) => [...prev, assistantMessage]);

        const decoder = new TextDecoder();
        let fullReply = "";

        while (true) {
          const { done, value } = await reader.read();

          if (done) break;

          const chunk = decoder.decode(value);
          fullReply += chunk;

          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              ...updated[updated.length - 1],
              text: fullReply,
            };
            return updated;
          });
        }

        // The backend cannot change the HTTP status once streaming has
        // begun, so a failure that happens after partial content was
        // already sent shows up in-band as this marker instead of an HTTP
        // error. Treat it as a failure: show the interruption clearly, but
        // do not speak it and do not treat it as a successfully saved reply
        // (the backend does not persist it to conversation history either).
        const markerIndex = fullReply.indexOf(api.STREAM_ERROR_MARKER);

        if (markerIndex !== -1) {
          const partialText = fullReply.slice(0, markerIndex).trimEnd();
          const errorDetail = fullReply.slice(markerIndex + api.STREAM_ERROR_MARKER.length).trim();

          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              ...updated[updated.length - 1],
              text:
                (partialText ? partialText + "\n\n" : "") +
                `[Response interrupted: ${errorDetail || "streaming error"}]`,
            };
            return updated;
          });

          return;
        }

        // Action Execution Layer v1 — when the backend actually executed a
        // calendar/goal/memory action for this message, the real
        // (grounded) confirmation text is followed by this marker plus a
        // JSON summary (see ACTION_RESULT_MARKER's own comment in api.ts).
        // Strip it before displaying/speaking — the visible text is
        // everything before the marker, exactly the grounded confirmation
        // the backend built from the real ActionResult, never LLM prose.
        const actionMarkerIndex = fullReply.indexOf(api.ACTION_RESULT_MARKER);
        const visibleReply = actionMarkerIndex !== -1 ? fullReply.slice(0, actionMarkerIndex).trimEnd() : fullReply;

        let actionSummary: api.StreamedActionSummary | null = null;

        if (actionMarkerIndex !== -1) {
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = { ...updated[updated.length - 1], text: visibleReply };
            return updated;
          });

          try {
            actionSummary = JSON.parse(fullReply.slice(actionMarkerIndex + api.ACTION_RESULT_MARKER.length).trim());
          } catch {
            // Malformed marker payload — treat as "no structured summary"
            // rather than breaking the whole turn over it; the visible
            // reply above is already correct either way.
          }
        }

        // Action Execution Layer v2 (Objective 9) — refresh only when
        // there is real reason to believe something changed: either this
        // wasn't an action turn at all (normal chat — refreshMemory() is
        // cheap, a single GET, and this preserves the existing behavior of
        // keeping the snapshot current), or it WAS an action and it
        // actually succeeded. A failed action changed nothing, so
        // refetching after one is a wasted round-trip, not a correctness
        // issue — but the whole point of this fix is not doing pointless
        // work on faith, so it's skipped.
        if (!actionSummary || actionSummary.success) {
          if (actionSummary) {
            console.log(`[chat] ${actionSummary.domain} state changed`);
            console.log(`[frontend] refreshing ${actionSummary.domain}`);
          }

          const refreshed = await refreshMemory();

          if (actionSummary?.domain === "goals" && refreshed) {
            const activeCount = refreshed.goals.filter((goal) => !goal.completed).length;
            console.log(`[frontend] received ${activeCount} active goal(s)`);
          }
        }

        speak(visibleReply);
      } catch (error) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            agent,
            text: describeChatError(error, streamStarted),
          },
        ]);
      } finally {
        setIsLoading(false);
        if (voiceState !== "speaking") {
          setVoiceState("standby");
        }
      }
    },
    [agent, conversationId, message, voiceState, setVoiceState, speak, refreshMemory]
  );

  const clearVisibleChat = useCallback(async () => {
    if (!conversationId) return;

    try {
      await api.clearConversationMessages(conversationId);
      setMessages([]);
    } catch (error) {
      console.error("Failed to clear conversation history:", error);
    }
  }, [conversationId]);

  return { message, setMessage, messages, isLoading, sendMessage, clearVisibleChat };
}

// Distinguishes the failure modes the /chat/stream request can hit instead
// of collapsing all of them into one generic "connection failed" message:
//   - never reached the backend at all (fetch() itself rejected)
//   - reached the backend, but it reported the local model/provider is down
//   - reached the backend, but it returned some other error before streaming
//   - reached the backend and started streaming, then the stream itself failed
function describeChatError(error: unknown, streamStarted: boolean): string {
  // fetch() rejects with a TypeError when the request never got a response
  // at all — the backend process isn't running, is on the wrong port, or a
  // network/CORS failure blocked it outright.
  if (error instanceof TypeError) {
    return "Unable to reach the LOIS API. Confirm the backend is running on port 3001.";
  }

  const message = error instanceof Error ? error.message : "";

  // The backend wraps Ollama/provider failures into an error message that
  // names Ollama explicitly (see OllamaRequestError / OllamaStreamError in
  // apps/api/src/providers/ollamaProvider.ts) — surface that distinctly
  // rather than implying the backend itself is unreachable.
  if (/ollama/i.test(message)) {
    return "LOIS core is online, but the local AI model is unavailable. Confirm Ollama is running.";
  }

  if (streamStarted) {
    return `The response stream failed after connecting${message ? `: ${message}` : "."}`;
  }

  if (message) {
    return `LOIS encountered an internal processing error: ${message}`;
  }

  return "LOIS encountered an unexpected error. Please try again.";
}
