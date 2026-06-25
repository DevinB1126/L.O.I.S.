import { useEffect, useState } from "react";
import "./App.css";

type Agent = "lois" | "ignis";

type StoredConversation = {
  agent: Agent;
  userMessage: string;
  assistantReply: string;
  timestamp: string;
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
  goals: string[];
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
  const [voiceState, setVoiceState] = useState<
  "standby" | "listening" | "thinking" | "speaking"
>("standby");
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

  return (
    <main className={`hud ${agent}`}>
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
          <button className="active">▣ Chat</button>
          <button>◌ Memory</button>
          <button>◎ Goals</button>
          <button>□ Calendar</button>
          <button>◍ Voice</button>
        </nav>

        <section className="local-card">
          <h2>LOCAL SYSTEM</h2>
          <strong>ONLINE</strong>
          <p>Uptime: 02:14:37</p>
          <p>Power: 100%</p>
          <p>Temperature: 41°C</p>
          <div className="mini-eq" />
        </section>
      </aside>

      <section className="center-stage">
        <header className="top-status">
          <span>CORE STATUS: ACTIVE</span>
          <select value={agent} onChange={(e) => setAgent(e.target.value as Agent)}>
            <option value="lois">LOIS</option>
            <option value="ignis">IGNIS</option>
          </select>
        </header>

        <section className="orb-zone">
          <div className="crosshair horizontal" />
          <div className="crosshair vertical" />
          <div className="orb-ring ring-1" />
          <div className="orb-ring ring-2" />
          <div className="orb-ring ring-3" />
          <div className={`orb-core ${voiceState}`}>
            <span>{currentAgentLabel}</span>
          </div>
        </section>

        <section className="conversation-panel">
          {messages.length === 0 ? (
            <div className="welcome">
              <h2>Good evening, Devin.</h2>
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
        </section>

        <section className="voice-strip">
  <div className="wave">
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
  onClick={startVoiceRecognition}
>
  🎙
</button>
        </section>
      </section>

      <aside className="right-panels">
        <section className="hud-card">
          <h2>SYSTEM STATUS</h2>
          <p><span /> {currentAgentLabel} Core: Online</p>
          <p><span /> Memory: Active</p>
          <p><span /> Local Model: Connected</p>
          <p><span /> Voice: Standby</p>
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
              memory.goals.slice(0, 4).map((goal, index) => <li key={index}>{goal}</li>)
            ) : (
              <li>No goals stored yet</li>
            )}
          </ul>
        </section>

        <section className="hud-card icon-card">
          <h2>RECENT MEMORY <b>◌</b></h2>
          <ul>
            {memory?.facts && memory.facts.length > 0 ? (
              memory.facts.slice(-4).map((fact, index) => <li key={index}>{fact}</li>)
            ) : (
              <li>No facts stored yet</li>
            )}
          </ul>
        </section>

        <section className="hud-card schedule-card icon-card">
  <h2>SCHEDULE <b>□</b></h2>

  {memory?.calendar && memory.calendar.length > 0 ? (
    <ul>
      {memory.calendar.slice(-4).map((event) => (
        <li key={event.id}>
          {event.title} — {event.dateText}, {event.timeText}
        </li>
      ))}
    </ul>
  ) : (
    <p>No events scheduled</p>
  )}
</section>
      </aside>

      <aside className="mini-system-column">
        <section className="time-widget">
          <strong>11:47 PM</strong>
          <p>May 23, 2025</p>
        </section>

        <section className="meter-card">
          <div className="circle-meter">
            <span>CPU</span>
            <strong>18%</strong>
          </div>
        </section>

        <section className="meter-card">
          <div className="circle-meter ram">
            <span>RAM</span>
            <strong>32%</strong>
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