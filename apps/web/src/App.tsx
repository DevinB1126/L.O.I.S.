import { useEffect, useState } from "react";
import "./App.css";

type Agent = "lois" | "ignis";

type HudView = "chat" | "memory" | "goals" | "calendar" | "voice";

type StoredConversation = {
  agent: Agent;
  userMessage: string;
  assistantReply: string;
  timestamp: string;
};

type Goal = {
  id: string;
  title: string;
  completed: boolean;
  createdAt: string;
};

type CalendarEvent = {
  id: string;
  title: string;
  dateText: string;
  timeText: string;
  createdAt: string;
};

type MemoryData = {
  profile: {
    name: string;
    favoriteColor: string;
    location: string;
    occupation: string;
  };

  preferences: string[];
  projects: string[];

  goals: Goal[];

  facts: string[];
  calendar: CalendarEvent[];
};

type ChatMessage = {
  role: "user" | "assistant";
  agent?: Agent;
  text: string;
};

function App() {
  const [agent, setAgent] = useState<Agent>("lois");
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [memory, setMemory] = useState<MemoryData | null>(null);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [systemTemp, setSystemTemp] = useState(41);
  const [cpuUsage, setCpuUsage] = useState(18);
const [ramUsage, setRamUsage] = useState(32);
const [activeView, setActiveView] = useState<HudView>("chat");
  const [voiceState, setVoiceState] = useState<
  "standby" | "listening" | "thinking" | "speaking"
>("standby");

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

useEffect(() => {
  window.speechSynthesis.getVoices();

  window.speechSynthesis.onvoiceschanged = () => {
    window.speechSynthesis.getVoices();
  };
}, []);

  async function loadMemory() {
    try {
      const response = await fetch("http://localhost:3001/memory");
      const data = await response.json();
      setMemory(data);
    } catch (error) {
      console.error("Failed to load memory:", error);
    }
  }

async function deleteMemoryFact(index: number) {
  try {
    await fetch(`http://localhost:3001/facts/${index}`, {
      method: "DELETE",
    });

    await loadMemory();
  } catch (error) {
    console.error("Failed to delete memory fact:", error);
  }
}

async function deleteCalendarEvent(eventId: string) {
  try {
    await fetch(`http://localhost:3001/calendar/${eventId}`, {
      method: "DELETE",
    });

    await loadMemory();
  } catch (error) {
    console.error("Failed to delete calendar event:", error);
  }
}

async function completeGoal(goalId: string) {
  try {
    await fetch(`http://localhost:3001/goals/${goalId}/complete`, {
      method: "PATCH",
    });

    await loadMemory();
  } catch (error) {
    console.error("Failed to complete goal:", error);
  }
}

async function deleteGoal(goalId: string) {
  try {
    await fetch(`http://localhost:3001/goals/${goalId}`, {
      method: "DELETE",
    });

    await loadMemory();
  } catch (error) {
    console.error("Failed to delete goal:", error);
  }
}

  async function loadConversationHistory() {
    try {
      const response = await fetch("http://localhost:3001/memory");
      const data = await response.json();

      const loadedMessages: ChatMessage[] = data.conversations.flatMap(
        (conversation: StoredConversation) => [
          { role: "user", text: conversation.userMessage },
          {
            role: "assistant",
            agent: conversation.agent,
            text: conversation.assistantReply,
          },
        ]
      );

      setMessages(loadedMessages);
    } catch (error) {
      console.error("Failed to load conversation history:", error);
    }
  }

  useEffect(() => {
    loadConversationHistory();
    loadMemory();
  }, []);

  async function sendMessage(overrideMessage?: string) {
    const currentMessage = overrideMessage ?? message;

if (!currentMessage.trim()) return;

    setMessages((prev) => [...prev, { role: "user", text: currentMessage }]);
    setMessage("");
    setIsLoading(true);
    setVoiceState("thinking");

    try {
      const response = await fetch("http://localhost:3001/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent, message: currentMessage }),
      });

      const data = await response.json();

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          agent: data.agent,
          text: data.reply,
        },
      ]);

      await loadMemory();
      speakText(data.reply);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          agent,
          text: "Connection to LOIS core failed. Confirm the backend is running on port 3001.",
        },
      ]);
    } finally {
      setIsLoading(false);
if (voiceState !== "speaking") {
  setVoiceState("standby");
}
    }
  }

function stopSpeaking() {
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }

  setVoiceState("standby");
}

