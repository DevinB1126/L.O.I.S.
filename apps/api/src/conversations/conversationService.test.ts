// Unit tests for Projects v1A's conversation/chat model and persistence:
// CRUD, migration from the legacy flat memory.json conversation log, move/
// copy/remove-from-project, and restart persistence. Uses Node's built-in
// test runner, always against throwaway temp directories via
// __setConversationDataDirForTesting / __setMemoryPathForTesting — never
// real user data.
//
// Run with: npm run test --workspace=api

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  __setConversationDataDirForTesting,
  __resetConversationDataDirForTesting,
  initConversationStorage,
  listConversations,
  getConversationById,
  createConversation,
  renameConversation,
  deleteConversation,
  appendTurn,
  clearMessages,
  setConversationProject,
  copyConversationToProject,
  removeAllFromProject,
  conversationCountForProject,
} from "./conversationService";
import { __setMemoryPathForTesting, __resetMemoryPathForTesting } from "../memory/memoryService";

function withTempConversationDataDir(run: (dir: string) => void) {
  const convDir = fs.mkdtempSync(path.join(os.tmpdir(), "lois-conversations-test-"));
  // conversationService's migration reads legacy conversations via
  // memoryService.readMemory() — point that at an isolated (nonexistent,
  // so effectively empty) memory file too, so migration tests are
  // hermetic and never touch the real memory.json.
  const memDir = fs.mkdtempSync(path.join(os.tmpdir(), "lois-conv-memory-test-"));
  const memoryFilePath = path.join(memDir, "memory.json");

  __setConversationDataDirForTesting(convDir);
  __setMemoryPathForTesting(memoryFilePath);

  try {
    run(convDir);
  } finally {
    __resetConversationDataDirForTesting();
    __resetMemoryPathForTesting();
    fs.rmSync(convDir, { recursive: true, force: true });
    fs.rmSync(memDir, { recursive: true, force: true });
  }
}

test("initConversationStorage with no legacy history starts with an empty index", () => {
  withTempConversationDataDir(() => {
    initConversationStorage();
    assert.deepEqual(listConversations(), []);
  });
});

test("createConversation creates an empty global chat with a stable id and default title", () => {
  withTempConversationDataDir(() => {
    initConversationStorage();
    const conversation = createConversation();

    assert.match(conversation.id, /^[0-9a-f-]{36}$/);
    assert.equal(conversation.title, "New Chat");
    assert.equal(conversation.projectId, null);
    assert.deepEqual(conversation.messages, []);
  });
});

test("createConversation assigns the given projectId and title", () => {
  withTempConversationDataDir(() => {
    initConversationStorage();
    const conversation = createConversation({ projectId: "proj-1", title: "Architecture Planning" });

    assert.equal(conversation.projectId, "proj-1");
    assert.equal(conversation.title, "Architecture Planning");
  });
});

test("appendTurn adds a user+assistant message pair and auto-titles a fresh 'New Chat'", () => {
  withTempConversationDataDir(() => {
    initConversationStorage();
    const conversation = createConversation();

    const updated = appendTurn(conversation.id, "lois", "What is the capital of France?", "Paris.");
    assert.ok(updated);
    assert.equal(updated?.messages.length, 2);
    assert.equal(updated?.messages[0].role, "user");
    assert.equal(updated?.messages[0].text, "What is the capital of France?");
    assert.equal(updated?.messages[1].role, "assistant");
    assert.equal(updated?.messages[1].agent, "lois");
    assert.equal(updated?.messages[1].text, "Paris.");
    assert.equal(updated?.title, "What is the capital of France?");
  });
});

test("appendTurn does not re-title a conversation that already has a custom title", () => {
  withTempConversationDataDir(() => {
    initConversationStorage();
    const conversation = createConversation({ title: "My Custom Title" });
    const updated = appendTurn(conversation.id, "ignis", "hello", "hi there");
    assert.equal(updated?.title, "My Custom Title");
  });
});

