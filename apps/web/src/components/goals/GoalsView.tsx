import type { Goal } from "../../types";

interface GoalsViewProps {
  goals: Goal[] | undefined;
}

// The "Goals" focus view shown in the conversation panel when the Goals nav
// item is active (read-only status list). Moved out of App.tsx verbatim.
// Distinct from the "CURRENT GOALS" widget in RightPanels, which
// additionally supports completing/deleting goals.
export function GoalsView({ goals }: GoalsViewProps) {
  return (
    <div className="focus-view">
      <h2>Goals Matrix</h2>

      <ul className="focus-list">
        {goals && goals.length > 0 ? (
          goals.map((goal) => (
            <li key={goal.id}>
              <span>{goal.completed ? "✓" : "○"}</span>
              <div>
                <strong>{goal.title}</strong>
                <p>{goal.completed ? "Completed" : "Active"}</p>
              </div>
            </li>
          ))
        ) : (
          <li>No goals stored</li>
        )}
      </ul>
    </div>
  );
}
