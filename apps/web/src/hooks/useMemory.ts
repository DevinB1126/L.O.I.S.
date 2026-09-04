import { useCallback, useEffect, useState } from "react";
import * as api from "../services/api";
import type { MemoryData } from "../types";

// Groups memory state together with the actions that mutate it, so
// consumers (App.tsx, RightPanels) take one cohesive object instead of a
// pile of unrelated props.
export interface MemoryController {
  memory: MemoryData | null;
  loadMemory: () => Promise<void>;
  deleteMemory: (id: string) => Promise<void>;
  updateMemory: (id: string, updates: api.UpdateMemoryInput) => Promise<{ success: boolean; error?: string }>;
  deleteCalendarEvent: (eventId: string) => Promise<void>;
  completeGoal: (goalId: string) => Promise<void>;
  deleteGoal: (goalId: string) => Promise<void>;
}

// Owns loading and refreshing the memory snapshot (profile, facts, goals,
// calendar) and every mutation that should trigger a reload afterward.
// Behavior matches the original App.tsx implementation exactly, including
// reloading memory after every mutation.
export function useMemory(): MemoryController {
  const [memory, setMemory] = useState<MemoryData | null>(null);

  const loadMemory = useCallback(async () => {
    try {
      const data = await api.getMemory();
      setMemory(data);
    } catch (error) {
      console.error("Failed to load memory:", error);
    }
  }, []);

  useEffect(() => {
    loadMemory();
  }, [loadMemory]);

  const deleteMemory = useCallback(
    async (id: string) => {
      try {
        await api.deleteMemory(id);
        await loadMemory();
      } catch (error) {
        console.error("Failed to delete memory:", error);
      }
    },
    [loadMemory]
  );

  // Memory v2D. Unlike the other mutations above (fire, swallow errors,
  // reload), this one needs to hand a result back to the caller: an edit
  // can be rejected (invalid field, exact duplicate — Objective 5/24) and
  // MemoryView needs that message to show inline. Correctness over
  // optimism (Objective 19, option A): canonical state only ever reloads
  // after a CONFIRMED successful backend update, so a failed edit can
  // never leave the UI showing something that wasn't actually persisted.
  const updateMemory = useCallback(
    async (id: string, updates: api.UpdateMemoryInput) => {
      const result = await api.updateMemory(id, updates);

      if (result.success) {
        await loadMemory();
      }

      return { success: result.success, error: result.error };
    },
    [loadMemory]
  );

  const deleteCalendarEvent = useCallback(
    async (eventId: string) => {
      try {
        await api.deleteCalendarEvent(eventId);
        await loadMemory();
      } catch (error) {
        console.error("Failed to delete calendar event:", error);
      }
    },
    [loadMemory]
  );

  const completeGoal = useCallback(
    async (goalId: string) => {
      try {
        await api.completeGoal(goalId);
        await loadMemory();
      } catch (error) {
        console.error("Failed to complete goal:", error);
      }
    },
    [loadMemory]
  );

  const deleteGoal = useCallback(
    async (goalId: string) => {
      try {
        await api.deleteGoal(goalId);
        await loadMemory();
      } catch (error) {
        console.error("Failed to delete goal:", error);
      }
    },
    [loadMemory]
  );

  return { memory, loadMemory, deleteMemory, updateMemory, deleteCalendarEvent, completeGoal, deleteGoal };
}
