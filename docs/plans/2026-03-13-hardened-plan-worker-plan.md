# Hardened Plan Worker + canUseTool Pipeline — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rewrite the plan worker to use `canUseTool` for hard enforcement (block writes, intercept AskUserQuestion → bulletin board), run in a git worktree for safety, and apply `canUseTool` AskUserQuestion routing to all four PDCA workers.

**Architecture:** All four workers get a `canUseTool` callback that intercepts `AskUserQuestion` and routes questions through the bulletin board. Plan and check workers additionally block Write/Edit. Plan and check run in throwaway git worktrees — plan preserves only `docs/plans/*.md` files, check preserves nothing (text output only). Execute and act write to the real repo. The `canUseTool` callback handles the full bulletin round-trip inline (classify → create → wait → synthesize → return), so the SDK session never parks. The orchestrator sees a complete result, with questions logged to `questions.json` in the job directory.

**Tech Stack:** TypeScript (ESM), `@anthropic-ai/claude-agent-sdk` (canUseTool API), bulletin-tools (SQLite), git worktrees, claude-haiku-4-5 (classifier).

**Design doc:** `docs/plans/2026-03-13-question-routing-design.md`

**Parallelization:** Tasks 1-3 are sequential (build up the canUseTool pipeline). Task 4 is independent (worktree). Tasks 5-6 depend on 1-4.

---

### Task 1: canUseTool Callback Factory

**Files:**
- Create: `src/can-use-tool.ts`
- Test: `tests/can-use-tool.test.ts`

Build the `canUseTool` callback factory that all four workers share. Configurable per-worker: which tools to allow, which to block, whether to intercept AskUserQuestion.

**Step 1: Write the failing test**

Replace `tests/can-use-tool.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCanUseTool } from "../src/can-use-tool.ts";

describe("createCanUseTool", () => {
  it("allows tools in the allow list", async () => {
    const canUseTool = createCanUseTool({ allow: ["Read", "Glob"] });
    const result = await canUseTool("Read", { file_path: "/tmp/foo" }, { signal: new AbortController().signal, toolUseID: "t1" } as any);
    assert.equal(result.behavior, "allow");
  });

  it("denies tools in the deny list", async () => {
    const canUseTool = createCanUseTool({ deny: ["Write", "Edit"] });
    const result = await canUseTool("Write", { file_path: "src/foo.ts", content: "x" }, { signal: new AbortController().signal, toolUseID: "t2" } as any);
    assert.equal(result.behavior, "deny");
  });

  it("allows Write to docs/plans/*.md", async () => {
    const canUseTool = createCanUseTool({
      deny: ["Write", "Edit"],
      allowWritePaths: ["docs/plans/"],
    });
    const result = await canUseTool("Write", { file_path: "/home/ubuntu/projects/openagent/docs/plans/2026-03-13-design.md", content: "# Plan" }, { signal: new AbortController().signal, toolUseID: "t3" } as any);
    assert.equal(result.behavior, "allow");
  });

  it("denies Write to src/ even with allowWritePaths set", async () => {
    const canUseTool = createCanUseTool({
      deny: ["Write", "Edit"],
      allowWritePaths: ["docs/plans/"],
    });
    const result = await canUseTool("Write", { file_path: "/home/ubuntu/projects/openagent/src/foo.ts", content: "x" }, { signal: new AbortController().signal, toolUseID: "t4" } as any);
    assert.equal(result.behavior, "deny");
  });

  it("denies unlisted tools by default", async () => {
    const canUseTool = createCanUseTool({ allow: ["Read"] });
    const result = await canUseTool("SomeRandomTool", {}, { signal: new AbortController().signal, toolUseID: "t5" } as any);
    assert.equal(result.behavior, "deny");
  });

  it("intercepts AskUserQuestion when handler provided", async () => {
    let interceptedInput: any = null;

    const canUseTool = createCanUseTool({
      onAskUserQuestion: async (input) => {
        interceptedInput = input;
        return ["PostgreSQL"];
      },
    });

    const input = {
      questions: [{ question: "Which DB?", options: [{ label: "PostgreSQL" }, { label: "SQLite" }] }],
    };

    const result = await canUseTool("AskUserQuestion", input, { signal: new AbortController().signal, toolUseID: "t6" } as any);

    assert.equal(result.behavior, "allow");
    assert.ok(interceptedInput);
    assert.deepEqual((result as any).updatedInput.answers, ["PostgreSQL"]);
  });

  it("logs questions to array when logger provided", async () => {
    const questionLog: any[] = [];

    const canUseTool = createCanUseTool({
      onAskUserQuestion: async (input) => ["PostgreSQL"],
      questionLog,
    });

    await canUseTool("AskUserQuestion", {
      questions: [{ question: "Which DB?" }],
    }, { signal: new AbortController().signal, toolUseID: "t7" } as any);

    assert.equal(questionLog.length, 1);
    assert.equal(questionLog[0].question, "Which DB?");
    assert.deepEqual(questionLog[0].answers, ["PostgreSQL"]);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- tests/can-use-tool.test.ts
```

