import { loisAgent } from "../agents/lois";
import { ignisAgent } from "../agents/ignis";

export type AgentName = "lois" | "ignis";

export async function routeAgent(agent: AgentName, message: string): Promise<string> {
  if (agent === "ignis") {
    return ignisAgent(message);
  }

  return loisAgent(message);
}