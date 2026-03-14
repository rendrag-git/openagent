import type { WorkerProfile } from "./types.ts";

const QUESTION_ROUTING =
  "If you are uncertain about a requirement, design decision, or approach — ask. " +
  "Your question will be routed to the delegating agent or human for an answer.";

export const PROFILES: Record<string, WorkerProfile> = {
  plan: {
    allowedTools: ["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", "Agent"],
    permissionMode: "acceptEdits",
    systemPromptAppend:
      "You are exploring a codebase and producing a plan. " +
      "You are READ-ONLY. Do NOT create, modify, or delete any files. " +
      "Use Bash only for exploration (git log, ls, test runs) — never for writing. " +
      "After exploring, write a comprehensive plan document summarizing your findings, approach, key decisions, and implementation steps. " +
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
