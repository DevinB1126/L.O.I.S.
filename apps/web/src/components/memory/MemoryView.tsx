import { useMemo, useState } from "react";
import { MEMORY_CATEGORIES } from "../../types";
import type { MemoryCategory, MemoryRecord } from "../../types";
import type { MemoryController } from "../../hooks/useMemory";

interface MemoryViewProps {
  memory: MemoryController;
}

type SortMode = "pinned" | "newest" | "oldest" | "importance";

// The "Memory" focus view — Memory v2D turned this from a read-only list
// into a full manager: search, category/pinned filters, sort, and per-row
// pin/edit/delete/importance/category controls. Distinct from the
// always-visible "RECENT MEMORY" widget in RightPanels, which stays a
// lightweight 3-5-item list on purpose (Objective 17) — none of the
// management controls here belong there.
export function MemoryView({ memory }: MemoryViewProps) {
  const data = memory.memory;
  const allMemories = useMemo(() => data?.memories ?? [], [data]);

  const [searchText, setSearchText] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<MemoryCategory | "all">("all");
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("pinned");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  const visibleMemories = useMemo(
    () => filterAndSortMemories(allMemories, { searchText, categoryFilter, pinnedOnly, sortMode }),
    [allMemories, searchText, categoryFilter, pinnedOnly, sortMode]
  );

  const filtersActive = searchText.trim().length > 0 || categoryFilter !== "all" || pinnedOnly;

  function startEdit(record: MemoryRecord) {
    // Switching to a different row's edit without saving the previous one
    // is intentional — at most one row is ever in edit mode.
    setEditingId(record.id);
    setEditDraft(record.content);
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft("");
    setEditError(null);
  }

  async function saveEdit() {
    if (!editingId) return;

    const result = await memory.updateMemory(editingId, { content: editDraft });

    if (!result.success) {
      // Left in edit mode with the message inline (Objective 5/24) — the
      // draft is never discarded on a rejected save.
      setEditError(result.error ?? "Failed to save.");
      return;
    }

    cancelEdit();
  }

  function togglePin(record: MemoryRecord) {
    memory.updateMemory(record.id, { pinned: !record.pinned });
  }

  function changeCategory(record: MemoryRecord, category: MemoryCategory) {
    memory.updateMemory(record.id, { category });
  }

  function changeImportance(record: MemoryRecord, importance: number) {
    memory.updateMemory(record.id, { importance });
  }

  function handleDelete(record: MemoryRecord) {
    // Lightweight confirmation (Objective 7) — no custom modal framework.
    if (!window.confirm(`Delete this memory?\n\n"${record.content}"`)) return;
    memory.deleteMemory(record.id);
  }

  return (
    <div className="focus-view">
      <h2>Memory Database</h2>

      <div className="focus-grid">
        <div>
          <h3>Profile</h3>
          <p>Name: {data?.profile.name || "Unknown"}</p>
          <p>Location: {data?.profile.location || "Unknown"}</p>
          <p>Favorite Color: {data?.profile.favoriteColor || "Unknown"}</p>
          <p>Occupation: {data?.profile.occupation || "Unknown"}</p>
        </div>

        <div>
          <h3>
            Stored Facts
            {allMemories.length > 0
              ? ` (${filtersActive ? `${visibleMemories.length}/` : ""}${allMemories.length})`
              : ""}
          </h3>

          {/* Filter/sort controls sit above .memory-list as a fixed
              (flex-shrink:0) header within the Stored Facts box, so they
              stay accessible while the list itself scrolls beneath them
              (Objective 16) — same flex-chain pattern already used for the
              h3 above. */}
          <div className="memory-controls">
            <input
              type="text"
              className="memory-search"
              placeholder="Search..."
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
            />

            <select
              className="memory-category-filter"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value as MemoryCategory | "all")}
              aria-label="Filter by category"
            >
              <option value="all">All</option>
              {MEMORY_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>

            <select
              className="memory-sort"
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
              aria-label="Sort memories"
            >
              <option value="pinned">Pinned</option>
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="importance">Importance</option>
            </select>

            <button
              type="button"
              className={`memory-pin-filter ${pinnedOnly ? "active" : ""}`}
              onClick={() => setPinnedOnly((prev) => !prev)}
              title={pinnedOnly ? "Showing pinned only" : "Show pinned only"}
              aria-pressed={pinnedOnly}
            >
              ⚑
            </button>
          </div>

          <ul className="memory-list">
            {allMemories.length === 0 ? (
              <li className="memory-empty">No stored facts</li>
            ) : visibleMemories.length === 0 ? (
              <li className="memory-empty">{emptyStateMessage(searchText, categoryFilter, pinnedOnly)}</li>
            ) : (
              visibleMemories.map((record) => (
                <MemoryRow
                  key={record.id}
                  record={record}
                  isEditing={editingId === record.id}
                  editDraft={editDraft}
                  editError={editingId === record.id ? editError : null}
                  onStartEdit={() => startEdit(record)}
                  onDraftChange={setEditDraft}
                  onSaveEdit={saveEdit}
                  onCancelEdit={cancelEdit}
                  onDelete={() => handleDelete(record)}
                  onTogglePin={() => togglePin(record)}
                  onChangeCategory={(category) => changeCategory(record, category)}
                  onChangeImportance={(level) => changeImportance(record, level)}
                />
              ))
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}

interface FilterSortOptions {
  searchText: string;
  categoryFilter: MemoryCategory | "all";
  pinnedOnly: boolean;
  sortMode: SortMode;
}

// Local, deterministic filtering — no backend request, no Ollama, no
// embeddings (Objective 8/9). Sorting is presentation-only: this returns a
// new array and never touches the order memory.memories was received in
// (Objective 12).
function filterAndSortMemories(memories: MemoryRecord[], options: FilterSortOptions): MemoryRecord[] {
  const { searchText, categoryFilter, pinnedOnly, sortMode } = options;
  const query = searchText.trim().toLowerCase();

  const filtered = memories.filter((record) => {
    if (pinnedOnly && !record.pinned) return false;
    if (categoryFilter !== "all" && record.category !== categoryFilter) return false;

    if (query.length > 0) {
      const matchesContent = record.content.toLowerCase().includes(query);
      const matchesCategory = record.category.toLowerCase().includes(query);
      if (!matchesContent && !matchesCategory) return false;
    }

    return true;
  });

  const sorted = [...filtered];

  sorted.sort((a, b) => {
    if (sortMode === "pinned") {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    }

    if (sortMode === "newest") return b.updatedAt.localeCompare(a.updatedAt);
    if (sortMode === "oldest") return a.updatedAt.localeCompare(b.updatedAt);

    // importance
    if (b.importance !== a.importance) return b.importance - a.importance;
    return b.updatedAt.localeCompare(a.updatedAt);
  });

  return sorted;
}

function emptyStateMessage(searchText: string, categoryFilter: MemoryCategory | "all", pinnedOnly: boolean): string {
  if (searchText.trim().length > 0) return "No memories match your search.";
  if (pinnedOnly) return "No pinned memories yet.";
  if (categoryFilter !== "all") return "No memories in this category.";
  return "No stored facts";
}

interface MemoryRowProps {
  record: MemoryRecord;
  isEditing: boolean;
  editDraft: string;
  editError: string | null;
  onStartEdit: () => void;
  onDraftChange: (value: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
  onChangeCategory: (category: MemoryCategory) => void;
  onChangeImportance: (level: number) => void;
}

const IMPORTANCE_LEVELS = [1, 2, 3, 4, 5];

function MemoryRow({
  record,
  isEditing,
  editDraft,
  editError,
  onStartEdit,
  onDraftChange,
  onSaveEdit,
  onCancelEdit,
  onDelete,
  onTogglePin,
  onChangeCategory,
  onChangeImportance,
}: MemoryRowProps) {
  if (isEditing) {
    return (
      <li className="memory-row memory-row--editing">
        <textarea
          className="memory-edit-input"
          value={editDraft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            // Enter-to-save (Shift+Enter for a newline), matching the
            // chat command input's convention — Escape cancels. Never
            // lets a keystroke here reach the chat input.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSaveEdit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancelEdit();
            }
          }}
          rows={2}
          autoFocus
        />

        {editError && <p className="memory-edit-error">{editError}</p>}

        <div className="memory-edit-actions">
          <button type="button" onClick={onSaveEdit}>
            Save
          </button>
          <button type="button" onClick={onCancelEdit}>
            Cancel
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className={`memory-row ${record.pinned ? "pinned" : ""}`}>
      <div className="memory-row-main">
        <p className="memory-content">{record.content}</p>

        <div className="memory-meta">
          <select
            className="memory-category-badge"
            value={record.category}
            onChange={(e) => onChangeCategory(e.target.value as MemoryCategory)}
            aria-label="Category"
          >
            {MEMORY_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>

          <div className="memory-importance" role="group" aria-label={`Importance: ${record.importance} of 5`}>
            {IMPORTANCE_LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                className={`memory-importance-dot ${level <= record.importance ? "filled" : ""}`}
                onClick={() => onChangeImportance(level)}
                aria-label={`Set importance to ${level}`}
                title={`Importance ${level}`}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="memory-row-actions">
        <button
          type="button"
          className={`memory-pin-button ${record.pinned ? "active" : ""}`}
          onClick={onTogglePin}
          title={record.pinned ? "Unpin" : "Pin"}
          aria-pressed={record.pinned}
        >
          ⚑
        </button>
        <button type="button" className="memory-edit-button" onClick={onStartEdit} title="Edit">
          ✎
        </button>
        <button type="button" className="memory-delete-button" onClick={onDelete} title="Delete">
          ×
        </button>
      </div>
    </li>
  );
}
