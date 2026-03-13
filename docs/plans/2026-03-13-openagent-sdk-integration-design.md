# OpenAgent: Claude Agent SDK Integration for OpenClaw

**Date:** 2026-03-13
**Status:** Approved
**Authors:** Pearson, Soren, Claude

## Problem

OpenClaw agents invoke Claude Code via `claude -p` — a fire-and-forget, single-shot print mode with no interactivity. There is no way for agents to:

- Receive structured results from coding tasks
- Route clarifying questions back to the delegating agent or human
- Access the full Claude Code experience (tools, skills, plugins, MCP, subagents)
- Resume interrupted sessions

The Anthropic Agent SDK (`@anthropic-ai/claude-agent-sdk`) wraps Claude Code as a programmable library with full access to tools, hooks, session management, and structured events. This design integrates it into OpenClaw's trusted hook pipeline.

## Decision Summary

Build **openagent** — a TypeScript library exposing four PDCA workers (`plan`, `execute`, `check`, `act`) and a raw `createSession()` primitive. A standalone hook (`openagent-dispatch`) integrates it into OpenClaw's envelope system. Questions from SDK sessions are parked to disk and resumed when answered. Agents opt in with `engine: "openagent"` in their task payload. Existing `claude -p` and `sessions_spawn` flows are unaffected.

## Architecture

```
OpenClaw Agent
  → TASK_REQUEST envelope (engine: "openagent", worker: "execute")
  → openagent-dispatch hook (trusted)
    → openagent library
      → Claude Agent SDK session (full Claude Code experience)
        ← question? → park to disk → CLARIFICATION envelope → agent answers
        ← resume(sessionId, answer) → session continues
      ← TaskResult (structured)
    → TASK_RESULT envelope
  → Agent receives result
```

### Trust Model

The SDK integration lives entirely within the trusted hook pipeline. No HTTP services, no external callbacks. Agents see standard `TASK_RESULT` and `CLARIFICATION` envelopes — the same trusted transport they already use. This avoids the prompt injection risk of HTTP-based callbacks that agents treat as untrusted.

## Project Structure

```
/home/ubuntu/projects/openagent/
├── src/
│   ├── workers/
│   │   ├── plan.ts        # Plan worker
│   │   ├── execute.ts     # Do worker
│   │   ├── check.ts       # Check worker
│   │   └── act.ts         # Act worker
│   ├── types.ts           # Shared types (TaskRequest, TaskResult, Question)
│   ├── session.ts         # SDK session wrapper (query lifecycle, event handling)
│   ├── feedback.ts        # Question parking & resume
│   └── index.ts           # Public API
├── package.json
├── tsconfig.json
└── tests/

~/.openclaw/hooks/openagent-dispatch/
├── handler.ts             # Hook entry point
├── lib/
│   ├── router.ts          # SDK vs legacy routing decision
│   ├── parked.ts          # Parked session persistence & resume
│   └── envelope.ts        # TaskResult → SystemEnvelope mapping
├── package.json
└── tsconfig.json
```

## Public API

```typescript
import * as openagent from "openagent";

// PDCA convenience workers
const result = await openagent.plan({ task, cwd, context? });
const result = await openagent.execute({ plan, cwd, context? });
const result = await openagent.check({ task, cwd, plan? });
const result = await openagent.act({ issues, cwd });

// Raw session primitive (escape hatch)
const result = await openagent.createSession({ prompt, cwd, profile?, tools?, ... });

// Resume a parked session
const result = await openagent.resume(sessionId, answer);
```

## Types

### Input

```typescript
interface TaskContext {
  cwd: string;
  context?: string;
  overrides?: Partial<WorkerProfile>;
  onQuestion?: (question: Question) => Promise<string>;
  onProgress?: (event: ProgressEvent) => void;
  includeDiff?: boolean;              // opt-in, default false
}

interface PlanRequest extends TaskContext {
  task: string;
}

interface ExecuteRequest extends TaskContext {
  plan: string;
}

interface CheckRequest extends TaskContext {
  task: string;
  plan?: string;
}

interface ActRequest extends TaskContext {
  issues: string;
}

interface SessionRequest extends TaskContext {
  prompt: string;
  profile?: WorkerProfile;
  tools?: string[];
  systemPrompt?: string;
  hooks?: Record<string, HookMatcher[]>;
}
```

