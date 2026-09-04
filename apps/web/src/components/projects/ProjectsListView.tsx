import { useMemo, useState } from "react";
import type { Project } from "../../types";
import type { ProjectsController } from "../../hooks/useProjects";

interface ProjectsListViewProps {
  projects: ProjectsController;
  onSelectProject: (id: string) => void;
}

const MAX_NAME_LENGTH = 100;

// The "Projects" landing view (Objective 22/23/34) — a searchable card
// list plus a compact create form. Follows the same .focus-view/.focus-grid
// visual language the rest of the HUD already uses (Memory/Documents),
// just with a single-column card list instead of a two-column grid, since
// there's no natural "second panel" until a project is opened.
export function ProjectsListView({ projects, onSelectProject }: ProjectsListViewProps) {
  const [searchText, setSearchText] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const visibleProjects = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    if (query.length === 0) return projects.projects;
    return projects.projects.filter((p) => p.name.toLowerCase().includes(query));
  }, [projects.projects, searchText]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setCreateError("A project name is required.");
      return;
    }

    setCreating(true);
    setCreateError(null);

    const result = await projects.createProject({
      name,
      description: description.trim() || undefined,
      instructions: instructions.trim() || undefined,
    });

    setCreating(false);

    if (!result.success) {
      setCreateError(result.error ?? "Failed to create project.");
      return;
    }

    setName("");
    setDescription("");
    setInstructions("");
    setShowCreateForm(false);
  }

  return (
    <div className="focus-view">
      <h2>Projects</h2>

      <div className="project-list-controls">
        <input
          type="text"
          className="memory-search"
          placeholder="Search projects..."
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
        />

        <button type="button" className="project-new-button" onClick={() => setShowCreateForm((v) => !v)}>
          {showCreateForm ? "Cancel" : "+ New Project"}
        </button>
      </div>

      {showCreateForm && (
        <form className="project-create-form" onSubmit={handleCreate}>
          <input
            type="text"
            placeholder="Name (required)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={MAX_NAME_LENGTH}
            autoFocus
          />
          <textarea
            placeholder="Description (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
          />
          <textarea
            placeholder="Instructions (optional) — behavioral context applied while working in this project"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={2}
          />

          {createError && <p className="document-upload-error">{createError}</p>}

          <div className="memory-edit-actions">
            <button type="submit" disabled={creating}>
              {creating ? "Creating..." : "Create Project"}
            </button>
          </div>
        </form>
      )}

      <ul className="project-card-list">
        {projects.loading ? (
          <li className="document-empty">Loading...</li>
        ) : projects.error ? (
          <li className="document-empty">{projects.error}</li>
        ) : visibleProjects.length === 0 ? (
          <li className="document-empty">
            {projects.projects.length === 0 ? "No projects yet — create one to get started." : "No projects match your search."}
          </li>
        ) : (
          visibleProjects.map((project) => (
            <ProjectCard key={project.id} project={project} onSelect={() => onSelectProject(project.id)} />
          ))
        )}
      </ul>
    </div>
  );
}

function ProjectCard({ project, onSelect }: { project: Project; onSelect: () => void }) {
  return (
    <li className="project-card">
      <button type="button" className="project-card-main" onClick={onSelect}>
        <p className="project-card-name">{project.name}</p>
        {project.description && <p className="project-card-description">{project.description}</p>}
        <p className="project-card-meta">Updated {formatDate(project.updatedAt)}</p>
      </button>
    </li>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}
