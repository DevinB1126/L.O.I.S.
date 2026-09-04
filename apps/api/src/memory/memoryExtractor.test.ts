// Unit tests for Memory v2B's explicit-command detection, sensitive-content
// guard, and the extraction-response parsing/validation path (exercised
// directly against simulated model output — no live Ollama call needed for
// these). Run with: npm run test --workspace=api

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isExplicitMemoryCommand,
  isExplicitGoalCommand,
  splitExplicitMemoryCommands,
  containsSensitiveContent,
  detectProfileUpdateIntent,
  __testables,
} from "./memoryExtractor";

const { parseExtractionResponse } = __testables;

test("isExplicitMemoryCommand recognizes command phrasing", () => {
  assert.equal(isExplicitMemoryCommand("Remember that I prefer dark mode."), true);
  assert.equal(isExplicitMemoryCommand("remember: I use TypeScript"), true);
  assert.equal(isExplicitMemoryCommand("Save this: I work at a startup."), true);
  assert.equal(isExplicitMemoryCommand("Add this to memory: I like React."), true);
  assert.equal(isExplicitMemoryCommand("Add to my facts I like pizza"), true);
});

test("isExplicitMemoryCommand does NOT match general statements (they go through extraction instead)", () => {
  assert.equal(isExplicitMemoryCommand("I prefer dark mode."), false);
  assert.equal(isExplicitMemoryCommand("I'm building LOIS with Ollama."), false);
  assert.equal(isExplicitMemoryCommand("Should I use React?"), false);
});

test("isExplicitGoalCommand recognizes goal-creation command phrasing", () => {
  assert.equal(isExplicitGoalCommand("Add goal: finish LOIS v1."), true);
  assert.equal(isExplicitGoalCommand("add a goal: ship the beta"), true);
  assert.equal(isExplicitGoalCommand("Create goal: learn Rust"), true);
  assert.equal(isExplicitGoalCommand("New goal: run a marathon"), true);
  assert.equal(isExplicitGoalCommand("Set goal: read more books"), true);
});

test("isExplicitGoalCommand does NOT match general statements, including softer goal-ish phrasing", () => {
  assert.equal(isExplicitGoalCommand("I want to learn Rust."), false);
  assert.equal(isExplicitGoalCommand("My goal is to ship the beta."), false);
  assert.equal(isExplicitGoalCommand("Remember that I want to finish LOIS v1."), false);
  assert.equal(isExplicitGoalCommand("What are my goals?"), false);
});

test("detectProfileUpdateIntent reproduces the exact reported bug: a lead-in sentence before the canonical statement", () => {
  const result = detectProfileUpdateIntent("I want to change my favorite color. My favorite color is red");
  assert.deepEqual(result, { field: "favoriteColor", value: "red" });
});

test("detectProfileUpdateIntent reproduces the SECOND reported bug: imperative 'from OLD to NEW' phrasing with trailing filler", () => {
  const result = detectProfileUpdateIntent("lois update my favorite color from black to red please");
  assert.deepEqual(result, { field: "favoriteColor", value: "red" });
});

test("detectProfileUpdateIntent handles 'change/update/set my <field> to X' for every field, with and without a stated old value", () => {
  assert.deepEqual(detectProfileUpdateIntent("update my favorite color to red"), {
    field: "favoriteColor",
    value: "red",
  });
  assert.deepEqual(detectProfileUpdateIntent("change my favorite color from black to red"), {
    field: "favoriteColor",
    value: "red",
  });
  assert.deepEqual(detectProfileUpdateIntent("set my location to Austin please"), {
    field: "location",
    value: "Austin",
  });
  assert.deepEqual(detectProfileUpdateIntent("update my occupation from unemployed to software engineer"), {
    field: "occupation",
    value: "software engineer",
  });
  assert.deepEqual(detectProfileUpdateIntent("change my name to Devin"), { field: "name", value: "Devin" });
});

