// Unit tests for the deterministic action extractor. Run with:
// npm run test --workspace=api

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAssistantAction } from "./actionExtractor";

const NOW = new Date("2026-01-15T12:00:00Z"); // fixed "today" for deterministic date math

test("EXACT BIRTHDAY CASE — 'Can you add March 20 every year as my birthday?' extracts a yearly recurring calendar.create", () => {
  const action = extractAssistantAction("Can you add March 20 every year as my birthday?", {
    now: NOW,
    profileName: "Devin",
  });

  assert.ok(action, "expected an action to be extracted");
  assert.equal(action?.type, "calendar.create");
  if (action?.type !== "calendar.create") return;

  assert.equal(action.payload.title, "Devin's Birthday");
  assert.equal(action.payload.date, "2026-03-20");
  assert.deepEqual(action.payload.recurrence, { frequency: "yearly", interval: 1 });
});

test("calendar.create falls back to a generic title when no profile name is known", () => {
  const action = extractAssistantAction("Add March 20 every year as my birthday.", { now: NOW });
  assert.equal(action?.type, "calendar.create");
  if (action?.type !== "calendar.create") return;
  assert.equal(action.payload.title, "Birthday");
});

test("calendar.create: anchor date rolls to next year when the date has already passed this year", () => {
  // NOW is Jan 15 2026 — Dec 25 already happened in 2025-terms relative to
  // "this year" logic being year-agnostic per month/day; passing Jan 10
  // (before NOW) should roll to next year.
  const action = extractAssistantAction("Add January 10 as a reminder.", { now: NOW });
  assert.equal(action?.type, "calendar.create");
  if (action?.type !== "calendar.create") return;
  assert.equal(action.payload.date, "2027-01-10");
});

test("calendar.create: a future date this year stays in this year", () => {
  const action = extractAssistantAction("Add December 25 as a reminder.", { now: NOW });
  assert.equal(action?.type, "calendar.create");
  if (action?.type !== "calendar.create") return;
  assert.equal(action.payload.date, "2026-12-25");
});

test("calendar.create: one-time event has no recurrence", () => {
  const action = extractAssistantAction("Schedule a dentist appointment on March 3 at 2pm.", { now: NOW });
  assert.equal(action?.type, "calendar.create");
  if (action?.type !== "calendar.create") return;
  assert.equal(action.payload.recurrence, undefined);
  assert.equal(action.payload.timeText, "2pm");
});

test("calendar.create: MM/DD numeric date is recognized", () => {
  const action = extractAssistantAction("Add 6/15 every year as my anniversary.", { now: NOW });
  assert.equal(action?.type, "calendar.create");
  if (action?.type !== "calendar.create") return;
  assert.equal(action.payload.date, "2026-06-15");
  assert.deepEqual(action.payload.recurrence, { frequency: "yearly", interval: 1 });
});

test("calendar.create: 'every 2 weeks' captures a non-1 interval", () => {
  const action = extractAssistantAction("Add a team sync every 2 weeks starting March 3.", { now: NOW });
  assert.equal(action?.type, "calendar.create");
  if (action?.type !== "calendar.create") return;
  assert.deepEqual(action.payload.recurrence, { frequency: "weekly", interval: 2 });
});

test("goal.create: 'Add a goal to finish the portfolio.' extracts a goal command", () => {
  const action = extractAssistantAction("Add a goal to finish the portfolio.", { now: NOW });
  assert.equal(action?.type, "goal.create");
});

test("memory.create: 'Remember that I prefer React.' extracts a memory command", () => {
  const action = extractAssistantAction("Remember that I prefer React.", { now: NOW });
  assert.equal(action?.type, "memory.create");
});

test("goal.delete: 'Delete my portfolio goal.' extracts a goal-delete with the right query", () => {
  const action = extractAssistantAction("Delete my portfolio goal.", { now: NOW });
  assert.equal(action?.type, "goal.delete");
  if (action?.type !== "goal.delete") return;
  assert.equal(action.payload.query, "portfolio");
});

test("goal.complete: 'Complete my portfolio goal.' extracts a goal-complete with the right query", () => {
  const action = extractAssistantAction("Complete my portfolio goal.", { now: NOW });
  assert.equal(action?.type, "goal.complete");
  if (action?.type !== "goal.complete") return;
  assert.equal(action.payload.query, "portfolio");
});

test("calendar.delete: 'Delete my meeting.' extracts a calendar-delete with the right query", () => {
  const action = extractAssistantAction("Delete my meeting.", { now: NOW });
  assert.equal(action?.type, "calendar.delete");
  if (action?.type !== "calendar.delete") return;
  assert.equal(action.payload.query, "meeting");
});