async function clearVisibleChat() {
  try {
    await fetch("http://localhost:3001/conversations", {
      method: "DELETE",
    });

    setMessages([]);
  } catch (error) {
    console.error("Failed to clear conversation history:", error);
  }
}

function speakText(text: string) {
  if (!("speechSynthesis" in window)) {
    setVoiceState("standby");
    return;
  }

  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);

  const voices = window.speechSynthesis.getVoices();

let selectedVoice: SpeechSynthesisVoice | undefined;

if (agent === "lois") {
  selectedVoice =
    voices.find((v) => v.name === "Google UK English Female") ||
    voices.find((v) => v.name === "Martha") ||
    voices.find((v) => v.name === "Flo (English (United Kingdom))") ||
    voices.find((v) => v.name === "Samantha");
} else {
  selectedVoice =
    voices.find((v) => v.name === "Daniel (English (United Kingdom))") ||
    voices.find((v) => v.name === "Google UK English Male") ||
    voices.find((v) => v.name === "Arthur") ||
    voices.find((v) => v.name === "Aaron");
}

if (selectedVoice) {
  utterance.voice = selectedVoice;
}

utterance.lang = agent === "lois" ? "en-GB" : "en-GB";
utterance.rate = agent === "lois" ? 1.10 : 1.00;
utterance.pitch = agent === "lois" ? 1.22 : 0.82;
  setVoiceState("speaking");

  utterance.onend = () => {
    setVoiceState("standby");
  };

  utterance.onerror = () => {
    setVoiceState("standby");
  };

  window.speechSynthesis.speak(utterance);
}

