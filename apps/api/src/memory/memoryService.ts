import fs from "fs";
import path from "path";

const memoryPath = path.join(__dirname, "memory.json");

type Conversation = {
  agent: string;
  userMessage: string;
  assistantReply: string;
  timestamp: string;
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
  conversations: Conversation[];
};

export function readMemory(): MemoryData {
  const raw = fs.readFileSync(memoryPath, "utf-8");
  return JSON.parse(raw);
}

export function saveMemory(data: MemoryData): void {
  fs.writeFileSync(memoryPath, JSON.stringify(data, null, 2));
}

export function addConversation(
  agent: string,
  userMessage: string,
  assistantReply: string
): void {
  const memory = readMemory();

  memory.conversations.push({
    agent,
    userMessage,
    assistantReply,
    timestamp: new Date().toISOString()
  });

  saveMemory(memory);
}

export function addFact(fact: string): void {
  const memory = readMemory();
  const cleanedFact = cleanRememberPhrase(fact);

  if (!memory.facts.includes(cleanedFact)) {
    memory.facts.push(cleanedFact);
  }

  updateStructuredMemory(memory, cleanedFact);

  saveMemory(memory);
}

function cleanRememberPhrase(input: string): string {
  return input
    .replace(/^remember that\s+/i, "")
    .replace(/^remember:\s*/i, "")
    .trim();
}

function updateStructuredMemory(memory: MemoryData, fact: string): void {
  const lowerFact = fact.toLowerCase();

  if (lowerFact.includes("favorite color is")) {
    memory.profile.favoriteColor = extractAfterPhrase(fact, "favorite color is");
  }

  if (lowerFact.includes("i live in")) {
    memory.profile.location = extractAfterPhrase(fact, "i live in");
  }

  if (lowerFact.includes("i am a") || lowerFact.includes("i'm a")) {
    memory.profile.occupation = fact;
  }

  if (lowerFact.includes("i prefer") || lowerFact.includes("my preference is")) {
    addUnique(memory.preferences, fact);
  }

  if (lowerFact.includes("project") || lowerFact.includes("app")) {
    addUnique(memory.projects, fact);
  }

  if (lowerFact.includes("goal") || lowerFact.includes("i want to")) {
    addUnique(memory.goals, fact);
  }
}

function extractAfterPhrase(input: string, phrase: string): string {
  const index = input.toLowerCase().indexOf(phrase.toLowerCase());

  if (index === -1) return input;

  return input.slice(index + phrase.length).trim().replace(/\.$/, "");
}

function addUnique(list: string[], value: string): void {
  if (!list.includes(value)) {
    list.push(value);
  }
}

export function getMemoryContext(): string {
  const memory = readMemory();

  return `
User Profile:
- Name: ${memory.profile.name}
- Favorite Color: ${memory.profile.favoriteColor || "Unknown"}
- Location: ${memory.profile.location || "Unknown"}
- Occupation: ${memory.profile.occupation || "Unknown"}

Preferences:
${formatList(memory.preferences)}

Projects:
${formatList(memory.projects)}

Goals:
${formatList(memory.goals)}

Facts:
${formatList(memory.facts)}

Recent Conversations:
${memory.conversations
  .slice(-5)
  .map((c) => `User: ${c.userMessage}\nAssistant: ${c.assistantReply}`)
  .join("\n\n")}
`;
}

function formatList(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None";
}