test("detectProfileUpdateIntent strips trailing politeness/filler words from the captured value", () => {
  assert.deepEqual(detectProfileUpdateIntent("update my favorite color to red please"), {
    field: "favoriteColor",
    value: "red",
  });
  assert.deepEqual(detectProfileUpdateIntent("set my occupation to software engineer thanks"), {
    field: "occupation",
    value: "software engineer",
  });
});

test("detectProfileUpdateIntent recognizes canonical profile statements for every supported field", () => {
  assert.deepEqual(detectProfileUpdateIntent("My favorite color is red."), { field: "favoriteColor", value: "red" });
  assert.deepEqual(detectProfileUpdateIntent("Change my favorite color to red."), { field: "favoriteColor", value: "red" });
  assert.deepEqual(detectProfileUpdateIntent("I live in Austin now."), { field: "location", value: "Austin" });
  assert.deepEqual(detectProfileUpdateIntent("My occupation is software engineer."), {
    field: "occupation",
    value: "software engineer",
  });
  assert.deepEqual(detectProfileUpdateIntent("My name is Devin."), { field: "name", value: "Devin" });
});

test("detectProfileUpdateIntent: sequential color changes each extract the latest stated value", () => {
  assert.deepEqual(detectProfileUpdateIntent("My favorite color is blue."), { field: "favoriteColor", value: "blue" });
  assert.deepEqual(detectProfileUpdateIntent("Actually my favorite color is red."), {
    field: "favoriteColor",
    value: "red",
  });
});

test("detectProfileUpdateIntent does NOT match generic memory statements (Objective: profile vs generic memory)", () => {
  assert.equal(detectProfileUpdateIntent("I prefer concise technical explanations."), null);
  assert.equal(detectProfileUpdateIntent("I like video games."), null);
  assert.equal(detectProfileUpdateIntent("I don't like Tailwind."), null);
});

test("detectProfileUpdateIntent returns null for messages with no canonical profile statement", () => {
  assert.equal(detectProfileUpdateIntent("What's the weather like?"), null);
  assert.equal(detectProfileUpdateIntent("Should I use React for this?"), null);
  assert.equal(detectProfileUpdateIntent(""), null);
});

test("splitExplicitMemoryCommands: a single command still yields one clean statement", () => {
  assert.deepEqual(splitExplicitMemoryCommands("Remember that I prefer dark mode."), ["I prefer dark mode."]);
  assert.deepEqual(splitExplicitMemoryCommands("Save this: I work at a startup."), ["I work at a startup."]);
});

test("splitExplicitMemoryCommands: two chained commands split into two atomic statements", () => {
  const result = splitExplicitMemoryCommands("Remember that I prefer React. Remember that I primarily use TypeScript.");
  assert.deepEqual(result, ["I prefer React.", "I primarily use TypeScript."]);
});

test("splitExplicitMemoryCommands: reproduces the exact reported bug — four newline-joined commands", () => {
  const message =
    "Remember that I prefer concise technical explanations.\n" +
    "Remember that I prefer dark interfaces.\n" +
    "Remember that I am building LOIS as a local AI assistant.\n" +
    "Remember that I like video games";

  const result = splitExplicitMemoryCommands(message);

  assert.deepEqual(result, [
    "I prefer concise technical explanations.",
    "I prefer dark interfaces.",
    "I am building LOIS as a local AI assistant.",
    "I like video games",
  ]);
});

test("splitExplicitMemoryCommands: mixed trigger phrasing does not produce overlapping/duplicate segments", () => {
  const message = "Please remember that I like tea. Remember that I dislike coffee.";
  const result = splitExplicitMemoryCommands(message);
  assert.deepEqual(result, ["I like tea.", "I dislike coffee."]);
});

test("splitExplicitMemoryCommands: a message with no recognizable trigger returns the trimmed whole message", () => {
  assert.deepEqual(splitExplicitMemoryCommands("  just some text  "), ["just some text"]);
});

