// Action Execution Layer v1 (Step 5/16) — recurrence display + next-
// occurrence calculation. A recurring event is stored ONCE (one anchor
// date + a recurrence rule), never as duplicated future records — these
// are the pure functions that derive everything display-facing from that
// single stored record.

import type { CalendarRecurrence, CalendarRecurrenceFrequency } from "./assistantAction";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** "March" "March 20" -> parses back out for display; used by
 *  formatDateText below. Throws on a malformed date so a bad write is
 *  caught immediately rather than silently rendering "Invalid Date". */
function parseIsoDate(isoDate: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) throw new Error(`Expected an ISO YYYY-MM-DD date, got "${isoDate}"`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** Recurring events omit the year (it recurs every year, so any single
 *  year would be misleading); one-time events include it, since the year
 *  is the only thing distinguishing "this March 20" from another. */
export function formatDateText(isoDate: string, recurrence?: CalendarRecurrence): string {
  const { year, month, day } = parseIsoDate(isoDate);
  const monthDay = `${MONTH_NAMES[month - 1]} ${day}`;
  return recurrence ? monthDay : `${monthDay}, ${year}`;
}

const UNIT_LABELS: Record<CalendarRecurrenceFrequency, string> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
  yearly: "year",
};

/** "" for a one-time event; ", repeating every year" / ", repeating every
 *  2 weeks" etc. otherwise — meant to be appended directly onto a
 *  sentence, per its leading comma. */
export function describeRecurrence(recurrence?: CalendarRecurrence): string {
  if (!recurrence) return "";
  const unit = UNIT_LABELS[recurrence.frequency];
  return recurrence.interval === 1 ? `, repeating every ${unit}` : `, repeating every ${recurrence.interval} ${unit}s`;
}

/** Short label for UI badges: "Repeats yearly" / "Repeats every 2 weeks" —
 *  matches the Calendar view mockup in the task spec (Step 15). */
export function recurrenceLabel(recurrence?: CalendarRecurrence): string | null {
  if (!recurrence) return null;
  const unit = UNIT_LABELS[recurrence.frequency];
  return recurrence.interval === 1 ? `Repeats ${recurrence.frequency}` : `Repeats every ${recurrence.interval} ${unit}s`;
}

function toUtcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function advance(date: Date, frequency: CalendarRecurrenceFrequency, interval: number): Date {
  const next = new Date(date);
  switch (frequency) {
    case "daily":
      next.setUTCDate(next.getUTCDate() + interval);
      break;
    case "weekly":
      next.setUTCDate(next.getUTCDate() + interval * 7);
      break;
    case "monthly":
      next.setUTCMonth(next.getUTCMonth() + interval);
      break;
    case "yearly":
      // Step 16 — leap-day note: advancing a Feb 29 anchor into a non-leap
      // target year lets JS's own Date normalization roll it to March 1
      // rather than throwing or silently staying on a nonexistent date.
      // That is a deliberate, documented choice for v1, not an oversight —
      // there is no current UI path that creates a Feb-29 anchor yet.
      next.setUTCFullYear(next.getUTCFullYear() + interval);
      break;
  }
  return next;
}

/** The next date (today or later, in UTC-midnight terms) this event falls
 *  on. For a one-time event this is just its stored date. For a recurring
 *  event, walks forward by the recurrence rule from the anchor date —
 *  never by materializing intermediate records, purely arithmetic. */
export function nextOccurrence(
  event: { date: string; recurrence?: CalendarRecurrence },
  now: Date = new Date()
): Date {
  const { year, month, day } = parseIsoDate(event.date);
  const anchor = new Date(Date.UTC(year, month - 1, day));

  if (!event.recurrence) return anchor;

  const today = toUtcMidnight(now);
  let candidate = anchor;

  // Bounded by construction: each step moves forward by at least one day,
  // and we stop the moment candidate >= today, so this always terminates
  // for a valid interval >= 1 (validated at the action-extraction/
  // executor boundary — see actionExtractor.ts).
  while (candidate.getTime() < today.getTime()) {
    candidate = advance(candidate, event.recurrence.frequency, event.recurrence.interval);
  }

  return candidate;
}

/** ISO YYYY-MM-DD for a Date already at UTC midnight (as every date this
 *  module produces/consumes is). */
export function toIsoDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
