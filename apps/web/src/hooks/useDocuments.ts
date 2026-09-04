import { useCallback, useEffect, useState } from "react";
import * as api from "../services/api";
import type { DocumentRecord } from "../types";

// Documents v1A — a focused hook (Objective 20) mirroring useMemory's
// shape: state plus the actions that mutate it, so DocumentsView takes one
// cohesive object instead of a pile of unrelated props. No Redux/Zustand.
//
// Projects v1A follow-up: accepts an optional projectId so the SAME hook
// serves both the global Documents view (all documents, unfiltered — the
// original behavior, unchanged) and a project's own document panel (only
// that project's documents, uploads scoped to it automatically) — same
// reuse pattern already established for useChat/ChatTranscript.
export interface DocumentsController {
  documents: DocumentRecord[];
  loading: boolean;
  error: string | null;
  uploadDocument: (file: File) => Promise<{ success: boolean; error?: string }>;
  deleteDocument: (id: string) => Promise<void>;
  refreshDocuments: () => Promise<void>;
  selectedDocument: DocumentRecord | null;
  selectDocument: (id: string | null) => void;
  documentContent: string | null;
  contentMessage: string | null;
  contentLoading: boolean;
  fetchDocumentContent: (id: string) => Promise<void>;
}

export function useDocuments(projectId?: string): DocumentsController {
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [documentContent, setDocumentContent] = useState<string | null>(null);
  const [contentMessage, setContentMessage] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);

  const refreshDocuments = useCallback(async () => {
    setLoading(true);

    try {
      const list = await api.getDocuments(projectId ? { projectId } : {});
      setDocuments(list);
      setError(null);
    } catch {
      setError("Could not reach LOIS core. Is the backend running?");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    refreshDocuments();
  }, [refreshDocuments]);

  const fetchDocumentContent = useCallback(async (id: string) => {
    setContentLoading(true);
    setDocumentContent(null);
    setContentMessage(null);

    const result = await api.getDocumentContent(id);

    setDocumentContent(result.content);
    setContentMessage(result.message ?? null);
    setContentLoading(false);
  }, []);

  const selectDocument = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      setDocumentContent(null);
      setContentMessage(null);

      if (id) {
        fetchDocumentContent(id);
      }
    },
    [fetchDocumentContent]
  );

  const uploadDocument = useCallback(
    async (file: File) => {
      const result = await api.uploadDocument(file, projectId);

      // Refresh either way — even a rejected upload doesn't change the
      // list, but this keeps behavior simple and matches useMemory's
      // "reload after every mutation attempt that could have changed
      // state" posture.
      await refreshDocuments();

      return { success: result.success, error: result.error };
    },
    [refreshDocuments, projectId]
  );

  const deleteDocument = useCallback(
    async (id: string) => {
      const success = await api.deleteDocument(id);

      if (success) {
        // Update the list locally without waiting on a refetch (Objective
        // 21: "delete updates the list without requiring a full page
        // refresh") — refreshDocuments() still runs after for consistency
        // with the real backend state, but the UI doesn't wait on it.
        setDocuments((prev) => prev.filter((d) => d.id !== id));

        if (selectedId === id) {
          setSelectedId(null);
          setDocumentContent(null);
          setContentMessage(null);
        }
      } else {
        setError("Failed to delete this document.");
      }

      await refreshDocuments();
    },
    [refreshDocuments, selectedId]
  );

  const selectedDocument = documents.find((d) => d.id === selectedId) ?? null;

  return {
    documents,
    loading,
    error,
    uploadDocument,
    deleteDocument,
    refreshDocuments,
    selectedDocument,
    selectDocument,
    documentContent,
    contentMessage,
    contentLoading,
    fetchDocumentContent,
  };
}