test("multiple chats stay independent — appending to one never touches another", () => {
  withTempConversationDataDir(() => {
    initConversationStorage();
    const a = createConversation({ title: "Voice Architecture" });
    const b = createConversation({ title: "Memory Architecture" });

    appendTurn(a.id, "lois", "voice question", "voice answer");

    const reloadedA = getConversationById(a.id);
    const reloadedB = getConversationById(b.id);

    assert.equal(reloadedA?.messages.length, 2);
    assert.equal(reloadedB?.messages.length, 0, "Chat B must not see Chat A's transcript");
  });
});

test("renameConversation updates the title, rejects an empty one", () => {
  withTempConversationDataDir(() => {
    initConversationStorage();
    const conversation = createConversation();

    const renamed = renameConversation(conversation.id, "Voice Integration");
    assert.equal(renamed.ok, true);
    if (renamed.ok) assert.equal(renamed.conversation.title, "Voice Integration");

    const rejected = renameConversation(conversation.id, "   ");
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.reason, "invalid_title");
  });
});

test("deleteConversation removes it entirely and does not affect other chats", () => {
  withTempConversationDataDir(() => {
    initConversationStorage();
    const keep = createConversation({ title: "Keep Me" });
    const remove = createConversation({ title: "Remove Me" });

    assert.equal(deleteConversation(remove.id), true);
    assert.equal(getConversationById(remove.id), undefined);
    assert.ok(getConversationById(keep.id));
    assert.equal(deleteConversation(remove.id), false);
  });
});

test("clearMessages empties the transcript but keeps the conversation record", () => {
  withTempConversationDataDir(() => {
    initConversationStorage();
    const conversation = createConversation({ title: "Keep This Title" });
    appendTurn(conversation.id, "lois", "hi", "hello");

    assert.equal(clearMessages(conversation.id), true);

    const reloaded = getConversationById(conversation.id);
    assert.equal(reloaded?.messages.length, 0);
    assert.equal(reloaded?.title, "Keep This Title", "clearing messages is not the same as deleting the chat");
  });
});

test("setConversationProject moves a chat into a project — same id, messages, title preserved", () => {
  withTempConversationDataDir(() => {
    initConversationStorage();
    const conversation = createConversation({ title: "Move Me" });
    appendTurn(conversation.id, "lois", "hi", "hello");

    const moved = setConversationProject(conversation.id, "project-abc");
    assert.ok(moved);
    assert.equal(moved?.id, conversation.id, "move must not change the conversation's id");
    assert.equal(moved?.projectId, "project-abc");
    assert.equal(moved?.title, "Move Me");
    assert.equal(moved?.messages.length, 2, "messages must be preserved, not rewritten");

    // No duplicate remains among global/unassigned chats.
    assert.equal(listConversations({ projectId: null }).find((c) => c.id === conversation.id), undefined);
    assert.ok(listConversations({ projectId: "project-abc" }).find((c) => c.id === conversation.id));
  });
});

test("setConversationProject(id, null) removes a chat from its project back to global", () => {
  withTempConversationDataDir(() => {
    initConversationStorage();
    const conversation = createConversation({ projectId: "project-abc" });

    const removed = setConversationProject(conversation.id, null);
    assert.equal(removed?.projectId, null);
    assert.ok(listConversations({ projectId: null }).find((c) => c.id === conversation.id));
  });
});