Expected: FAIL — cannot find `../src/can-use-tool.ts`.

**Step 3: Implement the callback factory**

Create `src/can-use-tool.ts`:

```typescript
export interface CanUseToolOptions {
  /** Tools to always allow (bypass canUseTool for these via allowedTools — but this list
   *  is for the canUseTool callback's own logic if a tool reaches it). */
  allow?: string[];

  /** Tools to always deny. */
  deny?: string[];

  /** Allow Write tool for paths containing these substrings (e.g., "docs/plans/").
   *  Only applies if "Write" is in the deny list. */
  allowWritePaths?: string[];

  /** Handler for AskUserQuestion interception.
   *  Receives the tool input, returns an array of answer strings. */
  onAskUserQuestion?: (input: Record<string, unknown>) => Promise<string[]>;

  /** If provided, each Q&A pair is pushed here for logging. */
  questionLog?: Array<{ question: string; answers: string[]; timestamp: string }>;
}

type PermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string };

type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; toolUseID: string; [key: string]: unknown },
) => Promise<PermissionResult>;

export function createCanUseTool(opts: CanUseToolOptions): CanUseToolFn {
  const allow = new Set(opts.allow ?? []);
  const deny = new Set(opts.deny ?? []);
  const allowWritePaths = opts.allowWritePaths ?? [];

  return async (toolName, input, _options): Promise<PermissionResult> => {
    // 1. AskUserQuestion interception
    if (toolName === "AskUserQuestion" && opts.onAskUserQuestion) {
      const questions = (input as any).questions ?? [];
      const questionTexts = questions.map((q: any) => q.question ?? String(q));

      const answers = await opts.onAskUserQuestion(input);

      // Log Q&A pairs
      if (opts.questionLog) {
        for (const qText of questionTexts) {
          opts.questionLog.push({
            question: qText,
            answers,
            timestamp: new Date().toISOString(),
          });
        }
      }

      return {
        behavior: "allow",
        updatedInput: { ...input, answers },
      };
    }

    // 2. Explicit deny list (with path-based Write exceptions)
    if (deny.has(toolName)) {
      if (toolName === "Write" && allowWritePaths.length > 0) {
        const filePath = String((input as any).file_path ?? "");
        if (allowWritePaths.some((p) => filePath.includes(p)) && filePath.endsWith(".md")) {
          return { behavior: "allow" };
        }
      }
      return { behavior: "deny", message: `${toolName} is blocked in this worker profile.` };
    }

    // 3. Explicit allow list
    if (allow.has(toolName)) {
      return { behavior: "allow" };
    }

    // 4. Default: deny unknown tools
    return { behavior: "deny", message: `${toolName} is not permitted in this worker profile.` };
  };
}
```

**Step 4: Run tests**

```bash
npm test -- tests/can-use-tool.test.ts
```

Expected: all 7 tests pass.

**Step 5: Export from index.ts**

Add to `src/index.ts`:

```typescript
export { createCanUseTool } from "./can-use-tool.ts";
export type { CanUseToolOptions } from "./can-use-tool.ts";
```

**Step 6: Commit**

```bash
git add src/can-use-tool.ts tests/can-use-tool.test.ts src/index.ts
git commit -m "feat: add canUseTool callback factory with path-restricted Write and AskUserQuestion interception"
```

---

