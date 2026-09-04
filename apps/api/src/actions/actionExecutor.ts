// Action Execution Layer v1 (Step 7) — the ONLY place an AssistantAction
// turns into a real backend mutation. Every branch below calls an existing
// domain service function directly (never touches memory.json or any
// frontend state itself) and returns an ActionResult built from that
// service call's REAL return value — never from what the action "should"
// have done. This is what makes Step 9 ("never claim success unless the
// application actually reports success") structurally true rather than a
// convention someone has to remember: there is no code path here that
// constructs a success ActionResult without a real service call having
// already succeeded.

import {
  addCalendarEvent,
  deleteCalendarEvent,
  addGoalFromCommand,
  completeGoal,
  deleteGoal,
  replaceGoals,
  readMemory,
  Goal,
  CalendarEvent,
} from "../memory/memoryService";
import { processUserMessageForMemory } from "../memory/memoryPipeline";
import type { AssistantAction, ActionResult, ActionCandidate } from "./assistantAction";
import { describeRecurrence } from "./calendarRecurrence";

export interface ActionExecutionContext {
  /** Projects v1A — scopes memory.create the same way the existing
   *  fire-and-forget path already does; calendar/goals have no project
   *  scope concept today, so this is unused for those action types. */
  projectId?: string | null;
}

export async function executeAssistantAction(
  action: AssistantAction,
  context: ActionExecutionContext = {}
): Promise<ActionResult> {
  switch (action.type) {
    case "calendar.create":
      return executeCalendarCreate(action.payload);
    case "calendar.delete":
      return executeCalendarDelete(action.payload);
    case "goal.create":
      return executeGoalCreate(action.payload);
    case "goal.complete":
      return executeGoalComplete(action.payload);
    case "goal.delete":
      return executeGoalDelete(action.payload);
    case "goals.replace":
      return executeGoalsReplace(action.payload);
    case "memory.create":
      return executeMemoryCreate(action.payload, context);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ============================================================
// calendar.create / calendar.delete
// ============================================================

function executeCalendarCreate(payload: Extract<AssistantAction, { type: "calendar.create" }>["payload"]): ActionResult {
  try {
    const event = addCalendarEvent({
      title: payload.title,
      date: payload.date,
      timeText: payload.timeText,
      recurrence: payload.recurrence,
    });

    return {
      success: true,
      actionType: "calendar.create",
      message: `Done. "${event.title}" is saved on ${event.dateText}${describeRecurrence(event.recurrence)}.`,
      data: event,
    };
  } catch (error) {
    return { success: false, actionType: "calendar.create", status: "error", error: describeError(error) };
  }
}

function findMatchingCalendarEvents(query: string): CalendarEvent[] {
  const lower = query.trim().toLowerCase();
  if (!lower) return [];
  return readMemory().calendar.filter((event) => event.title.toLowerCase().includes(lower));
}

function executeCalendarDelete(payload: { query: string }): ActionResult {
  const matches = findMatchingCalendarEvents(payload.query);

  if (matches.length === 0) {
    return {
      success: false,
      actionType: "calendar.delete",
      status: "error",
      error: `I couldn't find a calendar event matching "${payload.query}".`,
    };
  }

  // Step 21/22 — never guess which one the user meant.
  if (matches.length > 1) {
    return {
      success: false,
      actionType: "calendar.delete",
      status: "needs_clarification",
      message: `I found ${matches.length} events matching "${payload.query}" — which one did you mean?`,
      candidates: matches.map(toCalendarCandidate),
    };
  }

  const [target] = matches;
  const deleted = deleteCalendarEvent(target.id);

  return deleted
    ? { success: true, actionType: "calendar.delete", message: `Done. Deleted "${target.title}" from your calendar.` }
    : {
        success: false,
        actionType: "calendar.delete",
        status: "error",
        error: `I found "${target.title}" but couldn't delete it — it may have already been removed.`,
      };
}

function toCalendarCandidate(event: CalendarEvent): ActionCandidate {
  return { id: event.id, label: `${event.title} (${event.dateText})` };
}

// ============================================================
// goal.create / goal.complete / goal.delete
// ============================================================

function executeGoalCreate(payload: { rawMessage: string }): ActionResult {
  // addGoalFromCommand (unlike the pipeline wrapper around it,
  // processExplicitGoalCommand) returns the created Goal or null — a real
  // signal, which is exactly what this layer needs and the older
  // fire-and-forget path discarded. Called directly rather than through
  // processUserMessageForMemory for that reason.
  const goal = addGoalFromCommand(payload.rawMessage);

  if (!goal) {
    return {
      success: false,
      actionType: "goal.create",
      status: "error",
      error: "That goal is empty or already exists, so nothing new was added.",
    };
  }

  return { success: true, actionType: "goal.create", message: `Done. Added "${goal.title}" to your goals.`, data: goal };
}

function findMatchingGoals(query: string): Goal[] {
  const lower = query.trim().toLowerCase();
  if (!lower) return [];
  return readMemory().goals.filter((goal) => !goal.completed && goal.title.toLowerCase().includes(lower));
}

function toGoalCandidate(goal: Goal): ActionCandidate {
  return { id: goal.id, label: goal.title };
}

function executeGoalComplete(payload: { query: string }): ActionResult {
  const matches = findMatchingGoals(payload.query);

  if (matches.length === 0) {
    return {
      success: false,
      actionType: "goal.complete",
      status: "error",
      error: `I couldn't find an active goal matching "${payload.query}".`,
    };
  }

  if (matches.length > 1) {
    return {
      success: false,
      actionType: "goal.complete",
      status: "needs_clarification",
      message: `I found ${matches.length} goals matching "${payload.query}" — which one did you mean?`,
      candidates: matches.map(toGoalCandidate),
    };
  }

  const [target] = matches;
  const completed = completeGoal(target.id);

  return completed
    ? { success: true, actionType: "goal.complete", message: `Done. Marked "${target.title}" as complete.` }
    : {
        success: false,
        actionType: "goal.complete",
        status: "error",
        error: `I found "${target.title}" but couldn't mark it complete.`,
      };
}

function executeGoalDelete(payload: { query: string }): ActionResult {
  const matches = readMemory().goals.filter((goal) => goal.title.toLowerCase().includes(payload.query.trim().toLowerCase()));

  if (matches.length === 0) {
    return { success: false, actionType: "goal.delete", status: "error", error: `I couldn't find a goal matching "${payload.query}".` };
  }

  if (matches.length > 1) {
    return {
      success: false,
      actionType: "goal.delete",
      status: "needs_clarification",
      message: `I found ${matches.length} goals matching "${payload.query}" — which one did you mean?`,
      candidates: matches.map(toGoalCandidate),
    };
  }

  const [target] = matches;
  const deleted = deleteGoal(target.id);

  return deleted
    ? { success: true, actionType: "goal.delete", message: `Done. Deleted "${target.title}" from your goals.` }
    : { success: false, actionType: "goal.delete", status: "error", error: `I found "${target.title}" but couldn't delete it.` };
}

// ============================================================
// goals.replace
// ============================================================

const MAX_GOALS_REPLACE_COUNT = 50;
const MAX_GOAL_TITLE_LENGTH = 200;

// Objective 1's validation stage — extraction produces raw, unvalidated
// titles; this is the one place they're checked before ever reaching the
// service layer. Trims, rejects empty-after-trim, enforces a per-title
// length ceiling, removes exact (case-insensitive) duplicates, and caps
// the total count — all before replaceGoals() (which trusts its input) is
// ever called.
function validateGoalsReplacePayload(rawTitles: string[]): { ok: true; titles: string[] } | { ok: false; error: string } {
  const trimmed = rawTitles.map((title) => title.trim()).filter((title) => title.length > 0);

  if (trimmed.length === 0) {
    return { ok: false, error: "That didn't contain any goal titles to save." };
  }

  const tooLong = trimmed.find((title) => title.length > MAX_GOAL_TITLE_LENGTH);
  if (tooLong) {
    return { ok: false, error: `One of those goals is too long (over ${MAX_GOAL_TITLE_LENGTH} characters).` };
  }

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const title of trimmed) {
    const key = title.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(title);
    }
  }

  if (deduped.length > MAX_GOALS_REPLACE_COUNT) {
    return { ok: false, error: `That's too many goals at once (max ${MAX_GOALS_REPLACE_COUNT}).` };
  }

  return { ok: true, titles: deduped };
}

