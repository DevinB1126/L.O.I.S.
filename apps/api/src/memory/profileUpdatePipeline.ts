import { updateProfile, ProfileField } from "./memoryService";
import { detectProfileUpdateIntent } from "./memoryExtractor";
import { AgentName } from "../agents/agentPrompt";

// Profile-state synchronization fix — single entry point server.ts calls
// (from both /chat and /chat/stream) BEFORE generating any LLM reply. If
// the message is a canonical profile statement, the mutation happens here,
// synchronously, and the returned reply is built deterministically from
// whether that mutation actually succeeded — never from an LLM's guess
// about what probably happened. This is what makes "LOIS may confirm
// success" (see the flow diagram in the bug report) an honest statement
// instead of a hallucination: the reply text is a pure function of
// `success`, which is itself `updateProfile()`'s real return value.
//
// When this returns `handled: true`, callers must skip both the normal
// agent/LLM reply path and the generic memory-extraction pipeline for that
// message — a canonical profile statement should update exactly one place
// (profile.<field>), never also produce a duplicate MemoryRecord.
export interface ProfileUpdateOutcome {
  handled: boolean;
  reply?: string;
}

export function tryHandleProfileUpdate(agent: AgentName, message: string): ProfileUpdateOutcome {
  const intent = detectProfileUpdateIntent(message);

  if (!intent) {
    return { handled: false };
  }

  const updatedProfile = updateProfile(intent.field, intent.value);
  const success = updatedProfile !== null;

  if (success) {
    console.log(`[profile] updated ${intent.field} -> "${intent.value}"`);
  } else {
    console.warn(`[profile] update rejected for ${intent.field}: invalid value "${intent.value}"`);
  }

  return {
    handled: true,
    reply: buildProfileUpdateReply(agent, intent.field, intent.value, success),
  };
}

function fieldLabel(field: ProfileField): string {
  switch (field) {
    case "favoriteColor":
      return "favorite color";
    case "location":
      return "location";
    case "occupation":
      return "occupation";
    case "name":
      return "name";
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Deterministic, persona-flavored, and — critically — gated entirely on
// `success`. There is no code path here that can produce confirmation
// wording when `success` is false, and no code path that produces failure
// wording when it's true.
function buildProfileUpdateReply(agent: AgentName, field: ProfileField, value: string, success: boolean): string {
  const label = fieldLabel(field);

  if (!success) {
    return agent === "ignis"
      ? `Update rejected, Devin. "${value}" isn't a valid ${label} value — nothing was changed.`
      : `Devin, I wasn't able to save that — "${value}" isn't a valid ${label} value, so your profile is unchanged.`;
  }

  return agent === "ignis"
    ? `Profile updated, Devin. ${capitalize(label)}: ${value}. Change persisted.`
    : `Devin, I've updated your ${label} to ${value}. That's saved to your profile now.`;
}