test("copyConversationToProject creates a new id, preserves messages, leaves the original untouched", () => {
  withTempConversationDataDir(() => {
    initConversationStorage();
    const original = createConversation({ title: "Original Chat" });
    appendTurn(original.id, "lois", "hi", "hello");
    appendTurn(original.id, "ignis", "how's it going", "good");

    const copy = copyConversationToProject(original.id, "project-xyz");
    assert.ok(copy);
    assert.notEqual(copy?.id, original.id, "copy must get a new id");
    assert.equal(copy?.projectId, "project-xyz");
    assert.equal(copy?.title, "Original Chat");
    assert.equal(copy?.messages.length, 4);
    assert.equal(copy?.copiedFromConversationId, original.id);

    // The original is completely untouched (still global, still has its
    // own messages, not deleted).
    const reloadedOriginal = getConversationById(original.id);
    assert.equal(reloadedOriginal?.projectId, null);
    assert.equal(reloadedOriginal?.messages.length, 4);

    // Mutating the copy's messages array must never affect the original —
    // proves a deep copy, not a shared reference.
    appendTurn(copy!.id, "lois", "new message in copy", "reply in copy");
    assert.equal(getConversationById(original.id)?.messages.length, 4);
    assert.equal(getConversationById(copy!.id)?.messages.length, 6);
  });
});

test("copyConversationToProject on an unknown id returns null", () => {
  withTempConversationDataDir(() => {
    initConversationStorage();
    assert.equal(copyConversationToProject("00000000-0000-0000-0000-000000000000", "project-xyz"), null);
  });
});

test("removeAllFromProject returns every one of a project's chats to global", () => {
  withTempConversationDataDir(() => {
    initConversationStorage();
    const a = createConversation({ projectId: "project-to-delete" });
    const b = createConversation({ projectId: "project-to-delete" });
    const unrelated = createConversation({ projectId: "other-project" });

    const count = removeAllFromProject("project-to-delete");
    assert.equal(count, 2);

    assert.equal(getConversationById(a.id)?.projectId, null);
    assert.equal(getConversationById(b.id)?.projectId, null);
    assert.equal(getConversationById(unrelated.id)?.projectId, "other-project", "unrelated project's chats untouched");
  });
});

test("listConversations filters by projectId, and lists metadata only (no messages)", () => {
  withTempConversationDataDir(() => {
    initConversationStorage();
    const globalChat = createConversation({ title: "Global" });
    const projectChat = createConversation({ projectId: "proj-1", title: "Project Chat" });
    appendTurn(projectChat.id, "lois", "hi", "hello");

    const globalList = listConversations({ projectId: null });
    assert.equal(globalList.length, 1);
    assert.equal(globalList[0].id, globalChat.id);

    const projectList = listConversations({ projectId: "proj-1" });
    assert.equal(projectList.length, 1);
    assert.equal(projectList[0].id, projectChat.id);
    assert.equal(projectList[0].messageCount, 2);
    assert.equal((projectList[0] as unknown as Record<string, unknown>).messages, undefined);
  });
});

test("conversationCountForProject counts only that project's chats", () => {
  withTempConversationDataDir(() => {
    initConversationStorage();
    createConversation({ projectId: "proj-a" });
    createConversation({ projectId: "proj-a" });
    createConversation({ projectId: "proj-b" });
    createConversation();

    assert.equal(conversationCountForProject("proj-a"), 2);
    assert.equal(conversationCountForProject("proj-b"), 1);
  });
});

test("the conversation index survives a fresh read (restart persistence)", () => {
  withTempConversationDataDir(() => {
    initConversationStorage();
    const conversation = createConversation({ title: "Persisted" });
    appendTurn(conversation.id, "lois", "hi", "hello");

    const reloaded = getConversationById(conversation.id);
    assert.ok(reloaded);
    assert.equal(reloaded?.title, "Persisted");
    assert.equal(reloaded?.messages.length, 2);
  });
});

test("malformed entries in index.json are dropped without crashing the whole list", () => {
  withTempConversationDataDir((dir) => {
    initConversationStorage();
    const good = createConversation({ title: "Good Chat" });

    const indexPath = path.join(dir, "index.json");
    const raw = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    raw.conversations.push({ id: "not-a-real-record" });
    fs.writeFileSync(indexPath, JSON.stringify(raw, null, 2));

    const conversations = listConversations();
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0].id, good.id);
  });
});

// ============================================================
// Migration from the legacy flat memory.json conversation log
// ============================================================

