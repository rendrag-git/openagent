# OpenAgent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a TypeScript library wrapping the Claude Agent SDK with four PDCA workers and a raw session primitive, plus a standalone OpenClaw hook for envelope integration.

**Architecture:** The `openagent` library exposes `plan()`, `execute()`, `check()`, `act()`, and `createSession()`. Each spawns a full Claude Code SDK session with role-appropriate tools and the `claude_code` preset system prompt. Questions are parked to disk and resumed later. The `openagent-dispatch` hook integrates the library into OpenClaw's trusted envelope pipeline.

**Tech Stack:** TypeScript (ESM), `@anthropic-ai/claude-agent-sdk` (v0.2.75), Node 22, `node:test` for testing.

**Design doc:** `docs/plans/2026-03-13-openagent-sdk-integration-design.md`

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/index.ts` (empty placeholder)

**Step 1: Initialize package.json**

```bash
cd /home/ubuntu/projects/openagent
npm init -y
```

Then edit `package.json` to:

```json
{
  "name": "openagent",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "node --test --experimental-strip-types tests/**/*.test.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.2.75"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "@types/node": "^22.0.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

**Step 3: Create empty entry point**

```typescript
// src/index.ts
export {};
```

**Step 4: Install dependencies**

```bash
npm install
```

Expected: `node_modules/` created, `package-lock.json` generated, `@anthropic-ai/claude-agent-sdk` installed.

**Step 5: Verify setup**

```bash
npm run typecheck
```

Expected: exits 0 with no errors.

**Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json src/index.ts
echo "node_modules/" > .gitignore && echo "dist/" >> .gitignore
git add .gitignore
git commit -m "chore: scaffold openagent project with SDK dependency"
```

---

### Task 2: Core Types

**Files:**
- Create: `src/types.ts`
- Test: `tests/types.test.ts`

**Step 1: Write the type validation test**

Create `tests/types.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  TaskContext,
  PlanRequest,
  ExecuteRequest,
  CheckRequest,
  ActRequest,
  SessionRequest,
  TaskResult,
  FileChange,
  Question,
  ProgressEvent,
  WorkerProfile,
} from "../src/types.ts";

