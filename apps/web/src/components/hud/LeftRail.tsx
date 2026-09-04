import type { Agent, HudView } from "../../types";

interface LeftRailProps {
  agent: Agent;
  currentAgentLabel: string;
  activeView: HudView;
  onSelectView: (view: HudView) => void;
  timeDisplay: string;
  dateDisplay: string;
  systemTemp: number;
  cpuUsage: number;
  ramUsage: number;
  netSpeed: string;
}

// The left navigation rail: brand header, HUD view nav, and local system
// card. Moved out of App.tsx verbatim (same class names/nesting).
//
// Chat workspace pass (Objective B9): CPU/RAM/NET moved here from the
// center panel's old telemetry-dock, which existed only to spend prime
// conversation space on decorative readouts. Same live values, same
// update cadence — just relocated, and no longer duplicated in the center
// panel.
export function LeftRail({
  agent,
  currentAgentLabel,
  activeView,
  onSelectView,
  timeDisplay,
  dateDisplay,
  systemTemp,
  cpuUsage,
  ramUsage,
  netSpeed,
}: LeftRailProps) {
  return (
    <aside className="left-rail">
      <div className="brand">
        <h1>{currentAgentLabel}</h1>
        <p>
          {agent === "lois"
            ? "Limitless Operational Intelligence System"
            : "Integrated Guidance & Networked Intelligence System"}
        </p>
        <span>v1.0.0</span>
      </div>

      <nav className="hud-nav">
        <button
          className={activeView === "chat" ? "active" : ""}
          onClick={() => onSelectView("chat")}
        >
          ▣ Chat
        </button>

        <button
          className={activeView === "projects" ? "active" : ""}
          onClick={() => onSelectView("projects")}
        >
          ◫ Projects
        </button>

        <button
          className={activeView === "memory" ? "active" : ""}
          onClick={() => onSelectView("memory")}
        >
          ◌ Memory
        </button>

        <button
          className={activeView === "goals" ? "active" : ""}
          onClick={() => onSelectView("goals")}
        >
          ◎ Goals
        </button>

        <button
          className={activeView === "calendar" ? "active" : ""}
          onClick={() => onSelectView("calendar")}
        >
          □ Calendar
        </button>

        <button
          className={activeView === "voice" ? "active" : ""}
          onClick={() => onSelectView("voice")}
        >
          ◍ Voice
        </button>

        <button
          className={activeView === "documents" ? "active" : ""}
          onClick={() => onSelectView("documents")}
        >
          ▤ Documents
        </button>
      </nav>

      <section className="local-card">
        <h2>LOCAL SYSTEM</h2>
        <strong>ONLINE</strong>

        <div className="local-metrics">
          <div className="local-metric">
            <span>CPU</span>
            <strong>{cpuUsage}%</strong>
          </div>
          <div className="local-metric">
            <span>RAM</span>
            <strong>{ramUsage}%</strong>
          </div>
          <div className="local-metric">
            <span>NET</span>
            <strong>{netSpeed}</strong>
          </div>
        </div>

        <p>Time: {timeDisplay}</p>
        <p>Date: {dateDisplay}</p>
        <p>Temperature: {systemTemp}°C</p>
        <div className="mini-eq" />
      </section>
    </aside>
  );
}