### Output

```typescript
interface TaskResult {
  success: boolean;
  output: string;
  filesChanged: FileChange[];
  questions: Question[];
  sessionId: string;
  stopReason: "end_turn" | "max_turns" | "error" | "parked";
  parkedQuestion?: Question;
  costUsd: number;
  gitDiff?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
  };
}

interface FileChange {
  path: string;
  action: "created" | "modified" | "deleted";
}

interface Question {
  id: string;
  text: string;
  timestamp: string;
  answered: boolean;
  answer?: string;
}

interface ProgressEvent {
  type: "text" | "tool_use" | "tool_result" | "question";
  content: string;
  timestamp: string;
}
```

## Worker Profiles

All workers use the Claude Code preset system prompt with role-specific instructions appended. All workers inherit environment MCP servers and plugins. All use `settingSources: ["project"]` to pick up CLAUDE.md files.

### plan

**Purpose:** Explore, research, brainstorm, write specs and design docs.

```typescript
{
  allowedTools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "Write", "Agent"],
  permissionMode: "acceptEdits",
  systemPrompt: {
    type: "preset",
    preset: "claude_code",
    append: "You are exploring a task and producing a plan or design document. "
          + "Do not modify existing code. Write output to docs/ only. "
          + "If you are uncertain about a requirement, design decision, or approach — ask. "
          + "Your question will be routed to the delegating agent or human for an answer."
  },
  settingSources: ["project"],
  maxTurns: 30,
}
```

### execute

**Purpose:** Build the thing. Takes a plan reference or description and implements it.

```typescript
{
  allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "Agent"],
  permissionMode: "acceptEdits",
  systemPrompt: {
    type: "preset",
    preset: "claude_code",
    append: "You are implementing a task. Follow the plan provided. "
          + "If you are uncertain about a requirement, design decision, or approach — ask. "
          + "Your question will be routed to the delegating agent or human for an answer."
  },
  settingSources: ["project"],
  maxTurns: 50,
}
```

### check

**Purpose:** Verify work against the plan. Run tests, read diffs, flag issues.

```typescript
{
  allowedTools: ["Read", "Glob", "Grep", "Bash", "Agent"],
  permissionMode: "acceptEdits",
  systemPrompt: {
    type: "preset",
    preset: "claude_code",
    append: "You are reviewing work for correctness. Run tests, read diffs, "
          + "compare against the plan. Report issues as structured findings. "
          + "If you are uncertain about a requirement, design decision, or approach — ask. "
          + "Your question will be routed to the delegating agent or human for an answer."
  },
  settingSources: ["project"],
  maxTurns: 20,
}
```

### act

**Purpose:** Fix issues found by check. Debug, patch, config changes.

```typescript
{
  allowedTools: ["Read", "Edit", "Bash", "Glob", "Grep", "Agent"],
  permissionMode: "acceptEdits",
  systemPrompt: {
    type: "preset",
    preset: "claude_code",
    append: "You are fixing specific issues. Be surgical — change only "
          + "what is needed to resolve the reported problems. "
          + "If you are uncertain about a requirement, design decision, or approach — ask. "
          + "Your question will be routed to the delegating agent or human for an answer."
  },
  settingSources: ["project"],
  maxTurns: 30,
}
```

### Overrides

All profiles accept an `overrides` param to tweak any setting:

```typescript
openagent.execute({
  plan: "...",
  cwd: "/home/ubuntu/projects/lobster",
  overrides: {
    maxTurns: 100,
    allowedTools: [...defaultTools, "WebSearch"],
  }
});
```

## Question Parking & Resume

When the SDK agent calls `AskUserQuestion`, the session is parked — not timed out.

### Park flow

1. SDK agent asks a question
2. `onQuestion` callback fires
3. Library persists session state to `~/.openclaw/openagent/parked/<sessionId>.json`
4. Returns `TaskResult` with `stopReason: "parked"`, `parkedQuestion` populated, `sessionId` included
5. Hook sends `CLARIFICATION` envelope to delegating agent

