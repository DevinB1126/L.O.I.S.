import { useEffect, useState } from "react";
import type { Agent, Project } from "../../types";
import type { VoiceController } from "../../hooks/useVoice";
import { useChat } from "../../hooks/useChat";
import { useMemory } from "../../hooks/useMemory";
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
}: ProjectChatViewProps) {
  const [chatTitle, setChatTitle] = useState<string>("");

  // A lightweight, local memory refresh: the top-level useMemory instance
  // already exists at the App root for the Memory Snapshot panel, but this
  // component doesn't have access to it — a project chat still wants to
  // trigger *a* refresh after sending (matching the global chat's own
  // post-send behavior), so it gets its own minimal instance rather than
  // threading the app-root one all the way down through three components.
  const memory = useMemory();

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