test("STEP 23 — a question about how to do something is NOT an action (explanation only)", () => {
  assert.equal(extractAssistantAction("How would I add a recurring birthday event?", { now: NOW }), null);
});

test("STEP 23 — a musing statement is NOT an action", () => {
  assert.equal(extractAssistantAction("I should add my birthday to the calendar sometime.", { now: NOW }), null);
});

test("STEP 24 — a normal question never matches any action pattern", () => {
  assert.equal(extractAssistantAction("What's the best way to structure my goals?", { now: NOW }), null);
  assert.equal(extractAssistantAction("What day of the week is March 20 this year?", { now: NOW }), null);
});

test("an add-command with no recognizable date is NOT extracted as calendar.create (falls through to chat)", () => {
  assert.equal(extractAssistantAction("Add some excitement to my life.", { now: NOW }), null);
});

test("empty/whitespace message extracts nothing", () => {
  assert.equal(extractAssistantAction("", { now: NOW }), null);
  assert.equal(extractAssistantAction("   ", { now: NOW }), null);
});

// ============================================================
// goals.replace — the exact regression case from the reported failure
// ============================================================

test("EXACT REGRESSION CASE — the reported goals.replace message extracts all 3 titles", () => {
  const message =
    "I want change my goals. My goals as of right now are to 'Finish testing for the ValourTCG beta', " +
    "'Find a career job for Computer Science', 'Finish L.O.I.S./I.G.N.I.S. development'. " +
    "Delete the other Goals under Goals matrix.";

  const action = extractAssistantAction(message, { now: NOW });

  assert.ok(action, "expected an action to be extracted (this returned null before the fix)");
  assert.equal(action?.type, "goals.replace");
  if (action?.type !== "goals.replace") return;

  assert.deepEqual(action.payload.titles, [
    "Finish testing for the ValourTCG beta",
    "Find a career job for Computer Science",
    "Finish L.O.I.S./I.G.N.I.S. development",
  ]);
});

test("'Add a goal to finish Valour.' still extracts goal.create, NOT goals.replace (Objective 5)", () => {
  const action = extractAssistantAction("Add a goal to finish Valour.", { now: NOW });
  assert.equal(action?.type, "goal.create");
});

test("'Replace my goals with X, Y, Z.' extracts goals.replace via the unquoted fallback", () => {
  const action = extractAssistantAction("Replace my goals with learning Rust, shipping the beta, and writing docs.", {
    now: NOW,
  });

  assert.equal(action?.type, "goals.replace");
  if (action?.type !== "goals.replace") return;
  assert.deepEqual(action.payload.titles, ["learning Rust", "shipping the beta", "writing docs"]);
});

test("'These are my goals now: ...' extracts goals.replace", () => {
  const action = extractAssistantAction('These are my goals now: "finish the app" and "get a job".', { now: NOW });
  assert.equal(action?.type, "goals.replace");
  if (action?.type !== "goals.replace") return;
  assert.deepEqual(action.payload.titles, ["finish the app", "get a job"]);
});

test("'Set my goals to...' extracts goals.replace", () => {
  const action = extractAssistantAction('Set my goals to "learn Docker" and "ship v2".', { now: NOW });
  assert.equal(action?.type, "goals.replace");
});

test("a goals.replace trigger phrase with no parseable list falls through to normal chat", () => {
  assert.equal(extractAssistantAction("My goals are important to me.", { now: NOW }), null);
});

test("'What goals do you think I should prioritize?' is normal chat, not goals.replace (Objective 18)", () => {
  assert.equal(extractAssistantAction("What goals do you think I should prioritize?", { now: NOW }), null);
});

test("a single quoted goal whose own text contains a comma/'and' is NOT shredded by the unquoted fallback", () => {
  // Found live: exactly one quoted span, but only one -> triggers the
  // < 2 conservatism check regardless, so this correctly still falls
  // through to normal chat. The regression this guards against is the
  // quoted text being handed to extractUnquotedList's comma/and splitter
  // first and coming back as 3 garbled fragments before that check ran.
  const action = extractAssistantAction(
    "Set my goals to 'I am building LOIS and IGNIS, and I want to use them as references for our conversations'.",
    { now: NOW }
  );
  assert.equal(action, null);
});

test("two quoted goals, one of which internally contains 'and', are extracted as exactly two whole titles", () => {
  const action = extractAssistantAction(
    "Set my goals to 'building LOIS and IGNIS as references' and 'shipping the beta'.",
    { now: NOW }
  );
  assert.equal(action?.type, "goals.replace");
  if (action?.type !== "goals.replace") return;
  assert.deepEqual(action.payload.titles, ["building LOIS and IGNIS as references", "shipping the beta"]);
});