### Resume flow

1. Answer arrives via envelope (could be minutes or hours later)
2. Hook calls `openagent.resume(sessionId, answer)`
3. Library starts a new SDK session with `resume: sessionId`, feeds the answer
4. Returns a new `TaskResult` as if the session ran normally
5. Parked state file cleaned up

### Parked session storage

```
~/.openclaw/openagent/parked/
  <sessionId>.json → {
    sessionId: string,
    question: Question,
    originalFrom: string,     // delegating agent
    threadId: string,         // envelope thread
    taskContext: TaskContext,  // for reference
    createdAt: string
  }
```

No timeouts. No lost work. The session sleeps until answered.

## Hook Integration: openagent-dispatch

### Routing

Explicit opt-in only. Default is legacy behavior.

```typescript
function shouldUseSDK(envelope: SystemEnvelope): boolean {
  if (envelope.payload?.engine === "openagent") return true;
  if (envelope.payload?.engine === "legacy") return false;
  return false; // default: legacy until SDK is proven stable
}
```

### Dispatch

```typescript
export async function handle(envelope: SystemEnvelope) {
  if (!shouldUseSDK(envelope)) return; // fall through to legacy

  const worker = envelope.payload?.worker ?? "execute";
  const request = {
    task: envelope.payload.task,
    cwd: envelope.payload.cwd,
    context: envelope.payload.context,
    includeDiff: envelope.payload.includeDiff ?? false,
    onQuestion: async (question) => { throw new ParkSession(question); },
  };

  try {
    const result = await openagent[worker](request);
    await sendEnvelope({
      to: envelope.from,
      intent: "TASK_RESULT",
      threadId: envelope.threadId,
      payload: resultToPayload(result),
    });
  } catch (e) {
    if (e instanceof ParkSession) {
      await parkSession(envelope, e.question);
      await sendEnvelope({
        to: envelope.from,
        intent: "CLARIFICATION",
        threadId: envelope.threadId,
        payload: { question: e.question.text, sessionId: e.question.sessionId, status: "parked" },
      });
    }
  }
}
```

### Resume handler

```typescript
export async function handleClarificationAnswer(envelope: SystemEnvelope) {
  const { sessionId, answer } = envelope.payload;
  const parked = await loadParkedSession(sessionId);
  if (!parked) return;

  const result = await openagent.resume(sessionId, answer);
  await removeParkedSession(sessionId);
  await sendEnvelope({
    to: parked.originalFrom,
    intent: "TASK_RESULT",
    threadId: parked.threadId,
    payload: resultToPayload(result),
  });
}
```

### What agents see

Delegating agents use standard envelope protocol. The only new fields are `engine` and `worker`:

```json
{
  "to": "dev",
  "intent": "TASK_REQUEST",
  "payload": {
    "engine": "openagent",
    "worker": "execute",
    "task": "Add pagination to the /api/projects endpoint",
    "cwd": "/home/ubuntu/projects/mission-control",
    "includeDiff": true
  }
}
```

Results come back as standard `TASK_RESULT` envelopes with structured payload.

## Scope Boundaries (v1)

**In scope:**
- openagent TypeScript library with four PDCA workers + createSession primitive
- Full Claude Code experience (tools, skills, plugins, MCP, subagents)
- Question parking and session resumption
- openagent-dispatch standalone hook
- Opt-in routing via envelope payload

**Out of scope:**
- Automated PDCA orchestration loop (workers are independent)
- Per-worker model selection (uses API key default)
- Agent identity passthrough (no SOUL.md injection)
- Agent-coordinator revival (separate concern)
- Migration of existing claude -p / sessions_spawn flows
- Persistent worker processes or pools
- Plugin/MCP wiring verification (test during implementation, fix if needed)

## Future Enhancements

- PDCA orchestration: automated plan→do→check→act cycle with gates between phases
- Model routing: Haiku for check, Opus for execute, etc.
- Worker pools: persistent sessions for high-throughput agents
- Coordinator integration: wire into revived agent-coordinator if/when that happens
- Cost tracking dashboard: aggregate costUsd across sessions for budget management
- Default flip: change routing default from legacy to openagent once stable