function startVoiceRecognition() {
  const SpeechRecognition =
    (window as any).SpeechRecognition ||
    (window as any).webkitSpeechRecognition;

  if (!SpeechRecognition) {
    alert("Speech Recognition is not supported in this browser.");
    return;
  }

  const recognition = new SpeechRecognition();

  recognition.lang = "en-US";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  setVoiceState("listening");

  recognition.start();

  recognition.onresult = (event: any) => {
    const rawTranscript = event.results[0][0].transcript;

const transcript = rawTranscript
  .replace(/\blouis\b/gi, "LOIS")
  .replace(/\blewis\b/gi, "LOIS")
  .replace(/\blois\b/gi, "LOIS")
  .replace(/\bignis\b/gi, "IGNIS");

setMessage(transcript);
sendMessage(transcript);
  };

  recognition.onerror = () => {
    setVoiceState("standby");
  };

  recognition.onend = () => {
    setVoiceState("standby");
  };
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
  hour < 12
    ? "Good morning, Devin."
    : hour < 18
    ? "Good afternoon, Devin."
    : "Good evening, Devin.";

const voiceLabel =
  voiceState === "standby"
    ? "VOICE MODULE STANDBY"
    : voiceState === "listening"
    ? "LISTENING..."
    : voiceState === "thinking"
    ? "PROCESSING..."
    : "SPEAKING...";

  return (
    <main className={`hud ${agent} state-${voiceState}`}>
      <div className="deep-space" />
      <div className="background-grid" />
      <div className="data-map" />
      <div className="network-field" />
      <div className="planet-glow" />
      <div className="mountain-grid" />
      <div className="side-orbital" />
      <div className="stars" />
      <div className="data-stream" />
      <div className="world-map" />
      <div className="right-holo-column" />
      <div className="particle-field">
  {Array.from({ length: 36 }).map((_, index) => (
    <span key={index} />
  ))}
</div>
<div className="holo-world-layer">
  <div className="world-node node-a" />
  <div className="world-node node-b" />
  <div className="world-node node-c" />
  <div className="world-node node-d" />
</div>
      <div className="scanlines" />

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
    onClick={() => setActiveView("chat")}
  >
    ▣ Chat
  </button>

  <button
    className={activeView === "memory" ? "active" : ""}
    onClick={() => setActiveView("memory")}
  >
    ◌ Memory
  </button>

  <button
    className={activeView === "goals" ? "active" : ""}
    onClick={() => setActiveView("goals")}
  >
    ◎ Goals
  </button>

  <button
    className={activeView === "calendar" ? "active" : ""}
    onClick={() => setActiveView("calendar")}
  >
    □ Calendar
  </button>

  <button
    className={activeView === "voice" ? "active" : ""}
    onClick={() => setActiveView("voice")}
  >
    ◍ Voice
  </button>
</nav>

        <section className="local-card">
          <h2>LOCAL SYSTEM</h2>
          <strong>ONLINE</strong>
         <p>Time: {timeDisplay}</p>
          <p>Date: {dateDisplay}</p>
         <p>Temperature: {systemTemp}°C</p>
          <div className="mini-eq" />
        </section>
      </aside>

      <section className="center-stage">
        <header className="top-status">
        <div className="view-chip">
  VIEW: {activeView.toUpperCase()}
</div>
  <span>CORE STATUS: ACTIVE</span>

  <div className="top-actions">
    <button onClick={clearVisibleChat}>CLEAR CHAT</button>

    <select value={agent} onChange={(e) => setAgent(e.target.value as Agent)}>
      <option value="lois">LOIS</option>
      <option value="ignis">IGNIS</option>
    </select>
  </div>
</header>

        <section className="orb-zone">



    <div className="star-field" />

    <div className="orbit orbit-1" />
    <div className="orbit orbit-2" />
    <div className="orbit orbit-3" />
    <div className="orbit orbit-4" />

    <div className="orb-status-chip left-chip">
  <strong>CORE LINK</strong>
  <span>Latency: 22 ms</span>
</div>

<div className="orb-status-chip right-chip">
  <strong>VOICE</strong>
  <span>{voiceState.toUpperCase()}</span>
</div>

    <div className="satellite satellite-1" />
    <div className="satellite satellite-2" />
    <div className="satellite satellite-3" />

    <div className="crosshair horizontal" />
    <div className="crosshair vertical" />

    <div className="orb-ring ring-1" />
    <div className="orb-ring ring-2" />
    <div className="orb-ring ring-3" />

    <div className="core-halo halo-1" />
<div className="core-halo halo-2" />
<div className="core-halo halo-3" />

<div className="core-segment-ring">
  {Array.from({ length: 32 }).map((_, index) => (
    <span key={index} />
  ))}
</div>

    <div className={`orb-core ${voiceState}`}>
        <span>{currentAgentLabel}</span>
    </div>

</section>

        <section className="conversation-panel">
  {activeView === "memory" ? (
    
    <div className="focus-view">
      <h2>Memory Database</h2>

      <div className="focus-grid">
        <div>
          <h3>Profile</h3>
          <p>Name: {memory?.profile.name || "Unknown"}</p>
          <p>Location: {memory?.profile.location || "Unknown"}</p>
          <p>Favorite Color: {memory?.profile.favoriteColor || "Unknown"}</p>
          <p>Occupation: {memory?.profile.occupation || "Unknown"}</p>
        </div>

        <div>
          <h3>Stored Facts</h3>
          <ul>
            {memory?.facts && memory.facts.length > 0 ? (
              memory.facts.slice(-6).map((fact, index) => (
                <li key={index}>{fact}</li>
              ))
            ) : (
              <li>No stored facts</li>
            )}
          </ul>
        </div>
      </div>
    </div>
  )
   : activeView === "goals" ? (
  <div className="focus-view">
    <h2>Goals Matrix</h2>

    <ul className="focus-list">
      {memory?.goals && memory.goals.length > 0 ? (
        memory.goals.map((goal) => (
          <li key={goal.id}>
            <span>{goal.completed ? "✓" : "○"}</span>
            <div>
              <strong>{goal.title}</strong>
              <p>{goal.completed ? "Completed" : "Active"}</p>
            </div>
          </li>
        ))
      ) : (
        <li>No goals stored</li>
      )}
    </ul>
  </div>
  )
   : activeView === "calendar" ? (
  <div className="focus-view">
    <h2>Calendar Matrix</h2>

    <ul className="focus-list">
      {memory?.calendar && memory.calendar.length > 0 ? (
        memory.calendar.map((event) => (
          <li key={event.id}>
            <span>□</span>
            <div>
              <strong>{event.title}</strong>
              <p>{event.dateText} • {event.timeText}</p>
            </div>
          </li>
        ))
      ) : (
        <li>No calendar events stored</li>
      )}
    </ul>
  </div>
  )
   : activeView === "voice" ? (
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
  )
  : (
    <>
      {messages.length === 0 ? (
        <div className="welcome">
          <h2>{greeting}</h2>
          <p>{currentAgentLabel} core is online. How may I assist?</p>
        </div>
      ) : (
        messages.slice(-6).map((msg, index) => (
          <div key={index} className={`hud-message ${msg.role}`}>
            <strong>
              {msg.role === "user"
                ? "DEVIN"
                : msg.agent === "ignis"
                ? "IGNIS"
                : "LOIS"}
            </strong>
            <p>{msg.text}</p>
          </div>
        ))
      )}

      {isLoading && (
        <div className="hud-message assistant">
          <strong>{currentAgentLabel}</strong>
          <p>Processing request...</p>
        </div>
      )}
    </>
  )}
</section>

        <section className="voice-strip">
  <div className={`wave ${voiceState}`}>
    {Array.from({ length: 48 }).map((_, index) => (
      <span key={index} />
    ))}
  </div>

  <p>
    {voiceState === "standby"
      ? "VOICE MODULE STANDBY"
      : voiceState === "listening"
      ? "LISTENING..."
      : voiceState === "thinking"
      ? "PROCESSING..."
      : "SPEAKING..."}
  </p>
</section>

        <section className="command-row">
          <button className="keyboard-button">⌨</button>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={`Transmit command to ${currentAgentLabel}...`}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
              }
            }}
          />
         <button className="send-button" onClick={() => sendMessage()} disabled={isLoading}>
  SEND
