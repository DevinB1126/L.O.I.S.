import type { CalendarEvent } from "../../types";

interface CalendarViewProps {
  events: CalendarEvent[] | undefined;
}

// The "Calendar" focus view shown in the conversation panel when the
// Calendar nav item is active (read-only event list). Moved out of App.tsx
// verbatim. Distinct from the "SCHEDULE" widget in RightPanels, which
// additionally supports deleting events.
export function CalendarView({ events }: CalendarViewProps) {
  return (
    <div className="focus-view">
      <h2>Calendar Matrix</h2>

      <ul className="focus-list">
        {events && events.length > 0 ? (
          events.map((event) => (
            <li key={event.id}>
              <span>□</span>
              <div>
                <strong>{event.title}</strong>
                <p>
                  {event.dateText} • {event.timeText}
                </p>
              </div>
            </li>
          ))
        ) : (
          <li>No calendar events stored</li>
        )}
      </ul>
    </div>
  );
}
