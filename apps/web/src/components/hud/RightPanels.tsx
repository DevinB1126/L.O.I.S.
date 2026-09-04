import type { VoiceState } from "../../types";
import type { MemoryController } from "../../hooks/useMemory";
import { recurrenceLabel } from "../../utils/calendar";

interface RightPanelsProps {
  currentAgentLabel: string;
  voiceState: VoiceState;
  memory: MemoryController;
}

// The right-hand HUD panels: system status, memory snapshot, current goals
// (with complete/delete actions), schedule (with delete), and recent memory
// facts (with delete). Moved out of App.tsx verbatim (same class
// names/nesting/slicing logic).
export function RightPanels({ currentAgentLabel, voiceState, memory }: RightPanelsProps) {
  const data = memory.memory;

  return (
    <aside className="right-panels">
      <section className="hud-card">
        <h2>SYSTEM STATUS</h2>
        <p>
          <span /> {currentAgentLabel} Core: Online
        </p>
        <p>
          <span /> Memory: Active
        </p>
        <p>
          <span /> Local Model: Connected
        </p>
        {/* Chat workspace pass (Objective B6): relocated from the floating
            CORE LINK bubble that used to float over the center transcript —
            same telemetry, just no longer spending prime conversation
            space on it. */}
        <p>Core Link: 22 ms</p>
        <p>Voice: {voiceState.toUpperCase()}</p>
      </section>

      <section className="hud-card icon-card">
        <h2>
          MEMORY SNAPSHOT <b>♙</b>
        </h2>
        <p>Name: {data?.profile.name || "Unknown"}</p>
        <p>Location: {data?.profile.location || "Unknown"}</p>
        <p>Favorite Color: {data?.profile.favoriteColor || "Unknown"}</p>
        <p>Occupation: {data?.profile.occupation || "Unknown"}</p>
      </section>

      <section className="hud-card icon-card">
        <h2>
          CURRENT GOALS <b>◎</b>
        </h2>
        <ul>
          {data?.goals && data.goals.length > 0 ? (
            data.goals
              .filter((goal) => !goal.completed)
              .slice(0, 4)
              .map((goal) => (
                <li key={goal.id} className="goal-item">
                  <span>{goal.title || "Untitled goal"}</span>

                  <div className="goal-actions">
                    <button onClick={() => memory.completeGoal(goal.id)}>✓</button>
                    <button onClick={() => memory.deleteGoal(goal.id)}>×</button>
                  </div>
                </li>
              ))
          ) : (
            <li>No goals stored yet</li>
          )}
        </ul>
      </section>

      <section className="hud-card schedule-card icon-card">
        <h2>
          SCHEDULE <b>□</b>
        </h2>

        {data?.calendar && data.calendar.length > 0 ? (
          <ul className="schedule-list">
            {data.calendar.slice(-4).map((event) => {
              const repeats = recurrenceLabel(event.recurrence);

              return (
                <li key={event.id} className="schedule-item">
                  <div>
                    <strong>{event.title}</strong>
                    <p>
                      {event.dateText} • {event.timeText}
                      {repeats ? ` • ${repeats}` : ""}
                    </p>
                  </div>

                  <button onClick={() => memory.deleteCalendarEvent(event.id)}>×</button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p>No events scheduled</p>
        )}
      </section>

      <section className="hud-card icon-card">
        <h2>
          RECENT MEMORY <b>◌</b>
        </h2>

        <ul className="memory-fact-list">
          {data?.memories && data.memories.length > 0 ? (
            data.memories.slice(-4).map((record) => (
              <li key={record.id} className="memory-fact-item">
                <span>{record.content}</span>
                <button onClick={() => memory.deleteMemory(record.id)}>×</button>
              </li>
            ))
          ) : (
            <li>No facts stored yet</li>
          )}
        </ul>
      </section>
    </aside>
  );
}
