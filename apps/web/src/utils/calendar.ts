import type { CalendarRecurrence } from "../types";

// Mirrors recurrenceLabel in apps/api/src/actions/calendarRecurrence.ts —
// a small, display-only duplicate (not shared across the network boundary,
// same posture as MEMORY_CATEGORIES's own comment in this file's sibling
// types/index.ts) rather than a fetch just to render a badge.
export function recurrenceLabel(recurrence: CalendarRecurrence | undefined): string | null {
  if (!recurrence) return null;
  const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[recurrence.frequency];
  return recurrence.interval === 1 ? `Repeats ${recurrence.frequency}` : `Repeats every ${recurrence.interval} ${unit}s`;
}
