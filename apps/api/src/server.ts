import express from "express";
import cors from "cors";
import { routeAgent, AgentName } from "./router/agentRouter";
import { addConversation, addFact, readMemory } from "./memory/memoryService";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    status: "LOIS online",
    version: "0.1.0-alpha"
  });
});

app.get("/memory", (_req, res) => {
  const memory = readMemory();

  res.json({
    profile: memory.profile,
    preferences: memory.preferences,
    projects: memory.projects,
    goals: memory.goals,
    facts: memory.facts,
    conversations: memory.conversations.slice(-20)
  });
});

app.post("/chat", async (req, res) => {
  try {
    const { agent, message } = req.body as {
      agent?: AgentName;
      message?: string;
    };

    if (!message) {
      return res.status(400).json({
        error: "Message is required"
      });
    }

    const selectedAgent: AgentName = agent === "ignis" ? "ignis" : "lois";
    const reply = await routeAgent(selectedAgent, message);

    
    addConversation(selectedAgent, message, reply);

    
    if (
      message.toLowerCase().startsWith("remember that") ||
      message.toLowerCase().startsWith("remember:")
    ) {
      addFact(message);
    }

    res.json({
      agent: selectedAgent,
      reply
    });
  } catch (error) {
    console.error("Chat error:", error);

    res.status(500).json({
      error: "LOIS encountered an internal error"
    });
  }
});

const PORT = 3001;

app.listen(PORT, () => {
  console.log(`LOIS API running on port ${PORT}`);
});