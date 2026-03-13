import type { WorkerProfile } from "./types.ts";

const QUESTION_ROUTING =
  "If you are uncertain about a requirement, design decision, or approach — ask. " +
  "Your question will be routed to the delegating agent or human for an answer.";

export const PROFILES: Record<string, WorkerProfile> = {
  plan: {
    allowedTools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "Write", "Agent"],
    permissionMode: "acceptEdits",
    systemPromptAppend:
      "You are exploring a task and producing a plan or design document. " +
      "Do not modify existing code. Write output to docs/ only. " +
      QUESTION_ROUTING,
    settingSources: ["project"],
    maxTurns: 30,
  },
  execute: {
    allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "Agent"],
    permissionMode: "acceptEdits",
    systemPromptAppend:
      "You are implementing a task. Follow the plan provided. " +
      QUESTION_ROUTING,
    settingSources: ["project"],
    maxTurns: 50,
  },
  check: {
    allowedTools: ["Read", "Glob", "Grep", "Bash", "Agent"],
    permissionMode: "acceptEdits",
    systemPromptAppend:
      "You are reviewing work for correctness. Run tests, read diffs, " +
      "compare against the plan. Report issues as structured findings. " +
      QUESTION_ROUTING,
    settingSources: ["project"],
    maxTurns: 20,
  },
  act: {
    allowedTools: ["Read", "Edit", "Bash", "Glob", "Grep", "Agent"],
    permissionMode: "acceptEdits",
    systemPromptAppend:
      "You are fixing specific issues. Be surgical — change only " +
      "what is needed to resolve the reported problems. " +
      QUESTION_ROUTING,
    settingSources: ["project"],
    maxTurns: 30,
  },
};

export function getProfile(name: string): WorkerProfile | undefined {
  return PROFILES[name];
}
