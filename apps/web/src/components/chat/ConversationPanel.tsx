import type { Agent, HudView, VoiceState } from "../../types";
import type { ChatController } from "../../hooks/useChat";
import type { MemoryController } from "../../hooks/useMemory";
import type { DocumentsController } from "../../hooks/useDocuments";
import type { VoiceController } from "../../hooks/useVoice";
import { MemoryView } from "../memory/MemoryView";
import { GoalsView } from "../goals/GoalsView";
import { CalendarView } from "../calendar/CalendarView";
import { DocumentsView } from "../documents/DocumentsView";
import { ProjectsRoot } from "../projects/ProjectsRoot";
import { ChatTranscript } from "./ChatTranscript";

interface ConversationPanelProps {
  activeView: HudView;
  memory: MemoryController;
  documents: DocumentsController;
  chat: ChatController;
  agent: Agent;
  currentAgentLabel: string;
  greeting: string;
  voiceState: VoiceState;
  voiceLabel: string;
  voice: VoiceController;
}

// The .conversation-panel section: switches between the Memory/Goals/
// Calendar/Voice/Documents/Projects focus views and the default chat
// message list, exactly as App.tsx's inline ternary chain used to. Moved
// out verbatim.
export function ConversationPanel({
  activeView,
  memory,
  documents,
  chat,
  agent,
  currentAgentLabel,
  greeting,
  voiceState,
  voiceLabel,
  voice,
}: ConversationPanelProps) {
  if (activeView === "memory") {
    // conversation-panel--memory: unlike every other use of .conversation-panel
    // (which scrolls itself), the Memory view has its own inner scrollable
    // list (.memory-list) — see App.css. Without this modifier the outer
    // panel and the inner list both had overflow-y:auto, so wheel/trackpad
    // scroll input had two competing scroll containers to resolve against,
    // which is what produced the sticky/jumpy scrolling.
    return (
      <section className="conversation-panel conversation-panel--memory">
        <MemoryView memory={memory} />
      </section>
    );
  }

  if (activeView === "documents") {
    // conversation-panel--documents: same rationale as
    // conversation-panel--memory below — the Documents view owns its own
    // inner scroll containers (the document list and the text preview),
    // so the outer panel must not also try to scroll.
    return (
      <section className="conversation-panel conversation-panel--documents">
        <DocumentsView documents={documents} />
      </section>
    );
  }

  if (activeView === "goals") {
    return (
      <section className="conversation-panel">
        <GoalsView goals={memory.memory?.goals} />
      </section>
    );
  }

  if (activeView === "calendar") {
    return (
      <section className="conversation-panel">
        <CalendarView events={memory.memory?.calendar} />
      </section>
    );
  }

  if (activeView === "voice") {
    return (
      <section className="conversation-panel">
        <div className="focus-view">
          <h2>Voice Interface</h2>

          <div className="voice-focus">
            <div className={`voice-orb ${voiceState}`}>
              {voiceState === "standby"
                ? "STANDBY"
                : voiceState === "listening"
                ? "LISTENING"
                : voiceState === "thinking"
                ? "PROCESSING"
                : "SPEAKING"}
            </div>

            <div>
              <p>Current Voice State: {voiceLabel}</p>
              <p>Speech Recognition: Enabled</p>
              <p>Speech Output: Enabled</p>
              <p>Active Voice: {agent === "lois" ? "British Female" : "British Male"}</p>
            </div>
          </div>
        </div>
      </section>
    );
  }

  if (activeView === "projects") {
    // ProjectsRoot owns its own internal scroll containers (project list /
    // workspace / chat transcript), same posture as Memory/Documents above.
    return (
      <section className="conversation-panel conversation-panel--projects">
        <ProjectsRoot agent={agent} currentAgentLabel={currentAgentLabel} voice={voice} voiceLabel={voiceLabel} />
      </section>
    );
  }

  return <ChatTranscript chat={chat} currentAgentLabel={currentAgentLabel} greeting={greeting} />;
}