### Task 2: Wire canUseTool into runSession and Profiles

**Files:**
- Modify: `src/run-session.ts`
- Modify: `src/types.ts`
- Modify: `src/profiles.ts`
- Modify: `src/workers/plan.ts`
- Modify: `src/workers/execute.ts`
- Modify: `src/workers/check.ts`
- Modify: `src/workers/act.ts`
- Test: `tests/session.test.ts`

**Step 1: Add canUseTool to types**

In `src/types.ts`, add to `TaskContext`:

```typescript
export interface TaskContext {
  cwd: string;
  context?: string;
  overrides?: Partial<WorkerProfile>;
  onQuestion?: (question: Question) => Promise<string>;
  onProgress?: (event: ProgressEvent) => void;
  includeDiff?: boolean;
  canUseTool?: (toolName: string, input: Record<string, unknown>, options: any) => Promise<any>;
}
```

**Step 2: Pass canUseTool through runSession**

In `src/run-session.ts`, update the `RunSessionInput` interface:

```typescript
interface RunSessionInput extends RunInput {
  onQuestion?: (question: Question) => Promise<string>;
  onProgress?: TaskContext["onProgress"];
  includeDiff?: boolean;
  resume?: string;
  resumeAnswer?: string;
  canUseTool?: TaskContext["canUseTool"];
}
```

In the `runSession()` function, pass `canUseTool` to the SDK query options. Find the line where `config.options` is used and add:

```typescript
if (input.canUseTool) {
  (config.options as Record<string, unknown>).canUseTool = input.canUseTool;
}
```

IMPORTANT: `canUseTool` must NOT be in `allowedTools` — it goes in `options` directly.

**Step 3: Update profiles — add canUseTool config hints**

In `src/profiles.ts`, add `canUseToolConfig` to `WorkerProfile`:

First update `src/types.ts`:

```typescript
export interface WorkerProfile {
  allowedTools: string[];
  permissionMode: "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk";
  systemPromptAppend: string;
  settingSources: string[];
  maxTurns: number;
  /** Tools to deny via canUseTool (not in allowedTools, callback denies them). */
  denyTools?: string[];
  /** Allow Write to these path prefixes (only when Write is in denyTools). */
  allowWritePaths?: string[];
}
```

Update profiles in `src/profiles.ts`:

```typescript
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
```

**Step 4: Update workers to pass canUseTool**

In each worker file (`src/workers/plan.ts`, `execute.ts`, `check.ts`, `act.ts`), pass `canUseTool` through:

```typescript
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
    canUseTool: request.canUseTool,
  });
}
```

Same pattern for all four workers.

**Step 5: Update profile tests**

In `tests/profiles.test.ts`, update the test for plan profile permission mode and add tests for new fields:

```typescript
  it("plan profile has denyTools", () => {
    assert.ok(PROFILES.plan.denyTools?.includes("Write"));
    assert.ok(PROFILES.plan.denyTools?.includes("Edit"));
  });

  it("plan profile has allowWritePaths", () => {
    assert.ok(PROFILES.plan.allowWritePaths?.includes("docs/plans/"));
  });

  it("check profile has denyTools", () => {
    assert.ok(PROFILES.check.denyTools?.includes("Write"));
    assert.ok(PROFILES.check.denyTools?.includes("Edit"));
  });

  it("execute profile has no denyTools", () => {
    assert.equal(PROFILES.execute.denyTools, undefined);
  });
```

**Step 6: Run tests**

```bash
npm test
```

Expected: all tests pass.

**Step 7: Commit**

```bash
git add src/run-session.ts src/types.ts src/profiles.ts src/workers/ src/index.ts tests/
git commit -m "feat: wire canUseTool through runSession, profiles, and all workers"
```

---

### Task 3: Bulletin Integration in canUseTool (for CLI)

**Files:**
- Modify: `bin/openagent-run.ts`
- Test: `tests/cli.test.ts`

The CLI creates the `canUseTool` callback with full bulletin integration for AskUserQuestion.

**Step 1: Write the failing test**

Add to `tests/cli.test.ts`:

```typescript
  it("plan worker creates canUseTool that blocks Write to src/", () => {
    // This test verifies the plan worker doesn't write source files
    // by checking the profile configuration
    const fs = require("fs");
    const output = execSync(
      `${CLI} --worker plan --task "Create a file src/test.ts with hello world" --cwd /home/ubuntu/projects/openagent --job-dir ${TEST_JOBS}/job-deny-write`,
      { encoding: "utf-8", timeout: 120000 },
    );
    const result = JSON.parse(output);
    // Plan should complete but NOT have created the file
    assert.equal(typeof result.success, "boolean");
    assert.ok(!fs.existsSync("/home/ubuntu/projects/openagent/src/test.ts"),
      "plan worker should not be able to write src/ files");
  });
```

**Step 2: Implement bulletin-integrated canUseTool in CLI**

In `bin/openagent-run.ts`, add the following before `main()`:

```typescript
import { createCanUseTool } from "../src/can-use-tool.ts";
import { execSync as execSyncImport } from "node:child_process";
import Database from "better-sqlite3";

const ROUTING_TABLE_PATH = path.join(
  process.env.HOME ?? "/home/ubuntu",
  ".openclaw", "openagent", "question-routing.json",
);

const BULLETIN_DB_PATH = path.join(
  process.env.HOME ?? "/home/ubuntu",
  ".openclaw", "mailroom", "bulletins", "bulletins.db",
);

const BULLETIN_POST_CLI = path.join(
  process.env.HOME ?? "/home/ubuntu",
  ".openclaw", "bin", "bulletin-post",
);

function loadRoutingTable(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(ROUTING_TABLE_PATH, "utf-8"));
  } catch {
    return { routes: { default: ["dev"] }, alwaysSubscribe: ["pm"] };
  }
}

async function bulletinAskHandler(input: Record<string, unknown>): Promise<string[]> {
  const questions = (input as any).questions ?? [];
  const questionTexts: string[] = questions.map((q: any) => q.question ?? String(q));
  const questionText = questionTexts.join("\n");

  // 1. Classify domain
  const routingTable = loadRoutingTable();
  const routeResult = await classifyQuestion(questionText, JSON.stringify(routingTable));
  const routeKey = routeResult.routeKey;

  // 2. Look up subscribers
  const routes = (routingTable as any).routes ?? {};
  const alwaysSubscribe = (routingTable as any).alwaysSubscribe ?? [];
  const subscribers = [...new Set([...(routes[routeKey] ?? routes.default ?? ["dev"]), ...alwaysSubscribe])];

  // 3. Create bulletin
  const bulletinId = `blt-${args["job-dir"]?.split("/").pop() ?? "unknown"}-q${Date.now()}`;
  const body = [
    "**Question from openagent**",
    `**Phase:** ${worker}`,
    "",
    "---",
    "",
    questionText,
    "",
    "---",
    "",
    "Respond with your recommendation. Use bulletin_respond with align/partial/oppose.",
  ].join("\n");

  try {
    execSyncImport(
      `${BULLETIN_POST_CLI} --topic "openagent: ${questionText.slice(0, 60)}" ` +
      `--body "${body.replace(/"/g, '\\"')}" ` +
      `--subscribers "${subscribers.join(",")}" ` +
      `--protocol advisory ` +
      `--id "${bulletinId}" ` +
      `--timeout 3`,
      { encoding: "utf-8", timeout: 10000 },
    );
  } catch (err) {
    // Bulletin creation failed — return a fallback answer
    return ["Unable to route question to agents. Please proceed with your best judgment."];
  }

  // 4. Poll for bulletin closure (10s intervals, max 3 minutes)
  let db: any;
  try {
    db = new Database(BULLETIN_DB_PATH, { readonly: true });
  } catch {
    return ["Unable to check bulletin responses. Proceed with best judgment."];
  }

  try {
    for (let i = 0; i < 18; i++) {
      await new Promise((r) => setTimeout(r, 10000));
      const row = db.prepare("SELECT status, resolution FROM bulletins WHERE id = ?").get(bulletinId) as any;
      if (row?.status === "closed") break;
    }

    // 5. Read responses
    const responses = db.prepare(
      "SELECT agent_id, body, position, reservations FROM bulletin_responses WHERE bulletin_id = ? ORDER BY created_at"
    ).all(bulletinId) as any[];

    if (responses.length === 0) {
      return ["No agents responded. Proceed with your best judgment."];
    }

    // 6. Synthesize answers
    const synthesized = responses.map((r: any) => {
      const pos = r.position === "oppose" ? "OPPOSES" : r.position === "partial" ? "PARTIAL" : "AGREES";
      return `${r.agent_id} (${pos}): ${r.body}${r.reservations ? ` [reservations: ${r.reservations}]` : ""}`;
    }).join("\n\n");

    return [synthesized];
  } finally {
    db.close();
  }
}