</button>
          <button
  className={`mic-button ${voiceState}`}
  onClick={voiceState === "speaking" ? stopSpeaking : startVoiceRecognition}
>
  {voiceState === "speaking" ? "■" : "🎙"}
</button>
        </section>
        <div className="telemetry-dock">
  <div className="telemetry-pill">
    <span>CPU</span>
    <strong>{cpuUsage}%</strong>
  </div>

  <div className="telemetry-pill">
    <span>RAM</span>
    <strong>{ramUsage}%</strong>
  </div>

  <div className="telemetry-pill wide">
    <span>NET</span>
    <strong>1.2 KB/s</strong>
  </div>
</div>
      </section>

      <aside className="right-panels">
        <section className="hud-card">
          <h2>SYSTEM STATUS</h2>
          <p><span /> {currentAgentLabel} Core: Online</p>
          <p><span /> Memory: Active</p>
          <p><span /> Local Model: Connected</p>
          <p>Voice: {voiceState.toUpperCase()}</p>
        </section>

        <section className="hud-card icon-card">
          <h2>MEMORY SNAPSHOT <b>♙</b></h2>
          <p>Name: {memory?.profile.name || "Unknown"}</p>
          <p>Location: {memory?.profile.location || "Unknown"}</p>
          <p>Favorite Color: {memory?.profile.favoriteColor || "Unknown"}</p>
          <p>Occupation: {memory?.profile.occupation || "Unknown"}</p>
        </section>

        <section className="hud-card icon-card">
          <h2>CURRENT GOALS <b>◎</b></h2>
          <ul>
            {memory?.goals && memory.goals.length > 0 ? (
  memory.goals
    .filter((goal) => !goal.completed)
    .slice(0, 4)
    .map((goal) => (
      <li key={goal.id} className="goal-item">
        <span>{goal.title || "Untitled goal"}</span>

        <div className="goal-actions">
          <button onClick={() => completeGoal(goal.id)}>✓</button>
          <button onClick={() => deleteGoal(goal.id)}>×</button>
        </div>
      </li>
    ))
) : (
  <li>No goals stored yet</li>
)}
          </ul>
        </section>

        <section className="hud-card schedule-card icon-card">
  <h2>SCHEDULE <b>□</b></h2>

  {memory?.calendar && memory.calendar.length > 0 ? (
    <ul className="schedule-list">
      {memory.calendar.slice(-4).map((event) => (
        <li key={event.id} className="schedule-item">
          <div>
            <strong>{event.title}</strong>
            <p>{event.dateText} • {event.timeText}</p>
          </div>

          <button onClick={() => deleteCalendarEvent(event.id)}>×</button>
        </li>
      ))}
    </ul>
  ) : (
    <p>No events scheduled</p>
  )}
</section>

<section className="hud-card icon-card">
  <h2>RECENT MEMORY <b>◌</b></h2>

  <ul className="memory-fact-list">
    {memory?.facts && memory.facts.length > 0 ? (
      memory.facts.slice(-4).map((fact, index) => {
        const originalIndex = memory.facts.length - 4 + index;

        return (
          <li key={originalIndex} className="memory-fact-item">
            <span>{fact}</span>
            <button onClick={() => deleteMemoryFact(originalIndex)}>×</button>
          </li>
        );
      })
    ) : (
      <li>No facts stored yet</li>
    )}
  </ul>
</section>
      </aside>



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