test("splitExplicitMemoryCommands: empty/whitespace-only input returns no segments", () => {
  assert.deepEqual(splitExplicitMemoryCommands("   "), []);
  assert.deepEqual(splitExplicitMemoryCommands(""), []);
});

test("containsSensitiveContent flags obvious secrets", () => {
  assert.equal(containsSensitiveContent("my password is hunter2"), true);
  assert.equal(containsSensitiveContent("here is my API key: sk-abc123"), true);
  assert.equal(containsSensitiveContent("my SSN is 123-45-6789"), true);
  assert.equal(containsSensitiveContent("my card number is 4111 1111 1111 1111"), true);
});

test("containsSensitiveContent does not flag ordinary content", () => {
  assert.equal(containsSensitiveContent("I prefer dark mode."), false);
  assert.equal(containsSensitiveContent("I'm building LOIS with Ollama."), false);
});

test("parseExtractionResponse accepts a well-formed shouldRemember:true response", () => {
  const raw = JSON.stringify({
    shouldRemember: true,
    memories: [{ content: "I prefer React for frontend work.", category: "technical", importance: 3, confidence: 0.9 }],
  });

  const candidates = parseExtractionResponse(raw);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].content, "I prefer React for frontend work.");
  assert.equal(candidates[0].category, "technical");
  assert.equal(candidates[0].importance, 3);
  assert.equal(candidates[0].confidence, 0.9);
});

test("parseExtractionResponse returns [] for shouldRemember:false", () => {
  const raw = JSON.stringify({ shouldRemember: false, memories: [] });
  assert.deepEqual(parseExtractionResponse(raw), []);
});

test("parseExtractionResponse tolerates markdown code-fence wrapping", () => {
  const raw = "```json\n" + JSON.stringify({
    shouldRemember: true,
    memories: [{ content: "I work in TypeScript.", category: "technical", importance: 3, confidence: 0.85 }],
  }) + "\n```";

  const candidates = parseExtractionResponse(raw);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].content, "I work in TypeScript.");
});

test("parseExtractionResponse rejects malformed JSON instead of throwing", () => {
  assert.doesNotThrow(() => {
    const candidates = parseExtractionResponse("not json at all");
    assert.deepEqual(candidates, []);
  });
});

test("parseExtractionResponse drops individual candidates with invalid fields", () => {
  const raw = JSON.stringify({
    shouldRemember: true,
    memories: [
      { content: "I prefer React.", category: "technical", importance: 3, confidence: 0.9 }, // valid
      { content: "", category: "technical", importance: 3, confidence: 0.9 }, // empty content
      { content: "Bad category.", category: "not-a-real-category", importance: 3, confidence: 0.9 }, // bad category
      { content: "Bad importance.", category: "other", importance: 9, confidence: 0.9 }, // out of range
      { content: "Bad confidence.", category: "other", importance: 3, confidence: 1.5 }, // out of range
      "not even an object",
    ],
  });

  const candidates = parseExtractionResponse(raw);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].content, "I prefer React.");
});

test("parseExtractionResponse handles multiple valid candidates in one message (Objective 6)", () => {
  const raw = JSON.stringify({
    shouldRemember: true,
    memories: [
      { content: "I primarily work in TypeScript.", category: "technical", importance: 3, confidence: 0.88 },
      { content: "I prefer React.", category: "preference", importance: 3, confidence: 0.85 },
      { content: "LOIS runs locally using Ollama.", category: "project", importance: 4, confidence: 0.92 },
    ],
  });

  const candidates = parseExtractionResponse(raw);
  assert.equal(candidates.length, 3);
});

test("parseExtractionResponse preserves negation exactly (Objective 17)", () => {
  const raw = JSON.stringify({
    shouldRemember: true,
    memories: [{ content: "I do not like Tailwind.", category: "preference", importance: 3, confidence: 0.87 }],
  });

  const candidates = parseExtractionResponse(raw);
  assert.equal(candidates[0].content, "I do not like Tailwind.");
  assert.ok(!/^I like Tailwind/i.test(candidates[0].content));
});
