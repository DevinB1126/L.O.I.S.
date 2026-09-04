import { useEffect, useRef, useState } from "react";
import type { ChatController } from "../../hooks/useChat";
import { MessageContent } from "./MessageContent";

interface ChatTranscriptProps {
  chat: ChatController;
  currentAgentLabel: string;
  greeting: string;
  /** Extra class(es) appended to the scroll container, e.g. for a project
   *  chat that needs its own layout tweaks without touching the shared
   *  base styling. */
  className?: string;
}

// How close to the bottom (px) counts as "already there" for auto-scroll
// purposes — matches the intent of "continue following while I'm already
// near the bottom" without requiring the user to be scrolled to the exact
// last pixel.
const NEAR_BOTTOM_THRESHOLD = 80;

// Projects v1A (Objective 25) — the continuous message-list renderer
// extracted out of ConversationPanel's default branch so BOTH the plain
// global Chat view and any project chat use the exact same transcript
// component (same auto-scroll behavior, same bubble styling), parameterized
// only by which ChatController instance they're given. Not a new chat
// renderer — the original one, just made reusable.
//
// Chat workspace pass (Objective B2/B3/B4/B12/B14) — messages now render as
// Markdown (see MessageContent) with natural height (no fixed-height
// viewport), and assistant messages get a hover-revealed Copy action. The
// ref-based smart-autoscroll logic below is unchanged — it already only
// touched refs, never React state, on every scroll event, which is exactly
// what B4 asks for; nothing here needed to change for that objective.
export function ChatTranscript({ chat, currentAgentLabel, greeting, className }: ChatTranscriptProps) {
  const transcriptRef = useRef<HTMLElement | null>(null);
  const pinnedToBottomRef = useRef(true);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  function handleTranscriptScroll() {
    const el = transcriptRef.current;
    if (!el) return;

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedToBottomRef.current = distanceFromBottom < NEAR_BOTTOM_THRESHOLD;
  }

  useEffect(() => {
    const el = transcriptRef.current;
    if (!el || !pinnedToBottomRef.current) return;

    el.scrollTop = el.scrollHeight;
  }, [chat.messages]);

  async function handleCopyMessage(index: number, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex((current) => (current === index ? null : current)), 1500);
    } catch {
      // Non-essential convenience action — a clipboard failure shouldn't
      // surface as a broken transcript.
    }
  }

  return (
    <section
      className={className ? `conversation-panel ${className}` : "conversation-panel"}
      ref={(el) => {
        transcriptRef.current = el;
      }}
      onScroll={handleTranscriptScroll}
    >
      {chat.messages.length === 0 ? (
        <div className="welcome">
          <h2>{greeting}</h2>
          <p>{currentAgentLabel} core is online. How may I assist?</p>
        </div>
      ) : (
        // One continuous transcript — every message in chat.messages, not
        // just the last few (the full history is always kept in state,
        // only the render was ever capped by anything else).
        chat.messages.map((msg, index) => (
          <div key={index} className={`hud-message ${msg.role}`}>
            <div className="hud-message-header">
              <strong>{msg.role === "user" ? "DEVIN" : msg.agent === "ignis" ? "IGNIS" : "LOIS"}</strong>

              {/* Objective B14 — Copy only, hover/focus-revealed, assistant
                  messages only. Not cluttering every message permanently. */}
              {msg.role === "assistant" && msg.text && (
                <button
                  type="button"
                  className="message-copy-button"
                  onClick={() => handleCopyMessage(index, msg.text)}
                  title="Copy response"
                >
                  {copiedIndex === index ? "Copied" : "Copy"}
                </button>
              )}
            </div>

            <MessageContent text={msg.text} />
          </div>
        ))
      )}

      {chat.isLoading && (
        <div className="hud-message assistant">
          <strong>{currentAgentLabel}</strong>
          <p className="hud-message-pending">Processing request...</p>
        </div>
      )}
    </section>
  );
}
