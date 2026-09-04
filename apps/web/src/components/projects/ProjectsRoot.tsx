import { useState } from "react";
import type { Agent } from "../../types";
import type { VoiceController } from "../../hooks/useVoice";
import { useProjects } from "../../hooks/useProjects";
import { ProjectsListView } from "./ProjectsListView";
import { ProjectWorkspaceView } from "./ProjectWorkspaceView";
import { ProjectChatView } from "./ProjectChatView";

interface ProjectsRootProps {
  agent: Agent;
  currentAgentLabel: string;
  voice: VoiceController;
  voiceLabel: string;
}

// Projects v1A — the top-level state machine for the "Projects" HudView:
// project list -> project workspace -> (optional) an open chat inside that
// project. Objective 26: switching between any of these three states is
// the ONLY thing that changes which project/chat is "active" — nothing
// here caches stale scope across a switch, since each child component
// re-fetches from the backend keyed on the id it's currently given.
export function ProjectsRoot({ agent, currentAgentLabel, voice, voiceLabel }: ProjectsRootProps) {
  const projects = useProjects();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);

  function openProject(id: string) {
    setSelectedProjectId(id);
    setSelectedChatId(null);
  }

  function backToList() {
    setSelectedProjectId(null);
    setSelectedChatId(null);
  }

  function backToWorkspace() {
    setSelectedChatId(null);
  }

  const selectedProject = selectedProjectId ? projects.projects.find((p) => p.id === selectedProjectId) ?? null : null;

  // A project can vanish out from under an open workspace (archived from
  // another view, deleted) — fall back to the list rather than rendering a
  // workspace for a project that no longer resolves.
  if (selectedProjectId && !selectedProject && !projects.loading) {
    backToList();
    return null;
  }

  if (selectedProjectId && selectedChatId && selectedProject) {
    return (
      <ProjectChatView
        project={selectedProject}
        conversationId={selectedChatId}
        agent={agent}
        currentAgentLabel={currentAgentLabel}
        voice={voice}
        voiceLabel={voiceLabel}
        onBack={backToWorkspace}
      />
    );
  }

  if (selectedProjectId && selectedProject) {
    return (
      <ProjectWorkspaceView
        project={selectedProject}
        projects={projects}
        onBack={backToList}
        onOpenChat={setSelectedChatId}
      />
    );
  }

  return <ProjectsListView projects={projects} onSelectProject={openProject} />;
}