describe("types", () => {
  it("TaskResult has all required fields", () => {
    const result: TaskResult = {
      success: true,
      output: "done",
      filesChanged: [],
      questions: [],
      sessionId: "sess_123",
      stopReason: "end_turn",
      costUsd: 0.42,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        durationMs: 12000,
      },
    };
    assert.equal(result.success, true);
    assert.equal(result.stopReason, "end_turn");
  });

  it("TaskResult supports parked state", () => {
    const result: TaskResult = {
      success: false,
      output: "",
      filesChanged: [],
      questions: [],
      sessionId: "sess_456",
      stopReason: "parked",
      parkedQuestion: {
        id: "q_1",
        text: "Which database adapter?",
        timestamp: "2026-03-13T12:00:00Z",
        answered: false,
      },
      costUsd: 0.10,
      usage: { inputTokens: 500, outputTokens: 100, durationMs: 3000 },
    };
    assert.equal(result.stopReason, "parked");
    assert.ok(result.parkedQuestion);
    assert.equal(result.parkedQuestion.answered, false);
  });

  it("FileChange tracks actions", () => {
    const changes: FileChange[] = [
      { path: "src/foo.ts", action: "created" },
      { path: "src/bar.ts", action: "modified" },
      { path: "src/baz.ts", action: "deleted" },
    ];
    assert.equal(changes.length, 3);
  });

  it("WorkerProfile has required fields", () => {
    const profile: WorkerProfile = {
      allowedTools: ["Read", "Edit"],
      permissionMode: "acceptEdits",
      systemPromptAppend: "You are implementing a task.",
      settingSources: ["project"],
      maxTurns: 50,
    };
    assert.equal(profile.maxTurns, 50);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test
```

Expected: FAIL — cannot find module `../src/types.ts`.

**Step 3: Implement types**

Create `src/types.ts`:

```typescript
// --- Worker Profile ---

export interface WorkerProfile {
  allowedTools: string[];
  permissionMode: "default" | "plan" | "acceptEdits" | "bypassPermissions";
  systemPromptAppend: string;
  settingSources: string[];
  maxTurns: number;
}

// --- Questions & Progress ---

export interface Question {
  id: string;
  text: string;
  timestamp: string;
  answered: boolean;
  answer?: string;
}

export interface ProgressEvent {
  type: "text" | "tool_use" | "tool_result" | "question";
  content: string;
  timestamp: string;
}

// --- File Changes ---

export interface FileChange {
  path: string;
  action: "created" | "modified" | "deleted";
}

// --- Task Inputs ---

export interface TaskContext {
  cwd: string;
  context?: string;
  overrides?: Partial<WorkerProfile>;
  onQuestion?: (question: Question) => Promise<string>;
  onProgress?: (event: ProgressEvent) => void;
  includeDiff?: boolean;
}

export interface PlanRequest extends TaskContext {
  task: string;
}

export interface ExecuteRequest extends TaskContext {
  plan: string;
}

export interface CheckRequest extends TaskContext {
  task: string;
  plan?: string;
}

export interface ActRequest extends TaskContext {
  issues: string;
}

export interface SessionRequest extends TaskContext {
  prompt: string;
  profile?: WorkerProfile;
  tools?: string[];
  systemPrompt?: string | { type: "preset"; preset: string; append?: string };
  hooks?: Record<string, unknown[]>;
}

// --- Task Result ---

export interface TaskResult {
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

// --- Parked Session (persisted to disk) ---

export interface ParkedSession {
  sessionId: string;
  question: Question;
  originalFrom: string;
  threadId: string;
  taskContext: TaskContext;
  createdAt: string;
}
```

**Step 4: Run tests**

```bash
npm test
```

Expected: all 4 tests pass.

**Step 5: Commit**

```bash
git add src/types.ts tests/types.test.ts
git commit -m "feat: add core types for TaskResult, worker profiles, and question parking"
```

---

### Task 3: Worker Profiles

**Files:**
- Create: `src/profiles.ts`
- Test: `tests/profiles.test.ts`

**Step 1: Write the failing test**

Create `tests/profiles.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PROFILES, getProfile } from "../src/profiles.ts";

describe("profiles", () => {
  it("exports all four PDCA profiles", () => {
    assert.ok(PROFILES.plan);
    assert.ok(PROFILES.execute);
    assert.ok(PROFILES.check);
    assert.ok(PROFILES.act);
  });

  it("plan profile excludes Edit", () => {
    assert.ok(!PROFILES.plan.allowedTools.includes("Edit"));
  });

  it("plan profile includes Agent", () => {
    assert.ok(PROFILES.plan.allowedTools.includes("Agent"));
  });

  it("execute profile includes Edit, Write, Bash, Agent", () => {
    for (const tool of ["Edit", "Write", "Bash", "Agent"]) {
      assert.ok(
        PROFILES.execute.allowedTools.includes(tool),
        `execute missing ${tool}`
      );
    }
  });

  it("check profile excludes Edit and Write", () => {
    assert.ok(!PROFILES.check.allowedTools.includes("Edit"));
    assert.ok(!PROFILES.check.allowedTools.includes("Write"));
  });

  it("all profiles use acceptEdits permission mode", () => {
    for (const [name, profile] of Object.entries(PROFILES)) {
      assert.equal(
        profile.permissionMode,
        "acceptEdits",
        `${name} should use acceptEdits`
      );
    }
  });

  it("all profiles include question routing in system prompt", () => {
    for (const [name, profile] of Object.entries(PROFILES)) {
      assert.ok(
        profile.systemPromptAppend.includes("uncertain"),
        `${name} missing question routing instruction`
      );
    }
  });

  it("all profiles set settingSources to project", () => {
    for (const [name, profile] of Object.entries(PROFILES)) {
      assert.deepEqual(
        profile.settingSources,
        ["project"],
        `${name} should load project settings`
      );
    }
  });

  it("getProfile returns profile by name", () => {
    assert.deepEqual(getProfile("plan"), PROFILES.plan);
  });

  it("getProfile returns undefined for unknown name", () => {
    assert.equal(getProfile("unknown"), undefined);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test
```

Expected: FAIL — cannot find module `../src/profiles.ts`.

**Step 3: Implement profiles**

Create `src/profiles.ts`:

```typescript
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
```

**Step 4: Run tests**

```bash
npm test
```

Expected: all 10 tests pass.

**Step 5: Commit**

```bash
git add src/profiles.ts tests/profiles.test.ts
git commit -m "feat: add PDCA worker profiles with tool sets and system prompts"
```

---

### Task 4: Session Wrapper

**Files:**
- Create: `src/session.ts`
- Test: `tests/session.test.ts`

This is the core — wraps the Agent SDK's `query()` function, handles message streaming, extracts structured results, and catches questions.

**Step 1: Write the failing test**

Create `tests/session.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSessionOptions, extractResult, ParkSession } from "../src/session.ts";
import type { WorkerProfile } from "../src/types.ts";

describe("buildSessionOptions", () => {
  it("builds SDK options from profile and request", () => {
    const profile: WorkerProfile = {
      allowedTools: ["Read", "Edit"],
      permissionMode: "acceptEdits",
      systemPromptAppend: "You are implementing.",
      settingSources: ["project"],
      maxTurns: 50,
    };

    const opts = buildSessionOptions({
      prompt: "Add pagination",
      cwd: "/home/ubuntu/projects/test",
      profile,
    });

    assert.equal(opts.prompt, "Add pagination");
    assert.equal(opts.options.cwd, "/home/ubuntu/projects/test");
    assert.deepEqual(opts.options.allowedTools, ["Read", "Edit"]);
    assert.equal(opts.options.permissionMode, "acceptEdits");
    assert.equal(opts.options.maxTurns, 50);
    assert.deepEqual(opts.options.settingSources, ["project"]);
    assert.deepEqual(opts.options.systemPrompt, {
      type: "preset",
      preset: "claude_code",
      append: "You are implementing.",
    });
  });

  it("applies overrides on top of profile", () => {
    const profile: WorkerProfile = {
      allowedTools: ["Read"],
      permissionMode: "acceptEdits",
      systemPromptAppend: "test",
      settingSources: ["project"],
      maxTurns: 20,
    };

    const opts = buildSessionOptions({
      prompt: "test",
      cwd: "/tmp",
      profile,
      overrides: { maxTurns: 100, allowedTools: ["Read", "Edit", "Bash"] },
    });

    assert.equal(opts.options.maxTurns, 100);
    assert.deepEqual(opts.options.allowedTools, ["Read", "Edit", "Bash"]);
  });
});

describe("extractResult", () => {
  it("builds TaskResult from messages", () => {
    const result = extractResult({
      messages: [
        { type: "result", result: "Done. Created src/foo.ts.", stop_reason: "end_turn" },
      ],
      sessionId: "sess_123",
      startTime: Date.now() - 5000,
    });

    assert.equal(result.success, true);
    assert.equal(result.output, "Done. Created src/foo.ts.");
    assert.equal(result.stopReason, "end_turn");
    assert.equal(result.sessionId, "sess_123");
    assert.ok(result.usage.durationMs >= 4000);
  });

  it("marks error stop reason as not successful", () => {
    const result = extractResult({
      messages: [
        { type: "result", result: "Error occurred", stop_reason: "error" },
      ],
      sessionId: "sess_456",
      startTime: Date.now(),
    });

    assert.equal(result.success, false);
    assert.equal(result.stopReason, "error");
  });
});

describe("ParkSession", () => {
  it("is throwable with a question", () => {
    const q = { id: "q1", text: "Which DB?", timestamp: new Date().toISOString(), answered: false };
    const err = new ParkSession(q);
    assert.ok(err instanceof Error);
    assert.equal(err.question.text, "Which DB?");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test
```

Expected: FAIL — cannot find module `../src/session.ts`.

**Step 3: Implement session wrapper**

Create `src/session.ts`:

```typescript
import type {
  TaskContext,
  TaskResult,
  Question,
  FileChange,
  WorkerProfile,
} from "./types.ts";

// --- ParkSession error (thrown to interrupt session) ---

export class ParkSession extends Error {
  question: Question;
  constructor(question: Question) {
    super(`Session parked: ${question.text}`);
    this.name = "ParkSession";
    this.question = question;
  }
}

// --- Build SDK options from profile + request ---

interface BuildInput {
  prompt: string;
  cwd: string;
  profile?: WorkerProfile;
  overrides?: Partial<WorkerProfile>;
  context?: string;
}

interface SDKQueryInput {
  prompt: string;
  options: {
    cwd: string;
    allowedTools?: string[];
    permissionMode?: string;
    systemPrompt?: string | { type: string; preset: string; append?: string };
    settingSources?: string[];
    maxTurns?: number;
    [key: string]: unknown;
  };
}

export function buildSessionOptions(input: BuildInput): SDKQueryInput {
  const profile = input.profile;
  const overrides = input.overrides;

  const allowedTools = overrides?.allowedTools ?? profile?.allowedTools;
  const permissionMode = overrides?.permissionMode ?? profile?.permissionMode;
  const maxTurns = overrides?.maxTurns ?? profile?.maxTurns;
  const settingSources = overrides?.settingSources ?? profile?.settingSources;
  const systemPromptAppend =
    overrides?.systemPromptAppend ?? profile?.systemPromptAppend;

  // Prepend context to prompt if provided
  const fullPrompt = input.context
    ? `Context:\n${input.context}\n\nTask:\n${input.prompt}`
    : input.prompt;

  return {
    prompt: fullPrompt,
    options: {
      cwd: input.cwd,
      ...(allowedTools && { allowedTools }),
      ...(permissionMode && { permissionMode }),
      ...(maxTurns && { maxTurns }),
      ...(settingSources && { settingSources }),
      ...(systemPromptAppend && {
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: systemPromptAppend,
        },
      }),
    },
  };
}

// --- Extract structured result from SDK messages ---

interface ExtractInput {
  messages: Array<{ type: string; result?: string; stop_reason?: string; [key: string]: unknown }>;
  sessionId: string;
  startTime: number;
}

export function extractResult(input: ExtractInput): TaskResult {
  const resultMsg = input.messages.find((m) => m.type === "result");
  const output = resultMsg?.result ?? "";
  const stopReason = (resultMsg?.stop_reason ?? "error") as TaskResult["stopReason"];

  return {
    success: stopReason === "end_turn",
    output,
    filesChanged: [],       // populated by runSession after git diff
    questions: [],           // populated if questions were asked
    sessionId: input.sessionId,
    stopReason,
    costUsd: 0,             // populated by runSession from usage data
    usage: {
      inputTokens: 0,       // populated from SDK usage events
      outputTokens: 0,
      durationMs: Date.now() - input.startTime,
    },
  };
}

// --- Model pricing for cost calculation ---

const MODEL_RATES: Record<string, { input: number; output: number }> = {
  "claude-opus-4-6": { input: 5.0 / 1_000_000, output: 25.0 / 1_000_000 },
  "claude-sonnet-4-6": { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
  "claude-haiku-4-5": { input: 1.0 / 1_000_000, output: 5.0 / 1_000_000 },
};

export function computeCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const rates = MODEL_RATES[model] ?? MODEL_RATES["claude-opus-4-6"];
  return inputTokens * rates.input + outputTokens * rates.output;
}
```

**Step 4: Run tests**

```bash
npm test
```

Expected: all tests pass (buildSessionOptions, extractResult, ParkSession).

**Step 5: Commit**

```bash
git add src/session.ts tests/session.test.ts
git commit -m "feat: add session wrapper with SDK option builder and result extractor"
```

---

### Task 5: Question Parking (Feedback Module)

**Files:**
- Create: `src/feedback.ts`
- Test: `tests/feedback.test.ts`

**Step 1: Write the failing test**

Create `tests/feedback.test.ts`:

```typescript
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  parkSession,
  loadParkedSession,
  removeParkedSession,
  listParkedSessions,
} from "../src/feedback.ts";
import type { ParkedSession } from "../src/types.ts";

const TEST_DIR = "/tmp/openagent-test-parked";

describe("feedback", () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("parks a session to disk", async () => {
    const parked: ParkedSession = {
      sessionId: "sess_123",
      question: {
        id: "q_1",
        text: "Which DB adapter?",
        timestamp: "2026-03-13T12:00:00Z",
        answered: false,
      },
      originalFrom: "pm",
      threadId: "thread_abc",
      taskContext: { cwd: "/home/ubuntu/projects/test" },
      createdAt: "2026-03-13T12:00:00Z",
    };

    await parkSession(parked, TEST_DIR);

    const filePath = path.join(TEST_DIR, "sess_123.json");
    assert.ok(fs.existsSync(filePath));
  });

  it("loads a parked session from disk", async () => {
    const parked: ParkedSession = {
      sessionId: "sess_456",
      question: {
        id: "q_2",
        text: "REST or GraphQL?",
        timestamp: "2026-03-13T12:00:00Z",
        answered: false,
      },
      originalFrom: "dev",
      threadId: "thread_def",
      taskContext: { cwd: "/tmp" },
      createdAt: "2026-03-13T12:00:00Z",
    };

    await parkSession(parked, TEST_DIR);
    const loaded = await loadParkedSession("sess_456", TEST_DIR);

    assert.ok(loaded);
    assert.equal(loaded!.question.text, "REST or GraphQL?");
    assert.equal(loaded!.originalFrom, "dev");
  });

  it("returns null for unknown session", async () => {
    const loaded = await loadParkedSession("nonexistent", TEST_DIR);
    assert.equal(loaded, null);
  });

  it("removes a parked session", async () => {
    const parked: ParkedSession = {
      sessionId: "sess_789",
      question: {
        id: "q_3",
        text: "test",
        timestamp: "2026-03-13T12:00:00Z",
        answered: false,
      },
      originalFrom: "pm",
      threadId: "thread_ghi",
      taskContext: { cwd: "/tmp" },
      createdAt: "2026-03-13T12:00:00Z",
    };

    await parkSession(parked, TEST_DIR);
    await removeParkedSession("sess_789", TEST_DIR);

    const filePath = path.join(TEST_DIR, "sess_789.json");
    assert.ok(!fs.existsSync(filePath));
  });

  it("lists all parked sessions", async () => {
    for (const id of ["sess_a", "sess_b", "sess_c"]) {
      await parkSession(
        {
          sessionId: id,
          question: { id: "q", text: "q", timestamp: "", answered: false },
          originalFrom: "pm",
          threadId: "t",
          taskContext: { cwd: "/tmp" },
          createdAt: "",
        },
        TEST_DIR,
      );
    }

    const sessions = await listParkedSessions(TEST_DIR);
    assert.equal(sessions.length, 3);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test
```

Expected: FAIL — cannot find module `../src/feedback.ts`.

**Step 3: Implement feedback module**

Create `src/feedback.ts`:

```typescript
import fs from "node:fs/promises";
import path from "node:path";
import type { ParkedSession } from "./types.ts";

const DEFAULT_PARKED_DIR = path.join(
  process.env.HOME ?? "/home/ubuntu",
  ".openclaw",
  "openagent",
  "parked",
);

export async function parkSession(
  session: ParkedSession,
  dir: string = DEFAULT_PARKED_DIR,
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${session.sessionId}.json`);
  await fs.writeFile(filePath, JSON.stringify(session, null, 2));
}

export async function loadParkedSession(
  sessionId: string,
  dir: string = DEFAULT_PARKED_DIR,
): Promise<ParkedSession | null> {
  const filePath = path.join(dir, `${sessionId}.json`);
  try {
    const data = await fs.readFile(filePath, "utf-8");
    return JSON.parse(data) as ParkedSession;
  } catch {
    return null;
  }
}

export async function removeParkedSession(
  sessionId: string,
  dir: string = DEFAULT_PARKED_DIR,
): Promise<void> {
  const filePath = path.join(dir, `${sessionId}.json`);
  try {
    await fs.unlink(filePath);
  } catch {
    // already removed, ignore
  }
}

export async function listParkedSessions(
  dir: string = DEFAULT_PARKED_DIR,
): Promise<ParkedSession[]> {
  try {
    const files = await fs.readdir(dir);
    const sessions: ParkedSession[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const data = await fs.readFile(path.join(dir, file), "utf-8");
      sessions.push(JSON.parse(data) as ParkedSession);
    }
    return sessions;
  } catch {
    return [];
  }
}
```

**Step 4: Run tests**

```bash
npm test
```

Expected: all 5 tests pass.

**Step 5: Commit**

```bash
git add src/feedback.ts tests/feedback.test.ts
git commit -m "feat: add question parking with disk persistence and resume support"
```

---

### Task 6: runSession — The Core SDK Integration

**Files:**
- Create: `src/run-session.ts`
- Test: `tests/run-session.test.ts`

This is the function that actually calls the Agent SDK. Testing it against the real SDK is an integration test — for unit tests, we test the surrounding logic and verify the SDK is called with the right arguments.

**Step 1: Write the failing test**

Create `tests/run-session.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRunConfig } from "../src/run-session.ts";
import { PROFILES } from "../src/profiles.ts";

describe("buildRunConfig", () => {
  it("builds config for execute worker", () => {
    const config = buildRunConfig({
      prompt: "Add pagination",
      cwd: "/home/ubuntu/projects/test",
      profile: PROFILES.execute,
    });

    assert.equal(config.prompt, "Add pagination");
    assert.equal(config.options.cwd, "/home/ubuntu/projects/test");
    assert.ok(config.options.allowedTools!.includes("Edit"));
    assert.ok(config.options.allowedTools!.includes("Agent"));
    assert.equal(config.options.permissionMode, "acceptEdits");
  });

  it("prepends context to prompt", () => {
    const config = buildRunConfig({
      prompt: "Fix the bug",
      cwd: "/tmp",
      profile: PROFILES.act,
      context: "The auth middleware throws on empty tokens.",
    });

    assert.ok(config.prompt.includes("Context:"));
    assert.ok(config.prompt.includes("auth middleware"));
    assert.ok(config.prompt.includes("Fix the bug"));
  });

  it("applies overrides", () => {
    const config = buildRunConfig({
      prompt: "test",
      cwd: "/tmp",
      profile: PROFILES.check,
      overrides: { maxTurns: 100 },
    });

    assert.equal(config.options.maxTurns, 100);
  });

  it("works without a profile (raw session)", () => {
    const config = buildRunConfig({
      prompt: "Do something custom",
      cwd: "/tmp",
      tools: ["Read", "Bash"],
      systemPrompt: "Custom prompt",
    });

    assert.equal(config.prompt, "Do something custom");
    assert.deepEqual(config.options.allowedTools, ["Read", "Bash"]);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test
```

Expected: FAIL — cannot find module `../src/run-session.ts`.

**Step 3: Implement run-session**

Create `src/run-session.ts`:

```typescript
import { buildSessionOptions, extractResult, computeCost, ParkSession } from "./session.ts";
import type {
  TaskResult,
  TaskContext,
  WorkerProfile,
  Question,
} from "./types.ts";

// Re-export for convenience
export { ParkSession } from "./session.ts";

// --- Config builder (testable without SDK) ---

interface RunInput {
  prompt: string;
  cwd: string;
  profile?: WorkerProfile;
  overrides?: Partial<WorkerProfile>;
  context?: string;
  tools?: string[];
  systemPrompt?: string | { type: string; preset: string; append?: string };
}

export function buildRunConfig(input: RunInput) {
  // If profile provided, use buildSessionOptions
  if (input.profile) {
    return buildSessionOptions({
      prompt: input.prompt,
      cwd: input.cwd,
      profile: input.profile,
      overrides: input.overrides,
      context: input.context,
    });
  }

  // Raw session — no profile, direct config
  const fullPrompt = input.context
    ? `Context:\n${input.context}\n\nTask:\n${input.prompt}`
    : input.prompt;

  return {
    prompt: fullPrompt,
    options: {
      cwd: input.cwd,
      ...(input.tools && { allowedTools: input.tools }),
      ...(input.systemPrompt && { systemPrompt: input.systemPrompt }),
    },
  };
}

// --- Run a session against the real SDK ---

interface RunSessionInput extends RunInput {
  onQuestion?: (question: Question) => Promise<string>;
  onProgress?: TaskContext["onProgress"];
  includeDiff?: boolean;
  resume?: string;
  resumeAnswer?: string;
}

export async function runSession(input: RunSessionInput): Promise<TaskResult> {
  // Dynamic import to avoid loading SDK at module level (testability)
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const config = buildRunConfig(input);
  const startTime = Date.now();
  let sessionId = "";
  let output = "";
  let stopReason: TaskResult["stopReason"] = "end_turn";
  const questions: Question[] = [];

  // If resuming, add resume option
  if (input.resume) {
    (config.options as Record<string, unknown>).resume = input.resume;
    if (input.resumeAnswer) {
      config.prompt = input.resumeAnswer;
    }
  }

  try {
    for await (const message of query(config)) {
      // Capture session ID from init message
      if (message.type === "system" && (message as any).subtype === "init") {
        sessionId = (message as any).session_id ?? (message as any).data?.session_id ?? "";
      }

      // Capture result
      if ("result" in message) {
        output = (message as any).result ?? "";
        stopReason = ((message as any).stop_reason ?? "end_turn") as TaskResult["stopReason"];
      }

      // Progress callback
      if (input.onProgress) {
        input.onProgress({
          type: message.type === "result" ? "text" : "tool_use",
          content: JSON.stringify(message),
          timestamp: new Date().toISOString(),
        });
      }
    }
  } catch (err) {
    if (err instanceof ParkSession) throw err;
    output = err instanceof Error ? err.message : String(err);
    stopReason = "error";
  }

  // Compute git diff if requested
  let gitDiff: string | undefined;
  if (input.includeDiff) {
    try {
      const { execSync } = await import("node:child_process");
      gitDiff = execSync("git diff", { cwd: input.cwd, encoding: "utf-8" });
    } catch {
      // no git or no changes, leave undefined
    }
  }

  return {
    success: stopReason === "end_turn",
    output,
    filesChanged: [],  // TODO: parse from git status
    questions,
    sessionId,
    stopReason,
    costUsd: 0,        // TODO: extract from SDK usage events
    gitDiff,
    usage: {
      inputTokens: 0,  // TODO: extract from SDK usage events
      outputTokens: 0,
      durationMs: Date.now() - startTime,
    },
  };
}
```

**Step 4: Run tests**

```bash
npm test
```

Expected: buildRunConfig tests pass. (runSession is integration-tested in Task 8.)

**Step 5: Commit**

```bash
git add src/run-session.ts tests/run-session.test.ts
git commit -m "feat: add runSession core with SDK query integration and git diff capture"
```

---

### Task 7: Workers + Public API

**Files:**
- Create: `src/workers/plan.ts`
- Create: `src/workers/execute.ts`
- Create: `src/workers/check.ts`
- Create: `src/workers/act.ts`
- Modify: `src/index.ts`
- Test: `tests/workers.test.ts`

**Step 1: Write the failing test**

Create `tests/workers.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as openagent from "../src/index.ts";

describe("public API", () => {
  it("exports plan function", () => {
    assert.equal(typeof openagent.plan, "function");
  });

  it("exports execute function", () => {
    assert.equal(typeof openagent.execute, "function");
  });

  it("exports check function", () => {
    assert.equal(typeof openagent.check, "function");
  });

  it("exports act function", () => {
    assert.equal(typeof openagent.act, "function");
  });

  it("exports createSession function", () => {
    assert.equal(typeof openagent.createSession, "function");
  });

  it("exports resume function", () => {
    assert.equal(typeof openagent.resume, "function");
  });

  it("exports types", () => {
    // Verify type re-exports are accessible (runtime check for ParkSession class)
    assert.equal(typeof openagent.ParkSession, "function");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test
```

Expected: FAIL — `openagent.plan` is not a function (index.ts is empty).

**Step 3: Implement workers**

Create `src/workers/plan.ts`:

```typescript
import type { PlanRequest, TaskResult } from "../types.ts";
import { PROFILES } from "../profiles.ts";
import { runSession } from "../run-session.ts";

export async function plan(request: PlanRequest): Promise<TaskResult> {
  return runSession({
    prompt: request.task,
    cwd: request.cwd,
    profile: PROFILES.plan,
    overrides: request.overrides,
    context: request.context,
    onQuestion: request.onQuestion,
    onProgress: request.onProgress,
    includeDiff: request.includeDiff,
  });
}
```

Create `src/workers/execute.ts`:

```typescript
import type { ExecuteRequest, TaskResult } from "../types.ts";
import { PROFILES } from "../profiles.ts";
import { runSession } from "../run-session.ts";

export async function execute(request: ExecuteRequest): Promise<TaskResult> {
  return runSession({
    prompt: request.plan,
    cwd: request.cwd,
    profile: PROFILES.execute,
    overrides: request.overrides,
    context: request.context,
    onQuestion: request.onQuestion,
    onProgress: request.onProgress,
    includeDiff: request.includeDiff ?? true,  // execute defaults to including diff
  });
}
```

Create `src/workers/check.ts`:

```typescript
import type { CheckRequest, TaskResult } from "../types.ts";
import { PROFILES } from "../profiles.ts";
import { runSession } from "../run-session.ts";

export async function check(request: CheckRequest): Promise<TaskResult> {
  const prompt = request.plan
    ? `Plan:\n${request.plan}\n\nVerify:\n${request.task}`
    : request.task;

  return runSession({
    prompt,
    cwd: request.cwd,
    profile: PROFILES.check,
    overrides: request.overrides,
    context: request.context,
    onQuestion: request.onQuestion,
    onProgress: request.onProgress,
    includeDiff: false,  // check doesn't produce diffs
  });
}
```

Create `src/workers/act.ts`:

```typescript
import type { ActRequest, TaskResult } from "../types.ts";
import { PROFILES } from "../profiles.ts";
import { runSession } from "../run-session.ts";

export async function act(request: ActRequest): Promise<TaskResult> {
  return runSession({
    prompt: request.issues,
    cwd: request.cwd,
    profile: PROFILES.act,
    overrides: request.overrides,
    context: request.context,
    onQuestion: request.onQuestion,
    onProgress: request.onProgress,
    includeDiff: request.includeDiff ?? true,  // act defaults to including diff
  });
}
```

**Step 4: Implement public API**

Replace `src/index.ts`:

```typescript
// PDCA Workers
export { plan } from "./workers/plan.ts";
export { execute } from "./workers/execute.ts";
export { check } from "./workers/check.ts";
export { act } from "./workers/act.ts";

// Raw session primitive
export { runSession as createSession } from "./run-session.ts";

// Resume a parked session
export { resume } from "./resume.ts";

// Core classes and utilities
export { ParkSession } from "./session.ts";

// Types
export type {
  TaskResult,
  TaskContext,
  PlanRequest,
  ExecuteRequest,
  CheckRequest,
  ActRequest,
  SessionRequest,
  Question,
  FileChange,
  ProgressEvent,
  WorkerProfile,
  ParkedSession,
} from "./types.ts";

// Profiles
export { PROFILES, getProfile } from "./profiles.ts";

// Feedback (parking)
export {
  parkSession,
  loadParkedSession,
  removeParkedSession,
  listParkedSessions,
} from "./feedback.ts";
```

**Step 5: Create resume function**

Create `src/resume.ts`:

```typescript
import type { TaskResult } from "./types.ts";
import { loadParkedSession, removeParkedSession } from "./feedback.ts";
import { runSession } from "./run-session.ts";

export async function resume(
  sessionId: string,
  answer: string,
): Promise<TaskResult> {
  const parked = await loadParkedSession(sessionId);

  const result = await runSession({
    prompt: answer,
    cwd: parked?.taskContext.cwd ?? process.cwd(),
    resume: sessionId,
    resumeAnswer: answer,
  });

  // Clean up parked state on successful resume
  await removeParkedSession(sessionId);

  return result;
}
```

**Step 6: Run tests**

```bash
npm test
```

Expected: all public API export tests pass.

**Step 7: Commit**

```bash
git add src/workers/ src/index.ts src/resume.ts tests/workers.test.ts
git commit -m "feat: add PDCA workers, resume, and public API surface"
```

---

### Task 8: Integration Test (Live SDK)

**Files:**
- Create: `tests/integration.test.ts`

This test runs a real SDK session. It requires the Claude CLI to be available. Skip if not in CI.

**Step 1: Write the integration test**

Create `tests/integration.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { plan } from "../src/index.ts";

describe("integration: live SDK", () => {
  it("plan worker returns structured result", async () => {
    const result = await plan({
      task: 'List the files in the current directory and describe what you see. Keep your answer under 100 words.',
      cwd: process.cwd(),
      overrides: { maxTurns: 5 },
    });

    assert.equal(typeof result.success, "boolean");
    assert.equal(typeof result.output, "string");
    assert.ok(result.output.length > 0, "output should not be empty");
    assert.equal(typeof result.sessionId, "string");
    assert.ok(
      ["end_turn", "max_turns", "error", "parked"].includes(result.stopReason),
      `unexpected stopReason: ${result.stopReason}`
    );
    assert.equal(typeof result.usage.durationMs, "number");
    assert.ok(result.usage.durationMs > 0, "durationMs should be positive");

    console.log("Integration test result:", {
      success: result.success,
      stopReason: result.stopReason,
      outputLength: result.output.length,
      durationMs: result.usage.durationMs,
    });
  });
});
```

**Step 2: Run it**

```bash
npm test -- tests/integration.test.ts
```

Expected: passes — returns a structured TaskResult with output describing the project files.

**Step 3: Add integration test script to package.json**

Add to scripts in `package.json`:

```json
"test:integration": "node --test --experimental-strip-types tests/integration.test.ts"
```

**Step 4: Commit**

```bash
git add tests/integration.test.ts package.json
git commit -m "test: add live SDK integration test for plan worker"
```

---

### Task 9: Hook Scaffolding (openagent-dispatch)

**Files:**
- Create: `~/.openclaw/hooks/openagent-dispatch/package.json`
- Create: `~/.openclaw/hooks/openagent-dispatch/handler.ts`
- Create: `~/.openclaw/hooks/openagent-dispatch/lib/router.ts`
- Create: `~/.openclaw/hooks/openagent-dispatch/lib/parked.ts`
- Create: `~/.openclaw/hooks/openagent-dispatch/lib/envelope.ts`

**Step 1: Create hook directory and package.json**

```bash
mkdir -p ~/.openclaw/hooks/openagent-dispatch/lib
```

Create `~/.openclaw/hooks/openagent-dispatch/package.json`:

```json
{
  "type": "module",
  "dependencies": {
    "openagent": "file:/home/ubuntu/projects/openagent"
  }
}
```

**Step 2: Create router**

Create `~/.openclaw/hooks/openagent-dispatch/lib/router.ts`:

```typescript
interface Envelope {
  payload?: {
    engine?: string;
    worker?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export function shouldUseSDK(envelope: Envelope): boolean {
  if (envelope.payload?.engine === "openagent") return true;
  if (envelope.payload?.engine === "legacy") return false;
  return false;
}

export type WorkerName = "plan" | "execute" | "check" | "act" | "session";

export function getWorkerName(envelope: Envelope): WorkerName {
  const w = envelope.payload?.worker;
  if (w === "plan" || w === "execute" || w === "check" || w === "act") return w;
  return "session";
}
```

**Step 3: Create envelope mapper**

Create `~/.openclaw/hooks/openagent-dispatch/lib/envelope.ts`:

```typescript
import type { TaskResult } from "openagent";

export function resultToPayload(result: TaskResult): Record<string, unknown> {
  return {
    success: result.success,
    output: result.output,
    filesChanged: result.filesChanged,
    stopReason: result.stopReason,
    costUsd: result.costUsd,
    gitDiff: result.gitDiff,
    sessionId: result.sessionId,
    usage: result.usage,
    questions: result.questions,
    parkedQuestion: result.parkedQuestion,
  };
}
```

**Step 4: Create parked session helper**

Create `~/.openclaw/hooks/openagent-dispatch/lib/parked.ts`:

```typescript
import {
  parkSession as corePark,
  loadParkedSession as coreLoad,
  removeParkedSession as coreRemove,
} from "openagent";
import type { ParkedSession, Question, TaskContext } from "openagent";

interface Envelope {
  from: string;
  threadId: string;
  payload?: Record<string, unknown>;
}

export async function parkFromEnvelope(
  envelope: Envelope,
  question: Question,
  sessionId: string,
  taskContext: TaskContext,
): Promise<void> {
  const parked: ParkedSession = {
    sessionId,
    question,
    originalFrom: envelope.from,
    threadId: envelope.threadId,
    taskContext,
    createdAt: new Date().toISOString(),
  };
  await corePark(parked);
}

export { coreLoad as loadParkedSession, coreRemove as removeParkedSession };
```

**Step 5: Create handler**

Create `~/.openclaw/hooks/openagent-dispatch/handler.ts`:

```typescript
import * as openagent from "openagent";
import { shouldUseSDK, getWorkerName } from "./lib/router.ts";
import { resultToPayload } from "./lib/envelope.ts";
import { parkFromEnvelope, loadParkedSession, removeParkedSession } from "./lib/parked.ts";

interface SystemEnvelope {
  id: string;
  from: string;
  to: string;
  intent: string;
  threadId: string;
  payload?: Record<string, unknown>;
}

type SendEnvelope = (envelope: Partial<SystemEnvelope>) => Promise<void>;

export async function handle(
  envelope: SystemEnvelope,
  sendEnvelope: SendEnvelope,
): Promise<boolean> {
  // Handle clarification answers (resume parked sessions)
  if (envelope.intent === "CLARIFICATION" && envelope.payload?.sessionId && envelope.payload?.answer) {
    return handleResume(envelope, sendEnvelope);
  }

  // Only handle TASK_REQUEST with openagent engine
  if (envelope.intent !== "TASK_REQUEST") return false;
  if (!shouldUseSDK(envelope)) return false;

  const workerName = getWorkerName(envelope);
  const task = (envelope.payload?.task ?? envelope.payload?.plan ?? envelope.payload?.issues ?? "") as string;
  const cwd = (envelope.payload?.cwd ?? process.cwd()) as string;
  const context = envelope.payload?.context as string | undefined;
  const includeDiff = (envelope.payload?.includeDiff ?? false) as boolean;

  const request = {
    task,
    plan: task,
    issues: task,
    cwd,
    context,
    includeDiff,
    onQuestion: async (question: openagent.Question): Promise<string> => {
      throw new openagent.ParkSession(question);
    },
  };

  try {
    let result: openagent.TaskResult;

    switch (workerName) {
      case "plan":
        result = await openagent.plan(request);
        break;
      case "execute":
        result = await openagent.execute(request);
        break;
      case "check":
        result = await openagent.check(request);
        break;
      case "act":
        result = await openagent.act(request);
        break;
      default:
        result = await openagent.createSession({
          prompt: task,
          cwd,
          context,
          includeDiff,
        });
        break;
    }

    await sendEnvelope({
      to: envelope.from,
      intent: "TASK_RESULT",
      threadId: envelope.threadId,
      payload: resultToPayload(result),
    });

    return true;
  } catch (err) {
    if (err instanceof openagent.ParkSession) {
      await parkFromEnvelope(
        envelope,
        err.question,
        err.question.id,
        { cwd, context },
      );

      await sendEnvelope({
        to: envelope.from,
        intent: "CLARIFICATION",
        threadId: envelope.threadId,
        payload: {
          question: err.question.text,
          sessionId: err.question.id,
          status: "parked",
        },
      });

      return true;
    }

    // Unexpected error — send error result
    await sendEnvelope({
      to: envelope.from,
      intent: "TASK_RESULT",
      threadId: envelope.threadId,
      payload: {
        success: false,
        output: err instanceof Error ? err.message : String(err),
        stopReason: "error",
      },
    });

    return true;
  }
}

async function handleResume(
  envelope: SystemEnvelope,
  sendEnvelope: SendEnvelope,
): Promise<boolean> {
  const sessionId = envelope.payload!.sessionId as string;
  const answer = envelope.payload!.answer as string;

  const parked = await loadParkedSession(sessionId);
  if (!parked) return false;

  try {
    const result = await openagent.resume(sessionId, answer);
    await removeParkedSession(sessionId);

    await sendEnvelope({
      to: parked.originalFrom,
      intent: "TASK_RESULT",
      threadId: parked.threadId,
      payload: resultToPayload(result),
    });

    return true;
  } catch (err) {
    await sendEnvelope({
      to: parked.originalFrom,
      intent: "TASK_RESULT",
      threadId: parked.threadId,
      payload: {
        success: false,
        output: err instanceof Error ? err.message : String(err),
        stopReason: "error",
      },
    });

    return true;
  }
}
```

**Step 6: Install hook dependencies**

```bash
cd ~/.openclaw/hooks/openagent-dispatch && npm install
```

**Step 7: Commit (both repos)**

```bash
cd /home/ubuntu/projects/openagent
git add -A
git commit -m "feat: complete openagent library with workers, feedback, and session management"

cd ~/.openclaw/hooks/openagent-dispatch
# If this directory is in a git repo, commit there too.
# Otherwise, this is just deployed in place.
```

---

### Task 10: Register Hook in OpenClaw Config

**Files:**
- Modify: `~/.openclaw/openclaw.json` (add hook entry)

**Step 1: Check existing hook registration format**

Read the `openclaw.json` to find how `agent-coordinator` is registered (around line 1370). Use the same format to add `openagent-dispatch`.

**Step 2: Add hook registration**

Add an entry matching the existing pattern:

```json
{
  "name": "openagent-dispatch",
  "enabled": true,
  "path": "~/.openclaw/hooks/openagent-dispatch",
  "events": ["message:received"],
  "env": {}
}
```

**Step 3: Verify OpenClaw picks up the hook**

```bash
openclaw hooks list
```

Expected: `openagent-dispatch` appears as enabled.

**Step 4: Commit config change**

If openclaw.json is tracked, commit. Otherwise note the manual change.

---

### Task 11: End-to-End Smoke Test

**Files:**
- Create: `tests/e2e.test.ts`

**Step 1: Write smoke test that sends a real envelope through the hook**

Create `tests/e2e.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../../.openclaw/hooks/openagent-dispatch/handler.ts";

describe("e2e: openagent-dispatch hook", () => {
  it("dispatches an execute task and returns structured result", async () => {
    let sentEnvelope: Record<string, unknown> | null = null;

    const mockSend = async (env: Record<string, unknown>) => {
      sentEnvelope = env;
    };

    const envelope = {
      id: "env_test_1",
      from: "pm",
      to: "dev",
      intent: "TASK_REQUEST",
      threadId: "thread_test_1",
      payload: {
        engine: "openagent",
        worker: "plan",
        task: "List the files in the current directory. Keep answer under 50 words.",
        cwd: process.cwd(),
      },
    };

    const handled = await handle(envelope, mockSend);

    assert.equal(handled, true, "hook should handle openagent requests");
    assert.ok(sentEnvelope, "should have sent a response envelope");
    assert.equal(sentEnvelope!.intent, "TASK_RESULT");
    assert.equal(sentEnvelope!.to, "pm");

    const payload = sentEnvelope!.payload as Record<string, unknown>;
    assert.equal(typeof payload.success, "boolean");
    assert.equal(typeof payload.output, "string");
    assert.ok((payload.output as string).length > 0);

    console.log("E2E result:", {
      success: payload.success,
      stopReason: payload.stopReason,
      outputLength: (payload.output as string).length,
    });
  });

  it("ignores non-openagent envelopes", async () => {
    const envelope = {
      id: "env_test_2",
      from: "pm",
      to: "dev",
      intent: "TASK_REQUEST",
      threadId: "thread_test_2",
      payload: { task: "Do something with legacy" },
    };

    const handled = await handle(envelope, async () => {});
    assert.equal(handled, false, "should not handle legacy requests");
  });
});
```

**Step 2: Run it**

```bash
node --test --experimental-strip-types tests/e2e.test.ts
```

Expected: first test sends a real task through the hook → SDK → returns structured result. Second test confirms legacy passthrough.

**Step 3: Commit**

```bash
git add tests/e2e.test.ts
git commit -m "test: add end-to-end smoke test for openagent-dispatch hook"
```

---

## Summary

| Task | What | Files | Tests |
|------|------|-------|-------|
| 1 | Project scaffolding | package.json, tsconfig.json, src/index.ts | typecheck |
| 2 | Core types | src/types.ts | 4 type validation tests |
| 3 | Worker profiles | src/profiles.ts | 10 profile assertion tests |
| 4 | Session wrapper | src/session.ts | buildSessionOptions, extractResult, ParkSession |
| 5 | Question parking | src/feedback.ts | 5 disk persistence tests |
| 6 | runSession core | src/run-session.ts | 4 config builder tests |
| 7 | Workers + API | src/workers/*.ts, src/index.ts, src/resume.ts | 7 API surface tests |
| 8 | Integration test | tests/integration.test.ts | 1 live SDK test |
| 9 | Hook scaffolding | ~/.openclaw/hooks/openagent-dispatch/ | — |
| 10 | Register hook | openclaw.json | verify with CLI |
| 11 | E2E smoke test | tests/e2e.test.ts | 2 envelope tests |