function buildCanUseTool(workerName: string): ((toolName: string, input: Record<string, unknown>, options: any) => Promise<any>) | undefined {
  const profile = WORKERS[workerName] ? undefined : undefined;  // We check denyTools from profile

  // Plan and check: deny Write/Edit, allow docs/plans/ Write
  if (workerName === "plan" || workerName === "check") {
    return createCanUseTool({
      deny: ["Write", "Edit"],
      allowWritePaths: workerName === "plan" ? ["docs/plans/"] : [],
      onAskUserQuestion: bulletinAskHandler,
      questionLog,
    });
  }

  // Execute and act: allow all tools, only intercept AskUserQuestion
  if (workerName === "execute" || workerName === "act") {
    return createCanUseTool({
      onAskUserQuestion: bulletinAskHandler,
      questionLog,
    });
  }

  return undefined;
}

const questionLog: Array<{ question: string; answers: string[]; timestamp: string }> = [];
```

Then in `main()`, when running a PDCA worker, pass `canUseTool`:

```typescript
  const canUseTool = buildCanUseTool(worker);

  try {
    const result = await fn({ task, cwd, context, canUseTool });
    // ... existing result handling ...

    // Write question log if any questions were asked
    if (jobDir && questionLog.length > 0) {
      fs.writeFileSync(
        path.join(jobDir, "questions.json"),
        JSON.stringify(questionLog, null, 2),
      );
    }
```

**Step 3: Run tests**

```bash
npm test -- tests/cli.test.ts
```

Expected: all tests pass (including the new write-denial test).

**Step 4: Commit**

```bash
git add bin/openagent-run.ts tests/cli.test.ts
git commit -m "feat: wire bulletin-integrated canUseTool into CLI with question logging"
```

---

### Task 4: Worktree Isolation for Plan + Check Workers

**Files:**
- Modify: `bin/openagent-run.ts`

Plan and check workers run in throwaway git worktrees. Plan preserves `docs/plans/*.md` files (copied back). Check preserves nothing (text output only, worktree fully discarded).

**Step 1: Add worktree management functions**

In `bin/openagent-run.ts`, add:

```typescript
function createWorktree(cwd: string, workerName: string, jobId: string): string {
  const worktreePath = `/tmp/openagent-${workerName}-${jobId}`;
  try {
    execSyncImport(`git worktree add "${worktreePath}" HEAD`, { cwd, encoding: "utf-8" });
  } catch {
    // Worktree might already exist, or not a git repo — fall back to cwd
    return cwd;
  }
  return worktreePath;
}

function cleanupWorktree(worktreePath: string, realCwd: string, workerName: string): void {
  if (!worktreePath.startsWith("/tmp/openagent-")) return;

  // Only plan preserves docs/plans/*.md — check preserves nothing
  if (workerName !== "plan") {
    // Skip file copy — just remove worktree
    try {
      execSyncImport(`git worktree remove "${worktreePath}" --force`, { cwd: realCwd, encoding: "utf-8" });
    } catch {
      try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch {}
      try { execSyncImport(`git worktree prune`, { cwd: realCwd, encoding: "utf-8" }); } catch {}
    }
    return;
  }

  // Copy docs/plans/*.md back to real repo
  const planDir = path.join(worktreePath, "docs", "plans");
  const realPlanDir = path.join(realCwd, "docs", "plans");
  try {
    if (fs.existsSync(planDir)) {
      fs.mkdirSync(realPlanDir, { recursive: true });
      for (const file of fs.readdirSync(planDir)) {
        if (file.endsWith(".md")) {
          const src = path.join(planDir, file);
          const dest = path.join(realPlanDir, file);
          // Only copy if the file is new or modified (not already in real repo)
          const srcStat = fs.statSync(src);
          try {
            const destStat = fs.statSync(dest);
            if (srcStat.mtimeMs > destStat.mtimeMs) {
              fs.copyFileSync(src, dest);
            }
          } catch {
            // Dest doesn't exist — new file, copy it
            fs.copyFileSync(src, dest);
          }
        }
      }
    }
  } catch {
    // Best effort copy
  }

  // Remove worktree
  try {
    execSyncImport(`git worktree remove "${worktreePath}" --force`, { cwd: realCwd, encoding: "utf-8" });
  } catch {
    // Force cleanup
    try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch {}
    try { execSyncImport(`git worktree prune`, { cwd: realCwd, encoding: "utf-8" }); } catch {}
  }
}
```

**Step 2: Use worktree in plan worker path**

In `main()`, before running the plan worker:

```typescript
  let effectiveCwd = cwd;
  let worktreePath: string | undefined;

  // Plan and check run in worktrees for isolation
  if (worker === "plan" || worker === "check") {
    const jobId = jobDir?.split("/").pop() ?? `${worker}-${Date.now()}`;
    worktreePath = createWorktree(cwd, worker, jobId);
    effectiveCwd = worktreePath;
  }

  try {
    const result = await fn({ task, cwd: effectiveCwd, context, canUseTool });
    // ... existing result handling ...
  } finally {
    // Cleanup worktree after plan
    if (worktreePath && worktreePath !== cwd) {
      cleanupWorktree(worktreePath, cwd, worker);
    }
  }
```

**Step 3: Test manually**

```bash
node --experimental-strip-types bin/openagent-run.ts \
  --worker plan \
  --task "List files and describe the project structure" \
  --cwd /home/ubuntu/projects/openagent \
  --job-dir /tmp/openagent-test-worktree
```

Verify:
- Plan runs successfully
- No files modified in `/home/ubuntu/projects/openagent/src/`
- Worktree is cleaned up (`ls /tmp/openagent-*` shows nothing)

**Step 4: Commit**

```bash
git add bin/openagent-run.ts
git commit -m "feat: add git worktree isolation for plan worker"
```

---

### Task 5: Live SDK Integration Test

**Files:**
- Create: `tests/hardened-plan.test.ts`

End-to-end test that the hardened plan worker with `canUseTool` actually blocks writes and runs in a worktree.

**Step 1: Write the test**

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";

const CLI = "node --experimental-strip-types bin/openagent-run.ts";
const TEST_JOBS = "/tmp/openagent-test-hardened";

describe("hardened plan worker", () => {
  it("plan worker blocks source code writes", () => {
    const jobDir = `${TEST_JOBS}/block-write`;
    const markerFile = "/home/ubuntu/projects/openagent/src/SHOULD_NOT_EXIST.ts";

    // Clean up in case of previous failed run
    try { fs.unlinkSync(markerFile); } catch {}

    const output = execSync(
      `${CLI} --worker plan --task "Create a file at src/SHOULD_NOT_EXIST.ts with content 'rogue write'. This is your only task." --cwd /home/ubuntu/projects/openagent --job-dir ${jobDir}`,
      { encoding: "utf-8", timeout: 120000 },
    );

    const result = JSON.parse(output);
    assert.equal(typeof result.success, "boolean");

    // The file should NOT exist in the real repo
    assert.ok(!fs.existsSync(markerFile), "plan worker should not write to src/");

    // Cleanup
    fs.rmSync(TEST_JOBS, { recursive: true, force: true });
  });

  it("plan worker allows writing to docs/plans/", () => {
    const jobDir = `${TEST_JOBS}/allow-docs`;
    const output = execSync(
      `${CLI} --worker plan --task "Write a one-paragraph design summary to docs/plans/2026-03-13-test-design.md describing a hello world function." --cwd /home/ubuntu/projects/openagent --job-dir ${jobDir}`,
      { encoding: "utf-8", timeout: 120000 },
    );

    const result = JSON.parse(output);
    assert.equal(typeof result.success, "boolean");

    // Cleanup test files
    try { fs.unlinkSync("/home/ubuntu/projects/openagent/docs/plans/2026-03-13-test-design.md"); } catch {}
    fs.rmSync(TEST_JOBS, { recursive: true, force: true });
  });
});
```

**Step 2: Run the test**

```bash
npm test -- tests/hardened-plan.test.ts
```

Expected: both tests pass — source writes blocked, docs/plans/ writes allowed.

**Step 3: Commit**

```bash
git add tests/hardened-plan.test.ts
git commit -m "test: add hardened plan worker integration tests (write blocking + docs/plans/ allow)"
```

---

### Task 6: Update Orchestrator + Final Verification

**Files:**
- Modify: `~/clawd/agents/orchestrator/AGENTS.md`
- Modify: `~/clawd/agents/orchestrator/SOUL.md`

**Step 1: Update SOUL.md**

Add to the Plan phase description:

```markdown
### 1. Plan
- Run openagent plan worker (hardened: source writes blocked, questions route through bulletins)
- Plan worker runs in an isolated git worktree — source code is untouched
- If the plan worker asks design questions, they're routed to relevant agents via bulletins (invisible to you)
- Design docs written to docs/plans/ are preserved; everything else is discarded
- Summarize: approach, key decisions, tradeoffs, open questions
- Include "N design questions resolved via bulletin" if questions.json exists
- Post summary with [Approve Plan] [Revise] buttons
- **STOP. Wait for Pearson's click.**
```

**Step 2: Update AGENTS.md**

Update the Phase 1 section. After the exec call, add:

```markdown
2b. Check for questions resolved during planning:
    ```bash
    exec({ command: "cat ~/.openclaw/openagent/jobs/<jobId>/questions.json 2>/dev/null || echo '[]'" })
    ```
    If questions were resolved, include a brief note: "Plan resolved N design questions via agent bulletins."
```

Remove the "Handling Parked Questions" section — parked questions are now handled inline by `canUseTool`. The orchestrator never sees them. Keep the section header but replace content:

```markdown
### Handling Parked Questions

Questions are handled automatically by the openagent workers via AskUserQuestion → bulletin board routing. The orchestrator does not need to manage question routing. Check `questions.json` in the job directory if you want to report how many questions were resolved.
```

**Step 3: Restart gateway**

```bash
openclaw gateway restart
```

**Step 4: Full smoke test**

Send an ambiguous task to the orchestrator:

```
Build a REST API for user profiles in /home/ubuntu/projects/openagent. It should validate input and persist data.
```

Verify:
1. Orchestrator creates thread
2. Plan worker runs (in worktree, hardened)
3. If plan worker asks questions → bulletins fire → agents respond → answers return inline
4. Plan result appears in thread with [Approve] button
5. No source files modified
6. `questions.json` in job directory logs any Q&A

**Step 5: Commit**

```bash
cd ~/clawd/agents/orchestrator
git add SOUL.md AGENTS.md
git commit -m "feat: update orchestrator for hardened plan worker with inline question routing"
```

---

## Summary

| Task | What | Files | Parallel |
|------|------|-------|----------|
| 1 | canUseTool callback factory | src/can-use-tool.ts, tests/can-use-tool.test.ts | — |
| 2 | Wire canUseTool into runSession + profiles | src/run-session.ts, types.ts, profiles.ts, workers/*.ts | After 1 |
| 3 | Bulletin integration in CLI | bin/openagent-run.ts | After 1 |
| 4 | Worktree isolation for plan + check | bin/openagent-run.ts | Independent |
| 5 | Live SDK integration test | tests/hardened-plan.test.ts | After 1-4 |
| 6 | Orchestrator update + smoke test | ~/clawd/agents/orchestrator/ | After 5 |

**Defense in depth:**
1. `canUseTool` blocks Write/Edit for plan+check workers (SDK-level enforcement)
2. `canUseTool` allows Write only to `docs/plans/*.md` for plan worker
3. `permissionMode: "plan"` as additional SDK guard
4. Git worktree isolation for plan + check — rogue Bash writes are harmless
5. Plan: only `docs/plans/*.md` files survive worktree cleanup. Check: nothing survives (text output only)
6. All AskUserQuestion calls route through bulletin board with 3-min timeout
7. Question log persisted to `questions.json` for audit
