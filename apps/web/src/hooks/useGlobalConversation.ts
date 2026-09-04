import { useEffect, useState } from "react";
import * as api from "../services/api";

// Projects v1A (Objective 20) — the plain "Chat" nav view keeps behaving
// exactly like the pre-Projects single continuous conversation: it always
// shows ONE default global (projectId: null) conversation. This hook
// resolves which one that is on load — the most-recently-updated
// global/unassigned conversation if one already exists (this is exactly
// the conversation the legacy flat conversation log was migrated into, so
// existing chat history reappears unchanged after upgrading), or lazily
// creates a fresh one if this is a first run with no history at all.
export function useGlobalConversation(): string | undefined {
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    async function resolve() {
      try {
        const globalChats = await api.getConversations({ scopeGlobal: true });

        if (globalChats.length > 0) {
          // Already sorted newest-updated-first by the backend.
          if (!cancelled) setConversationId(globalChats[0].id);
          return;
        }

        const created = await api.createConversation({ projectId: null });
        if (!cancelled && created) setConversationId(created.id);
      } catch (error) {
        console.error("Failed to resolve the default global conversation:", error);
      }
    }

    resolve();

    return () => {
      cancelled = true;
    };
  }, []);

  return conversationId;
}
