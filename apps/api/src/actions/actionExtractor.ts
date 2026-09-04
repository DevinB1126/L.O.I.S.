// Action Execution Layer v1 (Step 3) — turns a user message into a
// structured AssistantAction, or null if it isn't a recognized action.
//
// Deterministic parsing only, no LLM call — matching every other
// command-detection gate already in this codebase (isExplicitMemoryCommand,
// isExplicitGoalCommand, tryHandleProfileUpdate's detector). Reusing that
// same pattern here isn't just consistency for its own sake: an LLM call
// per message for "is this an action" would add a second Ollama round-trip
// to every chat turn, working directly against the whole point of the
// recent Performance Pass (TTFT is CPU-prefill-bound on this hardware).
// Strict, testable regex extraction covers the concrete cases this task
// specifies with zero added latency and zero risk of the model inventing a
// structured action that doesn't match what the user actually said.
//
// Step 23/24 — conservative by design: every matcher below requires an
// imperative, command-shaped message (an action verb at/near the start,
// plus whatever concrete detail that action needs — a real date for
// calendar.create, the literal word "goal" for goal commands, etc.). A
// question ("How would I add a recurring event?") or a musing statement
// ("I should add my birthday sometime") does not match any pattern here,
// so extractAssistantAction returns null and the caller falls through to
// completely normal chat generation, unchanged.

import { isExplicitGoalCommand, isExplicitMemoryCommand } from "../memory/memoryExtractor";
import type { AssistantAction, CalendarRecurrence, CalendarRecurrenceFrequency } from "./assistantAction";
import { toIsoDate } from "./calendarRecurrence";

export interface ActionExtractionContext {
  /** Used to build a possessive title ("Devin's Birthday") when available;
   *  falls back to a generic title ("Birthday") when not. */
  profileName?: string;
  /** Injectable for deterministic tests; defaults to the real current time. */
  now?: Date;
}

export function extractAssistantAction(message: string, context: ActionExtractionContext = {}): AssistantAction | null {
  const trimmed = message.trim();
  if (!trimmed) return null;

  // Explicit memory/goal commands are already deterministic and
  // authoritative (Memory v2B) — checked first so they always win over the
  // looser calendar/complete/delete matchers below (e.g. a goal command
  // never gets misread as a calendar command just because it also mentions
  // a day of the week).
  if (isExplicitMemoryCommand(trimmed)) {
    return { type: "memory.create", payload: { rawMessage: trimmed } };
  }

  if (isExplicitGoalCommand(trimmed)) {
    return { type: "goal.create", payload: { rawMessage: trimmed } };
  }

  // Checked before the single-item goal matchers below: "my goals are A,
  // B, C" is a collection-replacement intent, not a single goal.create —
  // conflating the two was the exact root cause of the reported bug (see
  // this task's diagnostic trace: extraction returned null for that
  // message because nothing recognized "set my whole goals list" as any
  // kind of action at all).
  const goalsReplace = matchGoalsReplace(trimmed);
  if (goalsReplace) return goalsReplace;

  const goalComplete = matchGoalComplete(trimmed);
  if (goalComplete) return goalComplete;

  const goalDelete = matchGoalDelete(trimmed);
  if (goalDelete) return goalDelete;

  const calendarCreate = matchCalendarCreate(trimmed, context);
  if (calendarCreate) return calendarCreate;

  const calendarDelete = matchCalendarDelete(trimmed);
  if (calendarDelete) return calendarDelete;

  return null;
}

// ============================================================
// calendar.create
// ============================================================

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const UNIT_TO_FREQUENCY: Record<string, CalendarRecurrenceFrequency> = {
  day: "daily",
  week: "weekly",
  month: "monthly",
  year: "yearly",
};

function parseRecurrence(text: string): CalendarRecurrence | undefined {
  const lower = text.toLowerCase();

  const everyN = lower.match(/\b(?:every|each)\s+(\d+)\s+(day|week|month|year)s?\b/);
  if (everyN) {
    return { frequency: UNIT_TO_FREQUENCY[everyN[2]], interval: parseInt(everyN[1], 10) };
  }

  const everyOne = lower.match(/\b(?:every|each)\s+(day|week|month|year)\b/);
  if (everyOne) {
    return { frequency: UNIT_TO_FREQUENCY[everyOne[1]], interval: 1 };
  }

  if (/\bdaily\b/.test(lower)) return { frequency: "daily", interval: 1 };
  if (/\bweekly\b/.test(lower)) return { frequency: "weekly", interval: 1 };
  if (/\bmonthly\b/.test(lower)) return { frequency: "monthly", interval: 1 };
  if (/\b(?:yearly|annually)\b/.test(lower)) return { frequency: "yearly", interval: 1 };

  return undefined;
}

function startOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Picks the anchor YEAR for a bare month/day: this year if that date
 *  hasn't passed yet, otherwise next year — so a freshly created event
 *  always describes an upcoming (or today's) occurrence, whether or not it
 *  recurs. */
function buildAnchorIsoDate(month: number, day: number, now: Date): string {
  const today = startOfDay(now);
  const thisYearCandidate = new Date(Date.UTC(now.getUTCFullYear(), month - 1, day));
  const year = thisYearCandidate.getTime() < today.getTime() ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
  return toIsoDate(new Date(Date.UTC(year, month - 1, day)));
}

function nextWeekdayIsoDate(now: Date, weekdayIndex: number): string {
  const today = startOfDay(now);
  const diff = (weekdayIndex - today.getUTCDay() + 7) % 7;
  const target = new Date(today);
  target.setUTCDate(target.getUTCDate() + diff);
  return toIsoDate(target);
}

function parseAnchorDate(text: string, now: Date): string | null {
  const monthDay = text.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i
  );

  if (monthDay) {
    const month = MONTHS[monthDay[1].toLowerCase()];
    const day = parseInt(monthDay[2], 10);
    if (month && day >= 1 && day <= 31) {
      return buildAnchorIsoDate(month, day, now);
    }
  }

  // MM/DD or MM-DD, not preceded/followed by another digit or separator
  // (so a longer numeric run like a phone number or full ISO date doesn't
  // get misread as month/day).
  const numeric = text.match(/(?<![\d/-])(\d{1,2})[/-](\d{1,2})(?![\d/-])/);
  if (numeric) {
    const month = parseInt(numeric[1], 10);
    const day = parseInt(numeric[2], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return buildAnchorIsoDate(month, day, now);
    }
  }

  const lower = text.toLowerCase();
  if (/\btoday\b/.test(lower)) return toIsoDate(startOfDay(now));
  if (/\btomorrow\b/.test(lower)) {
    const tomorrow = startOfDay(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    return toIsoDate(tomorrow);
  }

  const weekdayIndex = WEEKDAYS.findIndex((day) => new RegExp(`\\b${day}\\b`, "i").test(lower));
  if (weekdayIndex !== -1) {
    return nextWeekdayIsoDate(now, weekdayIndex);
  }

  return null;
}

function parseTimeText(text: string): string | undefined {
  const match = text.match(/\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i);
  return match ? match[0] : undefined;
}

function formatPossessiveTitle(noun: string, profileName: string | undefined): string {
  const capitalized = noun.charAt(0).toUpperCase() + noun.slice(1);
  return profileName ? `${profileName}'s ${capitalized}` : capitalized;
}

const LEADING_PHRASES = /^(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:add|create|schedule|set|put|remind me (?:of|about)|save)\b\s*/i;
const RECURRENCE_PHRASES = /\b(?:every|each)\s+(?:\d+\s+)?(?:day|week|month|year)s?\b/gi;
const FREQUENCY_WORDS = /\b(?:daily|weekly|monthly|yearly|annually)\b/gi;

function extractCalendarTitle(text: string, profileName: string | undefined): string {
  const asMy = text.match(/\bas\s+(?:my|his|her|their)\s+([a-z][a-z\s]*?)(?:\s+every\b|\s+each\b|[.!?]|$)/i);
  if (asMy?.[1].trim()) return formatPossessiveTitle(asMy[1].trim(), profileName);

  const forMy = text.match(/\bfor\s+(?:my|his|her|their)\s+([a-z][a-z\s]*?)(?:\s+every\b|\s+each\b|[.!?]|$)/i);
  if (forMy?.[1].trim()) return formatPossessiveTitle(forMy[1].trim(), profileName);

  const cleaned = text
    .replace(LEADING_PHRASES, "")
    .replace(RECURRENCE_PHRASES, "")
    .replace(FREQUENCY_WORDS, "")
    .replace(/\bto\s+(?:my\s+)?calendar\b/gi, "")
    .replace(/\bon\s+(?:my\s+)?calendar\b/gi, "")
    .trim()
    .replace(/[.!?]+$/, "")
    .trim();

  return cleaned || "Event";
}

const CALENDAR_CREATE_VERB = /^(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:add|create|schedule|set|put|remind me (?:of|about)|save)\b/i;
const CALENDAR_PHRASE_ANYWHERE = /\b(?:add|put)\b[\s\S]*\b(?:to|on)\s+(?:my\s+)?calendar\b/i;

function matchCalendarCreate(text: string, context: ActionExtractionContext): AssistantAction | null {
  const hasVerb = CALENDAR_CREATE_VERB.test(text) || CALENDAR_PHRASE_ANYWHERE.test(text);
  if (!hasVerb) return null;

  const now = context.now ?? new Date();
  const date = parseAnchorDate(text, now);
  if (!date) return null; // no recognizable date -> not confident enough; fall through to normal chat

  return {
    type: "calendar.create",
    payload: {
      title: extractCalendarTitle(text, context.profileName),
      date,
      timeText: parseTimeText(text),
      recurrence: parseRecurrence(text),
    },
  };
}

// ============================================================
// goals.replace
// ============================================================

// Objective 5 — a whole phrasing FAMILY, not one hardcoded sentence.
// Every trigger below asserts "this list IS my goals now" (replacement
// semantics), as opposed to goal.create's "add one more goal" semantics.
const GOALS_REPLACE_TRIGGERS: RegExp[] = [
  /\bmy goals?\s+(?:as of (?:right )?now\s+)?(?:are|is)\s+to\b/i,
  /\bmy goals?\s+(?:as of (?:right )?now\s+)?(?:are|is)\b/i,
  /\bmy current goals?\s+(?:are|is|should be)\b/i,
  /\bthese are my goals?\s+now\b/i,
  /\breplace my goals?\s+with\b/i,
  /\bset my goals?\s+to\b/i,
  /\bupdate my goals?\s+to\b/i,
  /\bchange my goals?\s+to\b/i,
];

/** Any single- or double-quoted span, "" 2+ chars, treated as one goal
 *  title each. Quotes are a strong, unambiguous signal for a literal list
 *  — far safer than trying to guess where an unquoted comma list starts
 *  and ends around arbitrary surrounding sentences. */
function extractQuotedList(text: string): string[] {
  return [...text.matchAll(/['"]([^'"]{2,200})['"]/g)].map((m) => m[1].trim()).filter((s) => s.length > 0);
}

/** Best-effort fallback for a trigger phrase with no quotes at all (e.g.
 *  "Replace my goals with finishing the app, learning Rust, and reading
 *  more."): takes the text after the trigger up to the next sentence
 *  boundary or a "delete/remove the other(s)" clause, then splits on
 *  commas/"and". Deliberately simpler than the quoted path — this is a
 *  best-effort convenience, not the primary mechanism the exact regression
 *  test relies on. */
function extractUnquotedList(text: string, trigger: RegExpMatchArray): string[] {
  const start = (trigger.index ?? 0) + trigger[0].length;
  const rest = text.slice(start);
  const stop = rest.match(/[.!?]\s|\bdelete\s+(?:the\s+)?others?\b|\bremove\s+(?:the\s+)?others?\b/i);
  const listText = stop ? rest.slice(0, stop.index) : rest;

  return listText
    .split(/,|\band\b/i)
    .map((segment) => segment.trim().replace(/^to\s+/i, "").replace(/[.!?]+$/, "").trim())
    .filter((segment) => segment.length > 0);
}

function matchGoalsReplace(text: string): AssistantAction | null {
  let trigger: RegExpMatchArray | null = null;

  for (const pattern of GOALS_REPLACE_TRIGGERS) {
    const match = text.match(pattern);
    if (match) {
      trigger = match;
      break;
    }
  }

  if (!trigger) return null;

  // Any quoted span found at all (even just one) is trusted over the
  // unquoted fallback — a single quoted goal whose own text happens to
  // contain a comma or "and" (e.g. "references for our conversations, and
  // more") must never be handed to the comma/and-splitter, which would
  // shred it into nonsense fragments. The unquoted path only ever runs
  // when there were no quotes to work with in the first place.
  const quoted = extractQuotedList(text);
  const titles = quoted.length > 0 ? quoted : extractUnquotedList(text, trigger);

  // Requiring at least 2 items (via either path) is a deliberate
  // conservatism bar (Step 23's own "be conservative when intent is
  // ambiguous"): a trigger phrase followed by exactly one vague fragment
  // is far more likely to be a musing/incomplete sentence ("My goals are
  // important to me.") than a genuine replacement list, and the cost of a
  // false negative here (falls through to normal chat, user can rephrase)
  // is much lower than the cost of a false positive silently replacing
  // someone's active goals with a misparsed fragment.
  if (titles.length < 2) return null;

  return { type: "goals.replace", payload: { titles } };
}

// ============================================================
// calendar.delete / goal.complete / goal.delete
// ============================================================

function matchGoalComplete(text: string): AssistantAction | null {
  const match =
    text.match(/^(?:mark\s+)?complete\s+(?:my\s+)?(.+?)\s+goal[.!?]*$/i) ||
    text.match(/^(?:i\s+)?(?:finished|completed)\s+(?:my\s+)?(.+?)\s+goal[.!?]*$/i);

  if (!match) return null;
  const query = match[1].trim();
  if (!query) return null;

  return { type: "goal.complete", payload: { query } };
}

function matchGoalDelete(text: string): AssistantAction | null {
  const match =
    text.match(/^delete\s+(?:my\s+)?(.+?)\s+goal[.!?]*$/i) || text.match(/^remove\s+(?:my\s+)?(.+?)\s+goal[.!?]*$/i);

  if (!match) return null;
  const query = match[1].trim();
  if (!query) return null;

  return { type: "goal.delete", payload: { query } };
}

const CALENDAR_DELETE_NOUN = /\b(?:event|appointment|meeting|birthday|reminder|calendar)\b/i;

function matchCalendarDelete(text: string): AssistantAction | null {
  const match = text.match(/^(?:delete|remove|cancel)\s+(?:my\s+)?(.+?)[.!?]*$/i);
  if (!match) return null;

  const query = match[1].trim();
  if (!query) return null;

  // Requires an event-ish noun somewhere in the message so this doesn't
  // over-trigger on unrelated "delete my X" phrasing that isn't about the
  // calendar at all (goal deletion is already caught above, before this
  // matcher runs).
  if (!CALENDAR_DELETE_NOUN.test(text)) return null;

  return { type: "calendar.delete", payload: { query } };
}
