import { useCallback, useEffect, useState } from "react";
import * as api from "../services/api";
import type { ConversationSummary } from "../types";

// Projects v1A — chat management for ONE open project workspace: the
// project's own chats (Objective 3/19), plus everything Objective 14-17
// needs (listing global/unassigned chats to import, move, copy, remove).
export interface ProjectChatsController {
  chats: ConversationSummary[];
  loading: boolean;
  error: string | null;
  refreshChats: () => Promise<void>;
  createChat: (title?: string) => Promise<ConversationSummary | null>;
  renameChat: (id: string, title: string) => Promise<{ success: boolean; error?: string }>;
  deleteChat: (id: string) => Promise<void>;
  /** Objective 14 — lists chats NOT currently in any project, for the "Add
   *  Existing Chat" picker. Fetched on demand, not kept live-subscribed. */
  fetchGlobalChats: () => Promise<ConversationSummary[]>;
  moveChatIntoProject: (id: string) => Promise<boolean>;
  copyChatIntoProject: (id: string) => Promise<boolean>;
  removeChatFromProject: (id: string) => Promise<void>;
}

export function useProjectChats(projectId: string | null): ProjectChatsController {
  const [chats, setChats] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshChats = useCallback(async () => {
    if (!projectId) {
      setChats([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    try {
      const list = await api.getConversations({ projectId });
      setChats(list);
      setError(null);
    } catch {
      setError("Could not reach LOIS core. Is the backend running?");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    refreshChats();
  }, [refreshChats]);

  const createChat = useCallback(
    async (title?: string) => {
      if (!projectId) return null;
      const created = await api.createConversation({ projectId, title });
      await refreshChats();
      return created ? ({ ...created, messageCount: created.messages.length } as ConversationSummary) : null;
    },
    [projectId, refreshChats]
  );

  const renameChat = useCallback(
    async (id: string, title: string) => {
      const result = await api.renameConversation(id, title);
      if (result.success) await refreshChats();
      return { success: result.success, error: result.error };
    },
    [refreshChats]
  );

  const deleteChat = useCallback(
    async (id: string) => {
      await api.deleteConversation(id);
      await refreshChats();
    },
    [refreshChats]
  );

  const fetchGlobalChats = useCallback(async () => {
    return api.getConversations({ scopeGlobal: true });
  }, []);

  const moveChatIntoProject = useCallback(
    async (id: string) => {
      if (!projectId) return false;
      const moved = await api.moveConversationToProject(id, projectId);
      if (moved) await refreshChats();
      return Boolean(moved);
    },
    [projectId, refreshChats]
  );

  const copyChatIntoProject = useCallback(
    async (id: string) => {
      if (!projectId) return false;
      const copy = await api.copyConversationToProject(id, projectId);
      if (copy) await refreshChats();
      return Boolean(copy);
    },
    [projectId, refreshChats]
  );

  const removeChatFromProject = useCallback(
    async (id: string) => {
      await api.removeConversationFromProject(id);
      await refreshChats();
    },
    [refreshChats]
  );

  return {
    chats,
    loading,
    error,
    refreshChats,
    createChat,
    renameChat,
    deleteChat,
    fetchGlobalChats,
    moveChatIntoProject,
    copyChatIntoProject,
    removeChatFromProject,
  };
}
