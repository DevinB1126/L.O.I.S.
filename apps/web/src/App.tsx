import { useEffect, useState } from "react";
import "./App.css";
import type { Agent, HudView } from "./types";
import { useMemory } from "./hooks/useMemory";
import { useVoice } from "./hooks/useVoice";
import { useChat } from "./hooks/useChat";
import { useDocuments } from "./hooks/useDocuments";
import { useGlobalConversation } from "./hooks/useGlobalConversation";
import { BackgroundScene } from "./components/hud/BackgroundScene";
import { LeftRail } from "./components/hud/LeftRail";
import { CenterStage } from "./components/hud/CenterStage";
import { RightPanels } from "./components/hud/RightPanels";

// App.tsx is the application composition root. It owns top-level agent
// selection, the active HUD view, and the simulated system telemetry
// (clock/temp/CPU/RAM), then wires the memory/voice/chat hooks together and
// hands data + handlers down to the HUD sections. Presentation, API
// communication, and stateful behavior for each section now live in their
// own modules (see components/, hooks/, services/, types/).
function App() {
  const [agent, setAgent] = useState<Agent>("lois");
  const [activeView, setActiveView] = useState<HudView>("chat");
  const [currentTime, setCurrentTime] = useState(new Date());
  const [systemTemp, setSystemTemp] = useState(41);
  const [cpuUsage, setCpuUsage] = useState(18);
  const [ramUsage, setRamUsage] = useState(32);

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const statsTimer = setInterval(() => {
      setCpuUsage(Math.floor(Math.random() * 18) + 12);
      setRamUsage(Math.floor(Math.random() * 20) + 26);
    }, 4000);

    return () => clearInterval(statsTimer);
  }, []);

  useEffect(() => {
    const tempTimer = setInterval(() => {
      setSystemTemp((prev) => {
        const change = Math.random() > 0.5 ? 1 : -1;
        const next = prev + change;

        if (next < 38) return 38;
        if (next > 47) return 47;

        return next;
      });
    }, 5000);

    return () => clearInterval(tempTimer);
  }, []);

  const memory = useMemory();
  const documents = useDocuments();
  const voice = useVoice(agent);
  const globalConversationId = useGlobalConversation();
  const chat = useChat({
    agent,
    conversationId: globalConversationId,
    voiceState: voice.voiceState,
    setVoiceState: voice.setVoiceState,
    speak: voice.speak,
    refreshMemory: memory.loadMemory,
  });

  function handleMicClick() {
    if (voice.voiceState === "speaking") {
      voice.stopSpeaking();
      return;
    }

    voice.startListening((transcript) => {
      chat.setMessage(transcript);
      chat.sendMessage(transcript);
    });
  }

  const currentAgentLabel = agent === "lois" ? "LOIS" : "IGNIS";

  const timeDisplay = currentTime.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const dateDisplay = currentTime.toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const hour = currentTime.getHours();

  const greeting =
    hour < 12 ? "Good morning, Devin." : hour < 18 ? "Good afternoon, Devin." : "Good evening, Devin.";

  const voiceLabel =
    voice.voiceState === "standby"
      ? "VOICE MODULE STANDBY"
      : voice.voiceState === "listening"
      ? "LISTENING..."
      : voice.voiceState === "thinking"
      ? "PROCESSING..."
      : "SPEAKING...";

  return (
    <main className={`hud ${agent} state-${voice.voiceState}`}>
      <BackgroundScene />

      <LeftRail
        agent={agent}
        currentAgentLabel={currentAgentLabel}
        activeView={activeView}
        onSelectView={setActiveView}
        timeDisplay={timeDisplay}
        dateDisplay={dateDisplay}
        systemTemp={systemTemp}
        cpuUsage={cpuUsage}
        ramUsage={ramUsage}
        netSpeed="1.2 KB/s"
      />

      <CenterStage
        agent={agent}
        onAgentChange={setAgent}
        currentAgentLabel={currentAgentLabel}
        activeView={activeView}
        memory={memory}
        documents={documents}
        greeting={greeting}
        voiceLabel={voiceLabel}
        chat={chat}
        voice={voice}
        onMicClick={handleMicClick}
      />

      <RightPanels currentAgentLabel={currentAgentLabel} voiceState={voice.voiceState} memory={memory} />

      <aside className="mini-system-column">
        <section className="time-widget">
          <strong>{timeDisplay}</strong>
          <p>{dateDisplay}</p>
        </section>

        <section className="meter-card">
          <div className="circle-meter">
            <span>CPU</span>
            <strong>{cpuUsage}%</strong>
          </div>
        </section>

        <section className="meter-card">
          <div className="circle-meter ram">
            <span>RAM</span>
            <strong>{ramUsage}%</strong>
          </div>
        </section>

        <section className="net-card">
          <span>NET</span>
          <strong>1.2 KB/s</strong>
          <div className="net-lines" />
        </section>
      </aside>

      <section className="weather-card">
        <div>☁</div>
        <strong>72°F</strong>
        <p>Partly Cloudy</p>
        <p>Local Area</p>
      </section>

      <footer className="hud-footer">
        <span>🔒 SECURE CONNECTION</span>
        <span>ENCRYPTED</span>
        <span>PRIVATE</span>
        <span>LOCAL</span>
        <span>ALL SYSTEMS NOMINAL</span>
      </footer>
    </main>
  );
}

export default App;
