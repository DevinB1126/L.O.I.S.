import { useEffect, useState } from "react";
import type { Agent, Project } from "../../types";
import type { VoiceController } from "../../hooks/useVoice";
import type { MemoryController } from "../../hooks/useMemory";
import { useChat } from "../../hooks/useChat";
import { createMicClickHandler } from "../../hooks/useVoice";
import { ChatTranscript } from "../chat/ChatTranscript";
import { Composer } from "../chat/Composer";
import { VoiceActivityIndicator } from "../chat/VoiceActivityIndicator";
import * as api from "../../services/api";

interface ProjectChatViewProps {
  project: Project;
  conversationId: string;
  agent: Agent;
  currentAgentLabel: string;
  voice: VoiceController;
  voiceLabel: string;
  onBack: () => void;
  /** Action Execution Layer v2 (Objective 11) — the SAME app-root
   *  MemoryController RightPanels/GoalsView/CalendarView already read from
   *  (threaded down via ConversationPanel -> ProjectsRoot), not a second
   *  independent instance. This used to call its own useMemory() here
   *  purely to have *something* to refresh after sending — which meant an
   *  action (e.g. goals.replace) fired from inside a project chat updated
   *  a local state nobody rendered, while the real Goals Matrix/Current
   *  Goals sidebar (driven by the app-root instance) never learned
   *  anything had changed. Sharing the one instance is what makes "both
   *  update after a mutation" (Objective 11's own requirement) true by
   *  construction instead of by coincidence. */
  memory: MemoryController;
}

// Objective 25/B17 — a project chat uses the SAME chat interface as the
// plain global Chat view (ChatTranscript + Composer, both reused verbatim),
// just pointed at this specific conversation via its own useChat instance.
// The only additions are the "PROJECT / CHAT" identity breadcrumb
// (Objective 25/B11's own example) and a back-to-workspace control.
export function ProjectChatView({
  project,
  conversationId,
  agent,
  currentAgentLabel,
  voice,
  voiceLabel,
  onBack,
  memory,
}: ProjectChatViewProps) {
  const [chatTitle, setChatTitle] = useState<string>("");

  const chat = useChat({
    agent,
    conversationId,
    voiceState: voice.voiceState,
    setVoiceState: voice.setVoiceState,
    speak: voice.speak,
    refreshMemory: memory.loadMemory,
  });

  useEffect(() => {
    let cancelled = false;
    api.getConversation(conversationId).then((conversation) => {
      if (!cancelled) setChatTitle(conversation?.title ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const micHandler = createMicClickHandler(voice, chat);

  return (
    <div className="project-chat-view">
      <div className="project-chat-breadcrumb">
        <button type="button" className="project-back-button" onClick={onBack} title="Back to project workspace">
          ← {project.name}
        </button>
        <span className="project-chat-breadcrumb-current">
          {project.name.toUpperCase()} / {chatTitle.toUpperCase() || "..."}
        </span>
      </div>

      <ChatTranscript
        chat={chat}
        currentAgentLabel={currentAgentLabel}
        greeting={`${project.name} — ${currentAgentLabel} is ready.`}
        className="project-chat-transcript"
      />

      <VoiceActivityIndicator voiceState={voice.voiceState} voiceLabel={voiceLabel} />

      <Composer
        chat={chat}
        voice={voice}
        currentAgentLabel={currentAgentLabel}
        onMicClick={micHandler}
        projectId={project.id}
      />
    </div>
  );
}
