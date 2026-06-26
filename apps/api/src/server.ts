import express from "express";
import cors from "cors";
import { routeAgent, AgentName } from "./router/agentRouter";
import {
  addConversation,
  addFact,
  readMemory,
  addCalendarEvent,
  clearConversations,
  completeGoal,
  deleteGoal
} from "./memory/memoryService";
const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    status: "LOIS online",
    version: "0.1.0-alpha"
  });
});

app.patch("/goals/:id/complete", (req, res) => {
  const success = completeGoal(req.params.id);

  if (!success) {
    return res.status(404).json({
      error: "Goal not found"
    });
  }

  res.json({
    success: true
  });
});

app.delete("/goals/:id", (req, res) => {
  const success = deleteGoal(req.params.id);

  if (!success) {
    return res.status(404).json({
      error: "Goal not found"
    });
  }

  res.json({
    success: true
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
    calendar: memory.calendar,
    conversations: memory.conversations.slice(-20)
  });
});

app.delete("/conversations", (_req, res) => {
  clearConversations();

  res.json({
    success: true,
    message: "Conversation history cleared"
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

    
    const lowerMessage = message.toLowerCase();

if (
  lowerMessage.startsWith("add calendar event") ||
  lowerMessage.startsWith("add event") ||
  lowerMessage.startsWith("schedule:")
) {
  addCalendarEvent(message);
}

if (
  lowerMessage.startsWith("remember that") ||
  lowerMessage.startsWith("remember:") ||
  lowerMessage.startsWith("add goal") ||
  lowerMessage.includes("my goal is") ||
  lowerMessage.includes("one of my goals is") ||
  lowerMessage.includes("i want to")
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