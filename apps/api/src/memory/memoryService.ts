import fs from "fs";
import path from "path";

const memoryPath = path.join(__dirname, "memory.json");

type Conversation = {
  agent: string;
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
  conversations: Conversation[];
};
export function addCalendarEvent(input: string): void {
  const memory = readMemory();

  const cleanedInput = cleanCalendarPhrase(input);

  const event: CalendarEvent = {
    id: crypto.randomUUID(),
    title: cleanedInput,
    dateText: extractDateText(cleanedInput),
    timeText: extractTimeText(cleanedInput),
    createdAt: new Date().toISOString()
  };

  memory.calendar.push(event);
  saveMemory(memory);
}

export function clearConversations(): void {
  const memory = readMemory();
  memory.conversations = [];
  saveMemory(memory);
}

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

function cleanGoalPhrase(input: string): string {
  return input
    .replace(/^add goal:?\s*/i, "")
    .replace(/^my goal is\s*/i, "")
    .replace(/^one of my goals is\s*/i, "")
    .replace(/^i want to\s*/i, "")
    .replace(/^my goal is to\s*/i, "")
    .replace(/\.$/, "")
    .trim();
}

function cleanCalendarPhrase(input: string): string {
  return input
    .replace(/^add calendar event:?\s*/i, "")
    .replace(/^add event:?\s*/i, "")
    .replace(/^schedule:?\s*/i, "")
    .trim();
}

function extractDateText(input: string): string {
  const lower = input.toLowerCase();

  if (lower.includes("today")) return "today";
  if (lower.includes("tomorrow")) return "tomorrow";
  if (lower.includes("monday")) return "monday";
  if (lower.includes("tuesday")) return "tuesday";
  if (lower.includes("wednesday")) return "wednesday";
  if (lower.includes("thursday")) return "thursday";
  if (lower.includes("friday")) return "friday";
  if (lower.includes("saturday")) return "saturday";
  if (lower.includes("sunday")) return "sunday";

  return "unscheduled";
}

function extractTimeText(input: string): string {
  const timeMatch = input.match(/\b\d{1,2}(:\d{2})?\s?(am|pm|AM|PM)\b/);

  return timeMatch ? timeMatch[0] : "time not set";
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

  if (
  lowerFact.includes("goal is") ||
  lowerFact.includes("my goal is") ||
  lowerFact.includes("one of my goals is") ||
  lowerFact.includes("i want to") ||
  lowerFact.startsWith("add goal")
) {
  const cleanedGoal = cleanGoalPhrase(fact);
  addUnique(memory.goals, cleanedGoal);
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

Calendar:
${memory.calendar.length > 0
  ? memory.calendar
      .slice(-5)
      .map((event) => `- ${event.title} (${event.dateText}, ${event.timeText})`)
      .join("\n")
  : "- None"}

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