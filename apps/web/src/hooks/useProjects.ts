import { useCallback, useEffect, useState } from "react";
import * as api from "../services/api";
import type { Project } from "../types";

// Projects v1A — project CRUD + list, mirroring useDocuments/useMemory's
// own shape: state plus the actions that mutate it, so ProjectsRoot takes
// one cohesive object instead of a pile of unrelated props.
export interface ProjectsController {
  projects: Project[];
  loading: boolean;
  error: string | null;
  refreshProjects: () => Promise<void>;
  createProject: (input: api.CreateProjectInput) => Promise<{ success: boolean; project?: Project; error?: string }>;
  updateProject: (id: string, updates: api.UpdateProjectInput) => Promise<{ success: boolean; error?: string }>;
  archiveProject: (id: string) => Promise<void>;
  unarchiveProject: (id: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
}

export function useProjects(): ProjectsController {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshProjects = useCallback(async () => {
    setLoading(true);

    try {
      const list = await api.getProjects();
      setProjects(list);
      setError(null);
    } catch {
      setError("Could not reach LOIS core. Is the backend running?");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshProjects();
  }, [refreshProjects]);

  const createProject = useCallback(
    async (input: api.CreateProjectInput) => {
      const result = await api.createProject(input);
      if (result.success) await refreshProjects();
      return result;
    },
    [refreshProjects]
  );

  const updateProject = useCallback(
    async (id: string, updates: api.UpdateProjectInput) => {
      const result = await api.updateProject(id, updates);
      if (result.success) await refreshProjects();
      return { success: result.success, error: result.error };
    },
    [refreshProjects]
  );

  const archiveProject = useCallback(
    async (id: string) => {
      await api.archiveProject(id);
      await refreshProjects();
    },
    [refreshProjects]
  );

  const unarchiveProject = useCallback(
    async (id: string) => {
      await api.unarchiveProject(id);
      await refreshProjects();
    },
    [refreshProjects]
  );

  const deleteProject = useCallback(
    async (id: string) => {
      await api.deleteProject(id);
      await refreshProjects();
    },
    [refreshProjects]
  );

  return { projects, loading, error, refreshProjects, createProject, updateProject, archiveProject, unarchiveProject, deleteProject };
}
