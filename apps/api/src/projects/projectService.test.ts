// Unit tests for Projects v1A's project data model and persistence.
// Uses Node's built-in test runner, always against a throwaway temp
// directory via __setProjectDataDirForTesting — never the real
// apps/api/data/projects/.
//
// Run with: npm run test --workspace=api

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  __setProjectDataDirForTesting,
  __resetProjectDataDirForTesting,
  initProjectStorage,
  listProjects,
  getProjectById,
  createProject,
  updateProject,
  archiveProject,
  unarchiveProject,
  deleteProject,
} from "./projectService";

function withTempProjectDataDir(run: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lois-projects-test-"));
  __setProjectDataDirForTesting(dir);
  initProjectStorage();

  try {
    run(dir);
  } finally {
    __resetProjectDataDirForTesting();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("createProject requires a non-empty name and rejects an empty one", () => {
  withTempProjectDataDir(() => {
    const result = createProject({ name: "   " });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "invalid_name");
  });
});

test("createProject creates a project with a stable UUID, defaults, and timestamps", () => {
  withTempProjectDataDir(() => {
    const result = createProject({ name: "Valour", description: "Tactical card game", instructions: "Be canonical." });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.match(result.project.id, /^[0-9a-f-]{36}$/);
    assert.equal(result.project.name, "Valour");
    assert.equal(result.project.description, "Tactical card game");
    assert.equal(result.project.instructions, "Be canonical.");
    assert.equal(result.project.contextSummary, "");
    assert.equal(result.project.archived, false);
    assert.equal(result.project.createdAt, result.project.updatedAt);
  });
});

test("two projects can share a name but get distinct ids", () => {
  withTempProjectDataDir(() => {
    const a = createProject({ name: "Minecraft" });
    const b = createProject({ name: "Minecraft" });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    if (!a.ok || !b.ok) return;
    assert.notEqual(a.project.id, b.project.id);
  });
});

test("listProjects excludes archived by default, includes them with includeArchived", () => {
  withTempProjectDataDir(() => {
    const a = createProject({ name: "Active Project" });
    const b = createProject({ name: "Archived Project" });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    if (!a.ok || !b.ok) return;

    archiveProject(b.project.id);

    const activeOnly = listProjects();
    assert.equal(activeOnly.length, 1);
    assert.equal(activeOnly[0].id, a.project.id);

    const all = listProjects({ includeArchived: true });
    assert.equal(all.length, 2);
  });
});

test("renaming/editing a project via updateProject", () => {
  withTempProjectDataDir(() => {
    const created = createProject({ name: "LOIS Dev" });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const updated = updateProject(created.project.id, {
      name: "LOIS Development",
      description: "Local AI assistant development",
      instructions: "Treat this repo as canonical.",
    });

    assert.equal(updated.ok, true);
    if (!updated.ok) return;
    assert.equal(updated.project.name, "LOIS Development");
    assert.equal(updated.project.description, "Local AI assistant development");
    assert.equal(updated.project.instructions, "Treat this repo as canonical.");
  });
});

test("updateProject rejects an empty name and leaves the project unchanged", () => {
  withTempProjectDataDir(() => {
    const created = createProject({ name: "Career" });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const result = updateProject(created.project.id, { name: "   " });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "invalid_name");

    assert.equal(getProjectById(created.project.id)?.name, "Career");
  });
});

test("updateProject on an unknown id reports not_found", () => {
  withTempProjectDataDir(() => {
    const result = updateProject("00000000-0000-0000-0000-000000000000", { name: "X" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "not_found");
  });
});

test("archive/unarchive round-trip", () => {
  withTempProjectDataDir(() => {
    const created = createProject({ name: "Personal Finance" });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    assert.equal(archiveProject(created.project.id), true);
    assert.equal(getProjectById(created.project.id)?.archived, true);
    assert.equal(listProjects().find((p) => p.id === created.project.id), undefined);

    assert.equal(unarchiveProject(created.project.id), true);
    assert.equal(getProjectById(created.project.id)?.archived, false);
    assert.ok(listProjects().find((p) => p.id === created.project.id));
  });
});

test("deleteProject removes the record entirely", () => {
  withTempProjectDataDir(() => {
    const created = createProject({ name: "To Delete" });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    assert.equal(deleteProject(created.project.id), true);
    assert.equal(getProjectById(created.project.id), undefined);
    assert.equal(deleteProject(created.project.id), false, "deleting again reports failure, not a crash");
  });
});

test("the project index survives a fresh read (restart persistence)", () => {
  withTempProjectDataDir(() => {
    const created = createProject({ name: "Persisted Project" });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const reloaded = getProjectById(created.project.id);
    assert.ok(reloaded);
    assert.equal(reloaded?.name, "Persisted Project");
  });
});

test("adding a project does not erase other projects (index write safety)", () => {
  withTempProjectDataDir(() => {
    const a = createProject({ name: "First" });
    const b = createProject({ name: "Second" });
    const c = createProject({ name: "Third" });
    assert.equal(a.ok && b.ok && c.ok, true);

    assert.equal(listProjects().length, 3);
  });
});

test("malformed entries in index.json are dropped without crashing the whole list", () => {
  withTempProjectDataDir((dir) => {
    const created = createProject({ name: "Good Project" });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const indexPath = path.join(dir, "index.json");
    const raw = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    raw.projects.push({ id: "not-a-real-record" });
    fs.writeFileSync(indexPath, JSON.stringify(raw, null, 2));

    const projects = listProjects();
    assert.equal(projects.length, 1);
    assert.equal(projects[0].id, created.project.id);
  });
});
