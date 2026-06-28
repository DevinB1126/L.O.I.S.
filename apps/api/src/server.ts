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
  deleteGoal,
  deleteCalendarEvent,
  deleteFact
} from "./memory/memoryService";
import { streamOllamaResponse } from "./providers/ollamaProvider";
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

app.delete("/calendar/:id", (req, res) => {
  const success = deleteCalendarEvent(req.params.id);

  if (!success) {
    return res.status(404).json({
      error: "Calendar event not found"
    });
  }

  res.json({
    success: true
  });
});

app.delete("/facts/:index", (req, res) => {
  const index = Number(req.params.index);
  const success = deleteFact(index);

  if (!success) {
    return res.status(404).json({
      error: "Fact not found"
    });
  }

  res.json({
    success: true
  });
});

app.post("/chat/stream", async (req, res) => {
  try {
    const { agent, message } = req.body as {
      agent?: AgentName;
      message?: string;
    };

    if (!message) {
      return res.status(400).json({
        error: "Message is required",
      });
    }

    const selectedAgent: AgentName = agent === "ignis" ? "ignis" : "lois";

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Transfer-Encoding", "chunked");

    let fullReply = "";

    fullReply = await streamOllamaResponse(message, (chunk) => {
      res.write(chunk);
    });

    addConversation(selectedAgent, message, fullReply);

    res.end();
  } catch (error) {
    console.error("Stream chat error:", error);
    res.status(500).end("LOIS encountered a streaming error");
  }
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

const shouldSaveCalendarEvent =
  lowerMessage.startsWith("add calendar event") ||
  lowerMessage.startsWith("add event") ||
  lowerMessage.startsWith("schedule:") ||
  lowerMessage.startsWith("schedule ") ||
  lowerMessage.includes("add to my calendar") ||
  lowerMessage.includes("put on my calendar") ||
  lowerMessage.includes("add a birthday") ||
  lowerMessage.includes("birthday on") ||
  lowerMessage.includes("birthday is");

if (shouldSaveCalendarEvent) {
  addCalendarEvent(message);
}

const shouldSaveFact =
  lowerMessage.startsWith("remember that") ||
  lowerMessage.startsWith("remember:") ||
  lowerMessage.startsWith("add to my facts") ||
  lowerMessage.startsWith("add fact") ||
  lowerMessage.includes("my favorite") ||
  lowerMessage.includes("i prefer") ||
  lowerMessage.includes("i live in") ||
  lowerMessage.includes("my birthday") ||
  lowerMessage.includes("my favorite superhero") ||
  lowerMessage.includes("my goal is") ||
  lowerMessage.includes("one of my goals is") ||
  lowerMessage.includes("i want to");

if (shouldSaveFact) {
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