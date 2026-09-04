import type { CalendarEvent } from "../../types";
import { recurrenceLabel } from "../../utils/calendar";

interface CalendarViewProps {
  events: CalendarEvent[] | undefined;
}

// The "Calendar" focus view shown in the conversation panel when the
// Calendar nav item is active (read-only event list). Moved out of App.tsx
// verbatim. Distinct from the "SCHEDULE" widget in RightPanels, which
// additionally supports deleting events.
//
// Action Execution Layer v1 (Step 15) — a recurring event shows its
// recurrence explicitly ("Repeats yearly") rather than only ever showing
// one occurrence, since the underlying record IS the recurrence rule, not
// a single date.
export function CalendarView({ events }: CalendarViewProps) {
  return (
    <div className="focus-view">
      <h2>Calendar Matrix</h2>

      <ul className="focus-list">
        {events && events.length > 0 ? (
          events.map((event) => {
            const repeats = recurrenceLabel(event.recurrence);

            return (
              <li key={event.id}>
                <span>□</span>
                <div>
                  <strong>{event.title}</strong>
                  <p>
                    {event.dateText} • {event.timeText}
                    {repeats ? ` • ${repeats}` : ""}
                  </p>
                </div>
              </li>
            );
          })
        ) : (
          <li>No calendar events stored</li>
        )}
      </ul>
    </div>
  );
}
