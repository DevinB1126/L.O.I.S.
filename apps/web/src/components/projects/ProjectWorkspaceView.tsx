import { useEffect, useState } from "react";
import type { ConversationSummary, Project } from "../../types";
import type { ProjectsController } from "../../hooks/useProjects";
import { useProjectChats } from "../../hooks/useProjectChats";
import { useDocuments } from "../../hooks/useDocuments";
import { DocumentsView } from "../documents/DocumentsView";

interface ProjectWorkspaceViewProps {
  project: Project;
  projects: ProjectsController;
  onBack: () => void;
  onOpenChat: (chatId: string) => void;
}

// The open-project workspace (Objective 24) — header with New Chat/Add
// Existing Chat/Documents/Settings, then the project's own chat list.
// Reuses the existing .focus-view/.focus-grid HUD language rather than the
// exact ChatGPT/Claude-style layout the task explicitly says not to copy.
export function ProjectWorkspaceView({ project, projects, onBack, onOpenChat }: ProjectWorkspaceViewProps) {
  const chats = useProjectChats(project.id);
  // Reuses the exact same Documents v1A hook/component the global Documents
  // view uses (Objective 32 of Projects v1A: "extend DocumentRecord with
  // projectId" — no new upload/parsing/preview code, just scoping) —
  // parameterized by this project's id so its list, uploads, and preview
  // are all automatically confined to this project's own documents.
  const documents = useDocuments(project.id);
  const [showSettings, setShowSettings] = useState(false);
  const [showAddExisting, setShowAddExisting] = useState(false);
  const [showDocuments, setShowDocuments] = useState(false);

  async function handleNewChat() {
    const created = await chats.createChat();
    if (created) onOpenChat(created.id);
  }

  function handleRename(chat: ConversationSummary) {
    const nextTitle = window.prompt("Rename chat:", chat.title);
    if (nextTitle === null) return;
    chats.renameChat(chat.id, nextTitle);
  }

  function handleDelete(chat: ConversationSummary) {
    if (!window.confirm(`Delete "${chat.title}"? This removes the chat and its messages entirely.`)) return;
    chats.deleteChat(chat.id);
  }

  function handleRemoveFromProject(chat: ConversationSummary) {
    if (!window.confirm(`Remove "${chat.title}" from this project? The chat itself is kept, in Global Chats.`)) return;
    chats.removeChatFromProject(chat.id);
  }

  // Documents replaces the whole workspace body (rather than stacking
  // alongside the chat list/settings) — DocumentsView is already a full
  // two-column upload+list+preview layout on its own, and showing it next
  // to the chat list would make this panel unreasonably tall. Mirrors how
  // opening a chat itself takes over the view (see ProjectChatView).
  if (showDocuments) {
    return (
      <div className="focus-view">
        <div className="project-workspace-header">
          <button type="button" className="project-back-button" onClick={() => setShowDocuments(false)} title="Back to project workspace">
            ← {project.name}
          </button>
        </div>

        <DocumentsView documents={documents} />
      </div>
    );
  }

  return (
    <div className="focus-view">
      <div className="project-workspace-header">
        <button type="button" className="project-back-button" onClick={onBack} title="Back to Projects">
          ← Projects
        </button>

        <div className="project-workspace-title">
          <h2>{project.name}</h2>
          {project.description && <p className="project-workspace-description">{project.description}</p>}
        </div>
      </div>

      <div className="project-workspace-actions">
        <button type="button" onClick={handleNewChat}>
          + New Chat
        </button>
        <button type="button" onClick={() => setShowAddExisting((v) => !v)}>
          {showAddExisting ? "Cancel" : "Add Existing Chat"}
        </button>
        <button type="button" onClick={() => setShowDocuments(true)}>
          Documents{documents.documents.length > 0 ? ` (${documents.documents.length})` : ""}
        </button>
        <button type="button" onClick={() => setShowSettings((v) => !v)}>
          {showSettings ? "Close Settings" : "Project Settings"}
        </button>
      </div>

      {showSettings && (
        <ProjectSettingsPanel
          project={project}
          projects={projects}
          onArchived={onBack}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showAddExisting && (
        <AddExistingChatPanel
          chats={chats}
          onDone={() => setShowAddExisting(false)}
        />
      )}

      <h3 className="project-chats-heading">Chats{chats.chats.length > 0 ? ` (${chats.chats.length})` : ""}</h3>

      <ul className="documents-list project-chat-list">
        {chats.loading ? (
          <li className="document-empty">Loading...</li>
        ) : chats.error ? (
          <li className="document-empty">{chats.error}</li>
        ) : chats.chats.length === 0 ? (
          <li className="document-empty">No chats yet — start a New Chat or Add Existing Chat.</li>
        ) : (
          chats.chats.map((chat) => (
            <li key={chat.id} className="document-row project-chat-row">
              <button type="button" className="document-row-main" onClick={() => onOpenChat(chat.id)}>
                <p className="document-name">{chat.title}</p>
                <div className="document-meta">
                  <span>{chat.messageCount} messages</span>
                  <span>{formatDate(chat.updatedAt)}</span>
                  {chat.copiedFromConversationId && <span className="document-type-badge">COPY</span>}
                </div>
              </button>

              <div className="project-chat-row-actions">
                <button type="button" className="document-delete-button" onClick={() => handleRename(chat)} title="Rename">
                  ✎
                </button>
                <button
                  type="button"
                  className="document-delete-button"
                  onClick={() => handleRemoveFromProject(chat)}
                  title="Remove from project (keeps the chat, returns it to Global Chats)"
                >
                  ⇤
                </button>
                <button type="button" className="document-delete-button" onClick={() => handleDelete(chat)} title="Delete chat entirely">
                  ×
                </button>
              </div>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

interface ProjectSettingsPanelProps {
  project: Project;
  projects: ProjectsController;
  onArchived: () => void;
  onClose: () => void;
}

// Objective 27/28 — rename/description/instructions, plus archive. No
// permissions/sharing (single-user local app, out of scope per the task).
function ProjectSettingsPanel({ project, projects, onArchived, onClose }: ProjectSettingsPanelProps) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [instructions, setInstructions] = useState(project.instructions);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Keep the form in sync if a different project's settings panel opens
  // without this component ever unmounting (defensive — ProjectWorkspaceView
  // does key off project.id changes via a full re-render today, but this
  // avoids the panel ever showing stale drafts if that ever changes).
  useEffect(() => {
    setName(project.name);
    setDescription(project.description);
    setInstructions(project.instructions);
  }, [project.id, project.name, project.description, project.instructions]);

  async function handleSave() {
    setSaving(true);
    setError(null);

    const result = await projects.updateProject(project.id, { name, description, instructions });

    setSaving(false);

    if (!result.success) {
      setError(result.error ?? "Failed to save project settings.");
    }
  }

  async function handleArchive() {
    if (!window.confirm(`Archive "${project.name}"? It stays fully recoverable from an archived-projects view later.`)) return;
    await projects.archiveProject(project.id);
    onArchived();
  }

  return (
    <div className="project-settings-panel">
      <label>
        Name
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Description
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
      </label>
      <label>
        Instructions
        <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} />
      </label>

      {error && <p className="document-upload-error">{error}</p>}

      <div className="memory-edit-actions">
        <button type="button" onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </button>
        <button type="button" onClick={onClose}>
          Close
        </button>
        <button type="button" className="project-archive-button" onClick={handleArchive}>
          Archive Project
        </button>
      </div>
    </div>
  );
}

interface AddExistingChatPanelProps {
  chats: ReturnType<typeof useProjectChats>;
  onDone: () => void;
}

// Objective 14/15/16 — lists existing global/unassigned chats and lets the
// user either MOVE (reassigns the same chat) or COPY (creates a distinct
// new chat here, original untouched) it into this project. The distinction
// is always two separate, clearly-labeled buttons — never a single
// ambiguous "Add" action.
function AddExistingChatPanel({ chats, onDone }: AddExistingChatPanelProps) {
  const [globalChats, setGlobalChats] = useState<ConversationSummary[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    chats.fetchGlobalChats().then((list) => {
      if (!cancelled) setGlobalChats(list);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleMove(id: string) {
    setBusyId(id);
    await chats.moveChatIntoProject(id);
    setBusyId(null);
    setGlobalChats((prev) => (prev ? prev.filter((c) => c.id !== id) : prev));
  }

  async function handleCopy(id: string) {
    setBusyId(id);
    await chats.copyChatIntoProject(id);
    setBusyId(null);
    // The original stays global (Objective 16) — no removal from the list.
  }

  return (
    <div className="project-settings-panel">
      <p className="project-add-existing-hint">
        Global Chats not currently in any project. <strong>Move</strong> reassigns the chat here; <strong>Copy</strong> leaves
        the original untouched and creates a new copy here.
      </p>

      <ul className="documents-list">
        {globalChats === null ? (
          <li className="document-empty">Loading...</li>
        ) : globalChats.length === 0 ? (
          <li className="document-empty">No unassigned chats available.</li>
        ) : (
          globalChats.map((chat) => (
            <li key={chat.id} className="document-row project-chat-row">
              <div className="document-row-main">
                <p className="document-name">{chat.title}</p>
                <div className="document-meta">
                  <span>{chat.messageCount} messages</span>
                  <span>{formatDate(chat.updatedAt)}</span>
                </div>
              </div>

              <div className="project-chat-row-actions">
                <button type="button" disabled={busyId === chat.id} onClick={() => handleMove(chat.id)}>
                  Move
                </button>
                <button type="button" disabled={busyId === chat.id} onClick={() => handleCopy(chat.id)}>
                  Copy
                </button>
              </div>
            </li>
          ))
        )}
      </ul>

      <div className="memory-edit-actions">
        <button type="button" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}
