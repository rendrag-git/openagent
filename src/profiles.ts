import type { WorkerProfile } from "./types.ts";

const QUESTION_ROUTING =
  "If you are uncertain about a requirement, design decision, or approach — ask. " +
  "Your question will be routed to the delegating agent or human for an answer.";

export const PROFILES: Record<string, WorkerProfile> = {
  plan: {
    allowedTools: ["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", "Agent"],
    permissionMode: "plan",
    systemPromptAppend:
      "You are exploring a codebase and producing a plan. " +
      "When you need clarification on requirements, design decisions, or technical approach, use AskUserQuestion. " +
      "You may write design documents to docs/plans/ only. " +
      "Use the superpowers:brainstorming skill to explore intent, requirements, and design. " +
      QUESTION_ROUTING,
    settingSources: ["project"],
    maxTurns: 30,
    denyTools: ["Write", "Edit"],
    allowWritePaths: ["docs/plans/"],
  },
  execute: {
    allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "Agent"],
    permissionMode: "acceptEdits",
    systemPromptAppend:
      "You are implementing a task. Follow the plan provided. " +
      "When you need clarification, use AskUserQuestion. " +
      QUESTION_ROUTING,
    settingSources: ["project"],
    maxTurns: 50,
  },
  check: {
    allowedTools: ["Read", "Glob", "Grep", "Bash", "Agent"],
    permissionMode: "plan",
    systemPromptAppend:
      "You are reviewing work for correctness. Run tests, read diffs, " +
      "compare against the plan. Report issues as structured findings. " +
      "When you need clarification, use AskUserQuestion. " +
      QUESTION_ROUTING,
    settingSources: ["project"],
    maxTurns: 20,
    denyTools: ["Write", "Edit"],
  },
  act: {
    allowedTools: ["Read", "Edit", "Bash", "Glob", "Grep", "Agent"],
    permissionMode: "acceptEdits",
    systemPromptAppend:
      "You are fixing specific issues. Be surgical — change only " +
      "what is needed to resolve the reported problems. " +
      "When you need clarification, use AskUserQuestion. " +
      QUESTION_ROUTING,
    settingSources: ["project"],
    maxTurns: 30,
  },
};

export function getProfile(name: string): WorkerProfile | undefined {
  return PROFILES[name];
}
