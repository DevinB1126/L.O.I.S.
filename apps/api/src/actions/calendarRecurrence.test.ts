// Unit tests for recurrence display + next-occurrence math (Step 16).
// Run with: npm run test --workspace=api

import { test } from "node:test";
import assert from "node:assert/strict";
import { describeRecurrence, formatDateText, nextOccurrence, recurrenceLabel } from "./calendarRecurrence";

test("formatDateText omits the year for a recurring event", () => {
  assert.equal(formatDateText("2026-03-20", { frequency: "yearly", interval: 1 }), "March 20");
});

test("formatDateText includes the year for a one-time event", () => {
  assert.equal(formatDateText("2026-03-20"), "March 20, 2026");
});

test("describeRecurrence produces a sentence-appendable clause", () => {
  assert.equal(describeRecurrence({ frequency: "yearly", interval: 1 }), ", repeating every year");
  assert.equal(describeRecurrence({ frequency: "weekly", interval: 2 }), ", repeating every 2 weeks");
  assert.equal(describeRecurrence(undefined), "");
});

test("recurrenceLabel produces a short UI badge", () => {
  assert.equal(recurrenceLabel({ frequency: "yearly", interval: 1 }), "Repeats yearly");
  assert.equal(recurrenceLabel({ frequency: "monthly", interval: 3 }), "Repeats every 3 months");
  assert.equal(recurrenceLabel(undefined), null);
});

test("nextOccurrence for a one-time event is just its own date", () => {
  const result = nextOccurrence({ date: "2026-03-20" }, new Date("2026-01-01T00:00:00Z"));
  assert.equal(result.toISOString().slice(0, 10), "2026-03-20");
});

test("STEP 17 — yearly recurrence: if the anchor date hasn't happened yet this year, next occurrence is this year", () => {
  const event = { date: "2026-03-20", recurrence: { frequency: "yearly" as const, interval: 1 } };
  const result = nextOccurrence(event, new Date("2026-01-15T00:00:00Z"));
  assert.equal(result.toISOString().slice(0, 10), "2026-03-20");
});

test("STEP 16 — yearly recurrence: if the anchor date already passed this year, next occurrence is next year", () => {
  const event = { date: "2026-03-20", recurrence: { frequency: "yearly" as const, interval: 1 } };
  const result = nextOccurrence(event, new Date("2026-06-01T00:00:00Z"));
  assert.equal(result.toISOString().slice(0, 10), "2027-03-20");
});

test("yearly recurrence: on the exact anchor date, next occurrence is today", () => {
  const event = { date: "2026-03-20", recurrence: { frequency: "yearly" as const, interval: 1 } };
  const result = nextOccurrence(event, new Date("2026-03-20T00:00:00Z"));
  assert.equal(result.toISOString().slice(0, 10), "2026-03-20");
});

test("weekly recurrence advances week by week to the next occurrence on/after now", () => {
  const event = { date: "2026-01-01", recurrence: { frequency: "weekly" as const, interval: 1 } };
  const result = nextOccurrence(event, new Date("2026-01-20T00:00:00Z"));
  // Jan 1 (Thu) + 7*n weeks, first one on/after Jan 20 -> Jan 22
  assert.equal(result.toISOString().slice(0, 10), "2026-01-22");
});

test("every-2-years recurrence respects the interval, not just the frequency", () => {
  const event = { date: "2026-03-20", recurrence: { frequency: "yearly" as const, interval: 2 } };
  const result = nextOccurrence(event, new Date("2027-01-01T00:00:00Z"));
  // 2026-03-20 already passed by 2027; next step is +2 years -> 2028-03-20
  assert.equal(result.toISOString().slice(0, 10), "2028-03-20");
});