// Objective 19 — this is the diagnostic case the whole shared pipeline was
// traced against, so it gets the full granular lifecycle trace
// (action.detected/action.executing are logged one level up, in
// server.ts, for every action type; validated/persisted are specific to
// this one since it's the only action with a distinct validation stage
// and a multi-record persistence step worth calling out separately).
function executeGoalsReplace(payload: { titles: string[] }): ActionResult {
  const validated = validateGoalsReplacePayload(payload.titles);

  if (!validated.ok) {
    console.log(`[action.rejected] goals.replace: ${validated.error}`);
    return { success: false, actionType: "goals.replace", status: "error", error: validated.error };
  }

  console.log(`[action.validated] goals.replace: ${validated.titles.length} goal(s)`);

  try {
    const goals = replaceGoals(validated.titles);
    console.log(`[action.persisted] goals.replace: ${goals.length} active goal(s) now stored`);
    const list = goals.map((goal) => `"${goal.title}"`).join(", ");

    return {
      success: true,
      actionType: "goals.replace",
      message: `Done. Your active goals are now: ${list}.`,
      data: goals,
    };
  } catch (error) {
    return { success: false, actionType: "goals.replace", status: "error", error: describeError(error) };
  }
}

// ============================================================
// memory.create
// ============================================================

async function executeMemoryCreate(payload: { rawMessage: string }, context: ActionExecutionContext): Promise<ActionResult> {
  // processUserMessageForMemory dispatches an explicit "remember that..."
  // command to processExplicitCommand, which — unlike the goal-command
  // wrapper — DOES return real saved/duplicate signal, so it's safe to
  // reuse directly here rather than re-deriving the same split/dedup logic.
  const result = await processUserMessageForMemory(payload.rawMessage, { projectId: context.projectId ?? null });

  if (result.saved.length > 0) {
    const summary = result.saved.length === 1 ? `"${result.saved[0].content}"` : `${result.saved.length} things`;
    return { success: true, actionType: "memory.create", message: `Done. I'll remember ${summary}.`, data: result.saved };
  }

  if (result.duplicates.length > 0) {
    return {
      success: false,
      actionType: "memory.create",
      status: "error",
      error: "I already have that saved — nothing new was added.",
    };
  }

  return {
    success: false,
    actionType: "memory.create",
    status: "error",
    error: "That didn't contain anything I could save as a memory.",
  };
}