test("migration wraps existing legacy conversations into one 'General' chat, preserving every message and timestamp", () => {
  const convDir = fs.mkdtempSync(path.join(os.tmpdir(), "lois-conversations-migration-test-"));
  const memDir = fs.mkdtempSync(path.join(os.tmpdir(), "lois-conv-memory-migration-test-"));
  const memoryFilePath = path.join(memDir, "memory.json");

  const legacyMemoryFile = {
    schemaVersion: 4,
    profile: { name: "Devin", favoriteColor: "", location: "", occupation: "" },
    preferences: [],
    projects: [],
    goals: [],
    memories: [],
    calendar: [],
    conversations: [
      { agent: "lois", userMessage: "Say hi.", assistantReply: "Hello, Devin.", timestamp: "2026-06-01T00:00:00.000Z" },
      { agent: "ignis", userMessage: "What's 2+2?", assistantReply: "4.", timestamp: "2026-06-01T00:05:00.000Z" },
    ],
  };

  fs.writeFileSync(memoryFilePath, JSON.stringify(legacyMemoryFile, null, 2));

  __setConversationDataDirForTesting(convDir);
  __setMemoryPathForTesting(memoryFilePath);

  try {
    initConversationStorage();

    const conversations = listConversations();
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0].projectId, null, "migrated chat must never be auto-assigned to a project");
    assert.equal(conversations[0].messageCount, 4);

    const full = getConversationById(conversations[0].id);
    assert.equal(full?.messages[0].role, "user");
    assert.equal(full?.messages[0].text, "Say hi.");
    assert.equal(full?.messages[0].timestamp, "2026-06-01T00:00:00.000Z");
    assert.equal(full?.messages[1].role, "assistant");
    assert.equal(full?.messages[1].agent, "lois");
    assert.equal(full?.messages[1].text, "Hello, Devin.");
    assert.equal(full?.messages[2].role, "user");
    assert.equal(full?.messages[2].text, "What's 2+2?");
    assert.equal(full?.messages[3].agent, "ignis");
    assert.equal(full?.messages[3].text, "4.");
  } finally {
    __resetConversationDataDirForTesting();
    __resetMemoryPathForTesting();
    fs.rmSync(convDir, { recursive: true, force: true });
    fs.rmSync(memDir, { recursive: true, force: true });
  }
});

test("migration never re-runs once conversations/index.json already exists", () => {
  const convDir = fs.mkdtempSync(path.join(os.tmpdir(), "lois-conversations-no-remigrate-test-"));
  const memDir = fs.mkdtempSync(path.join(os.tmpdir(), "lois-conv-memory-no-remigrate-test-"));
  const memoryFilePath = path.join(memDir, "memory.json");

  __setConversationDataDirForTesting(convDir);
  __setMemoryPathForTesting(memoryFilePath);

  try {
    initConversationStorage(); // no legacy history -> empty index written
    const created = createConversation({ title: "Created after first init" });

    // Now legacy history appears (simulating some other process having
    // written it) — a second initConversationStorage() call must NOT
    // migrate it in, since conversations/index.json already exists.
    fs.writeFileSync(
      memoryFilePath,
      JSON.stringify({
        schemaVersion: 4,
        profile: { name: "", favoriteColor: "", location: "", occupation: "" },
        preferences: [],
        projects: [],
        goals: [],
        memories: [],
        calendar: [],
        conversations: [{ agent: "lois", userMessage: "late arrival", assistantReply: "reply", timestamp: "2026-01-01T00:00:00.000Z" }],
      })
    );

    initConversationStorage();

    const conversations = listConversations();
    assert.equal(conversations.length, 1, "should still be just the one created conversation, not a re-migrated one");
    assert.equal(conversations[0].id, created.id);
  } finally {
    __resetConversationDataDirForTesting();
    __resetMemoryPathForTesting();
    fs.rmSync(convDir, { recursive: true, force: true });
    fs.rmSync(memDir, { recursive: true, force: true });
  }
});
