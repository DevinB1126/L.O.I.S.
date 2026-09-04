import type { Agent, HudView } from "../../types";
import type { ChatController } from "../../hooks/useChat";
import type { MemoryController } from "../../hooks/useMemory";
import type { DocumentsController } from "../../hooks/useDocuments";
import type { VoiceController } from "../../hooks/useVoice";
import { OrbCore } from "./OrbCore";
import { CompactOrb } from "./CompactOrb";
import { ConversationPanel } from "../chat/ConversationPanel";
import { Composer } from "../chat/Composer";
import { VoiceActivityIndicator } from "../chat/VoiceActivityIndicator";

interface CenterStageProps {
  agent: Agent;
  onAgentChange: (agent: Agent) => void;
  currentAgentLabel: string;
  activeView: HudView;
  memory: MemoryController;
  documents: DocumentsController;
  greeting: string;
  voiceLabel: string;
  chat: ChatController;
  voice: VoiceController;
  onMicClick: () => void;
}

// Chat workspace pass — the conversation transcript is now the dominant
// element of the center panel (Objective B1-B2), not the cinematic orb.
// The full OrbCore (rings/orbits/particles/floating chips) is kept exactly
// as it was, but only for non-chat views, where it's still the primary
// visual (Objective B10: "stronger visibility in non-chat views"); the
// chat/project workspace gets a small CompactOrb in its place instead —
// same core identity, none of the vertical space cost. CORE LINK and the
// permanent VOICE/waveform strip are gone from here entirely (moved to
// RightPanels' SYSTEM STATUS card and LeftRail respectively — see
// CompactOrb/VoiceActivityIndicator's own comments) — CommandRow is
// replaced by the larger Composer, and CPU/RAM/NET's old telemetry-dock is
// gone (now in LeftRail's LOCAL SYSTEM card).
export function CenterStage({
  agent,
  onAgentChange,
  currentAgentLabel,
  activeView,
  memory,
  documents,
  greeting,
  voiceLabel,
  chat,
  voice,
  onMicClick,
}: CenterStageProps) {
  // "chat" is the plain global conversation; "projects" covers the
  // project list/workspace/chat states, which also benefit from the extra
  // vertical room and don't need the full cinematic orb competing with
  // them (Objective B10).
  const isConversationalView = activeView === "chat" || activeView === "projects";

  return (
    <section className={`center-stage ${isConversationalView ? "center-stage--chat" : ""}`}>
      <header className="top-status">
        <div className="view-chip">VIEW: {activeView.toUpperCase()}</div>
        <span>CORE STATUS: ACTIVE</span>

        <div className="top-actions">
          {isConversationalView && <CompactOrb voiceState={voice.voiceState} currentAgentLabel={currentAgentLabel} />}

          <button onClick={chat.clearVisibleChat}>CLEAR CHAT</button>

          <select value={agent} onChange={(e) => onAgentChange(e.target.value as Agent)}>
            <option value="lois">LOIS</option>
            <option value="ignis">IGNIS</option>
          </select>
        </div>
      </header>

      {!isConversationalView && <OrbCore voiceState={voice.voiceState} currentAgentLabel={currentAgentLabel} />}

      <ConversationPanel
        activeView={activeView}
        memory={memory}
        documents={documents}
        chat={chat}
        agent={agent}
        currentAgentLabel={currentAgentLabel}
        greeting={greeting}
        voiceState={voice.voiceState}
        voiceLabel={voiceLabel}
        voice={voice}
      />

      {/* Projects v1A: the Projects view owns its own voice indicator/
          composer, scoped to whichever project chat is actually open (see
          ProjectsRoot/ProjectWorkspaceView/ProjectChatView) — the global
          one below always targets the global conversation, which would be
          silently wrong to leave active while looking at a specific
          project chat. */}
      {activeView !== "projects" && (
        <>
          <VoiceActivityIndicator voiceState={voice.voiceState} voiceLabel={voiceLabel} />
          <Composer chat={chat} voice={voice} currentAgentLabel={currentAgentLabel} onMicClick={onMicClick} />
        </>
      )}
    </section>
  );
}
