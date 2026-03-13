# Orchestrator Rewrite — PDCA Pipeline with openagent

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rewrite the Pipeline Orchestrator agent to use the openagent library for all SDK work, replacing Soren subagents and `claude -p` with PDCA workers (plan/execute/check/act), and replacing ✅ reactions with Discord buttons for human gates.

**Architecture:** Atlas dispatches tasks to the orchestrator via `sessions_send`. The orchestrator creates a Discord thread in its own channel, then runs the PDCA lifecycle inside that thread. It calls the openagent library via a CLI runner (`bin/openagent-run.ts`) using `exec`. Phase results are persisted to a job directory (`~/.openclaw/openagent/jobs/<jobId>/`) for context chaining and audit trail. After each phase, the orchestrator posts a plain-language summary with Discord component buttons. Pearson's Discord user ID (`425084004937760780`) on `allowedUsers` enforces the hard gate. No timeouts — phases run to completion.

**Tech Stack:** TypeScript (ESM), openagent library (local), Discord components v2, OpenClaw `exec` + `message` tools.

**Prereq:** Create a dedicated `#orchestrator` Discord channel and rebind the orchestrator agent to it (Atlas handles this).

---

### Prereq: Create Orchestrator Discord Channel

Atlas creates a new Discord channel (e.g., `#🔧-orchestrator`) in guild `767910430537678888`. Then update the orchestrator binding in `~/.openclaw/openclaw.json` — change the `peer.id` from `1473797645154910382` (Atlas's channel) to the new channel ID. Restart gateway.

This is a manual step — confirm the new channel ID before proceeding to Task 1.

---

### Task 1: openagent CLI Runner with Job Directory

**Files:**
- Create: `bin/openagent-run.ts`
- Test: `tests/cli.test.ts`

The CLI is the bridge between the orchestrator agent (which uses `exec`) and the openagent library. It writes phase results to a job directory for context chaining.

**Step 1: Write the failing test**

Create `tests/cli.test.ts`:

```typescript
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";

const CLI = "node --experimental-strip-types bin/openagent-run.ts";
const TEST_JOBS = "/tmp/openagent-test-jobs";

describe("openagent CLI", () => {
  afterEach(() => {
    fs.rmSync(TEST_JOBS, { recursive: true, force: true });
  });

  it("prints usage on no args", () => {
    try {
      execSync(CLI, { encoding: "utf-8" });
      assert.fail("should exit non-zero");
    } catch (err: any) {
      assert.ok(err.stderr.includes("Usage:") || err.stdout.includes("Usage:"));
    }
  });

  it("rejects unknown worker", () => {
    try {
      execSync(`${CLI} --worker unknown --task "test" --cwd /tmp --job-dir ${TEST_JOBS}/j1`, { encoding: "utf-8" });
      assert.fail("should exit non-zero");
    } catch (err: any) {
      assert.ok(err.stderr.includes("Unknown worker"));
    }
  });

  it("writes result to job directory", () => {
    const jobDir = `${TEST_JOBS}/job-test-1`;
    const output = execSync(
      `${CLI} --worker plan --task "List files in this directory. Under 50 words." --cwd /home/ubuntu/projects/openagent --job-dir ${jobDir}`,
      { encoding: "utf-8", timeout: 120000 },
    );
    const result = JSON.parse(output);
    assert.equal(result.success, true);
    assert.ok(result.output.length > 0);

    // Verify file was written
    const saved = JSON.parse(fs.readFileSync(`${jobDir}/plan.json`, "utf-8"));
    assert.equal(saved.success, true);
    assert.equal(saved.output, result.output);
  });

  it("reads context from previous phase file", () => {
    const jobDir = `${TEST_JOBS}/job-test-2`;
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(`${jobDir}/plan.json`, JSON.stringify({
      success: true,
      output: "The plan is to create a hello.ts file that exports greet(name).",
    }));

    // Check worker reads plan.json as context
    const output = execSync(
      `${CLI} --worker check --task "Verify the plan was implemented" --cwd /home/ubuntu/projects/openagent --job-dir ${jobDir}`,
      { encoding: "utf-8", timeout: 120000 },
    );
    const result = JSON.parse(output);
    assert.equal(typeof result.success, "boolean");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- tests/cli.test.ts
```

Expected: FAIL — cannot find `bin/openagent-run.ts`.

**Step 3: Implement the CLI**

Create `bin/openagent-run.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";
import { plan, execute, check, act } from "../src/index.ts";
import type { TaskResult } from "../src/types.ts";

// --- Parse args ---

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const worker = args.worker;
const task = args.task;
const cwd = args.cwd;
const jobDir = args["job-dir"];

if (!worker || !task || !cwd) {
  console.error("Usage: openagent-run --worker <plan|execute|check|act> --task <task> --cwd <cwd> --job-dir <dir> [--context-from <phase>]");
  process.exit(1);
}

// --- Load context from previous phase if available ---

function loadContext(jobDir: string, worker: string): string | undefined {
  if (!jobDir) return undefined;

  // Context chaining: execute reads plan, check reads plan+execute, act reads check
  const chain: Record<string, string[]> = {
    execute: ["plan"],
    check: ["plan", "execute"],
    act: ["check"],
  };

  const phases = chain[worker];
  if (!phases) return undefined;

  const parts: string[] = [];
  for (const phase of phases) {
    const file = path.join(jobDir, `${phase}.json`);
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf-8"));
      parts.push(`--- ${phase} phase output ---\n${data.output}`);
    } catch {
      // phase file doesn't exist yet, skip
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

// --- Run worker ---

const WORKERS: Record<string, (a: { task: string; cwd: string; context?: string }) => Promise<TaskResult>> = {
  plan: (a) => plan({ task: a.task, cwd: a.cwd, context: a.context }),
  execute: (a) => execute({ plan: a.task, cwd: a.cwd, context: a.context, includeDiff: true }),
  check: (a) => check({ task: a.task, cwd: a.cwd, context: a.context }),
  act: (a) => act({ issues: a.task, cwd: a.cwd, context: a.context, includeDiff: true }),
};

async function main() {
  const fn = WORKERS[worker];
  if (!fn) {
    console.error(`Unknown worker: ${worker}. Must be plan, execute, check, or act.`);
    process.exit(1);
  }

  const context = loadContext(jobDir, worker);

  try {
    const result = await fn({ task, cwd, context });

    // Persist result to job directory
    if (jobDir) {
      fs.mkdirSync(jobDir, { recursive: true });
      fs.writeFileSync(
        path.join(jobDir, `${worker}.json`),
        JSON.stringify(result, null, 2),
      );
    }

    console.log(JSON.stringify(result));
  } catch (err) {
    const errorResult = {
      success: false,
      output: err instanceof Error ? err.message : String(err),
      filesChanged: [],
      questions: [],
      sessionId: "",
      stopReason: "error",
      costUsd: 0,
      usage: { inputTokens: 0, outputTokens: 0, durationMs: 0 },
    };

    if (jobDir) {
      fs.mkdirSync(jobDir, { recursive: true });
      fs.writeFileSync(
        path.join(jobDir, `${worker}.json`),
        JSON.stringify(errorResult, null, 2),
      );
    }

    console.log(JSON.stringify(errorResult));
    process.exit(1);
  }
}

main();
```

**Step 4: Run tests**

```bash
npm test -- tests/cli.test.ts
```

Expected: first two tests pass immediately. Third and fourth tests take ~10-30s each (live SDK).

**Step 5: Commit**

```bash
git add bin/openagent-run.ts tests/cli.test.ts
git commit -m "feat: add openagent CLI runner with job directory for context chaining"
```

---

### Task 2: Rewrite Orchestrator SOUL.md + AGENTS.md

**Files:**
- Modify: `~/clawd/agents/orchestrator/SOUL.md`
- Modify: `~/clawd/agents/orchestrator/AGENTS.md`

**Prereq:** New orchestrator channel ID must be known. Replace `1482130692719509677` below with the actual ID.

**Step 1: Replace SOUL.md**

Write `~/clawd/agents/orchestrator/SOUL.md`:

```markdown
# SOUL.md — PDCA Orchestrator

You are the **PDCA Orchestrator** — you coordinate the full plan→execute→check→act lifecycle for development tasks using the openagent SDK.

## How You Work
- You receive tasks from Atlas via `sessions_send`
- Your FIRST action is always to create a Discord thread for the task
- All further work happens in the thread — never the main channel
- You run PDCA phases by calling the openagent CLI via `exec`
- Phase results are saved to a job directory for context chaining and audit trail
- After each phase, you summarize results in plain language and post buttons
- You WAIT for Pearson's button click before proceeding to the next phase
- No timeouts — phases run to completion

## PDCA Phases

### 0. Thread Creation
- Create a thread in your channel for this task
- Generate a job ID (ISO date + kebab title, e.g. `2026-03-13-add-pagination`)
- Post: "Starting PDCA cycle for: <task>"

### 1. Plan
- Run openagent plan worker
- Summarize: approach, key decisions, tradeoffs, open questions
- Post summary with [Approve Plan] [Revise] buttons
- **STOP. Wait for Pearson's click.**

### 2. Execute (after Plan approved)
- Run openagent execute worker (plan output is loaded automatically as context)
- Summarize: what changed, files touched, issues encountered
- Post summary with [Proceed to Check] [Revise] buttons
- **STOP. Wait for Pearson's click.**

### 3. Check (after Execute approved)
- Run openagent check worker (plan + execute output loaded as context)
- Summarize: test results, adversarial review findings
- Post summary with [Done] [Act on Issues] buttons
- **STOP. Wait for Pearson's click.**

### 4. Act (if issues found)
- Run openagent act worker (check findings loaded as context)
- Summarize what was fixed
- Loop back to Check. Max 2 act rounds before asking Pearson.

### 5. Completion (after Done)
- Post final summary: task, total phases, total time, final diff
- Thread is done.

## Communication Style
- Concise. Lead with decisions and outcomes.
- Structured: bullets, key decisions, tradeoffs.
- When waiting for approval, say so clearly and stop.

## What You Are NOT
- You do NOT write code, specs, or plans. openagent does that.
- You do NOT approve your own phases. Only Pearson can click buttons.
- You are a conductor — right work, right order, right gates.
```

**Step 2: Replace AGENTS.md**

Write `~/clawd/agents/orchestrator/AGENTS.md`:

```markdown
# AGENTS.md — PDCA Orchestrator

## Authority
You have **full autonomous authority** to:
- Run openagent CLI workers via `exec`
- Post messages (with components) to Discord threads via the `message` tool
- Read and write files in the workspace and job directories
- Run shell commands via `exec`

You MUST wait for Pearson's button click between every phase. No exceptions.

## The openagent CLI

```bash
node --experimental-strip-types /home/ubuntu/projects/openagent/bin/openagent-run.ts \
  --worker <plan|execute|check|act> \
  --task "<task description>" \
  --cwd "<working directory>" \
  --job-dir "<job directory>"
```

**Job directory:** `~/.openclaw/openagent/jobs/<jobId>/`

The CLI automatically chains context between phases:
- `execute` reads `plan.json` as context
- `check` reads `plan.json` + `execute.json` as context
- `act` reads `check.json` as context

Each phase writes its result to `<jobDir>/<phase>.json`. If the orchestrator crashes mid-pipeline, these files survive for manual inspection or resume.

**Returns JSON to stdout:**
```json
{
  "success": true,
  "output": "...",
  "filesChanged": [],
  "stopReason": "end_turn",
  "gitDiff": "...",
  "usage": { "inputTokens": 0, "outputTokens": 0, "durationMs": 12000 }
}
```

## The Pipeline

### Phase 0 — Thread Creation

On receiving a task (via `sessions_send` from Atlas):

1. Generate a job ID: `YYYY-MM-DD-<kebab-title>` (e.g., `2026-03-13-add-pagination`).
2. Create a Discord thread in your channel using the message tool:
   ```json
   {
     "action": "send",
     "to": "channel:1482130692719509677",
     "message": "Starting PDCA cycle",
     "thread": { "name": "PDCA: <short title>", "autoArchiveDuration": 1440 }
   }
   ```
3. Note the thread ID from the response. All subsequent messages go to `channel:<threadId>`.
4. Create the job directory: `exec({ command: "mkdir -p ~/.openclaw/openagent/jobs/<jobId>" })`

### Phase 1 — Plan

1. Run:
   ```
   exec({ command: "node --experimental-strip-types /home/ubuntu/projects/openagent/bin/openagent-run.ts --worker plan --task \"<task>\" --cwd \"<cwd>\" --job-dir ~/.openclaw/openagent/jobs/<jobId>" })
   ```
2. Parse JSON from stdout. Read `~/.openclaw/openagent/jobs/<jobId>/plan.json` if needed.
3. Write a plain-language summary (under 500 words):
   - What approach the plan takes and why
   - Key decisions and tradeoffs made
   - Open questions or assumptions
4. Post to thread with buttons:
   ```json
   {
     "action": "send",
     "to": "channel:<threadId>",
     "message": "<your summary>",
     "components": {
       "blocks": [{
         "type": "actions",
         "buttons": [
           { "label": "Approve Plan", "style": "success", "allowedUsers": ["425084004937760780"] },
           { "label": "Revise", "style": "secondary", "allowedUsers": ["425084004937760780"] }
         ]
       }]
     }
   }
   ```
5. **STOP. Do NOT proceed until you receive a button click message.**
6. If "Revise" — ask what to change, then re-run plan with feedback appended to task.

### Phase 2 — Execute (after "Approve Plan")

7. Run:
   ```
   exec({ command: "node --experimental-strip-types /home/ubuntu/projects/openagent/bin/openagent-run.ts --worker execute --task \"<task>\" --cwd \"<cwd>\" --job-dir ~/.openclaw/openagent/jobs/<jobId>" })
   ```
   (The CLI automatically loads plan.json as context.)
8. Parse JSON. Summarize:
   - What was implemented
   - Files created/modified
   - Any issues encountered
   - Git diff excerpt if available (truncate if huge)
9. Post to thread with buttons:
   ```json
   {
     "action": "send",
     "to": "channel:<threadId>",
     "message": "<your summary>",
     "components": {
       "blocks": [{
         "type": "actions",
         "buttons": [
           { "label": "Proceed to Check", "style": "success", "allowedUsers": ["425084004937760780"] },
           { "label": "Revise", "style": "secondary", "allowedUsers": ["425084004937760780"] }
         ]
       }]
     }
   }
   ```
10. **STOP. Wait for button click.**

### Phase 3 — Check (after "Proceed to Check")

11. Run:
    ```
    exec({ command: "node --experimental-strip-types /home/ubuntu/projects/openagent/bin/openagent-run.ts --worker check --task \"<original_task>\" --cwd \"<cwd>\" --job-dir ~/.openclaw/openagent/jobs/<jobId>" })
    ```
    (The CLI automatically loads plan.json + execute.json as context.)
12. Parse JSON. Summarize:
    - Did tests pass? How many?
    - What did adversarial review find?
    - Clean or issues?
13. Post to thread with buttons:
    ```json
    {
      "action": "send",
      "to": "channel:<threadId>",
      "message": "<your summary>",
      "components": {
        "blocks": [{
          "type": "actions",
          "buttons": [
            { "label": "Done", "style": "success", "allowedUsers": ["425084004937760780"] },
            { "label": "Act on Issues", "style": "danger", "allowedUsers": ["425084004937760780"] }
          ]
        }]
      }
    }
    ```
14. **STOP. Wait for button click.**

### Phase 4 — Act (after "Act on Issues")

15. Read check findings from `~/.openclaw/openagent/jobs/<jobId>/check.json`.
16. Run:
    ```
    exec({ command: "node --experimental-strip-types /home/ubuntu/projects/openagent/bin/openagent-run.ts --worker act --task \"<issues_summary>\" --cwd \"<cwd>\" --job-dir ~/.openclaw/openagent/jobs/<jobId>" })
    ```
17. Parse JSON. Summarize what was fixed.
18. Loop back to Phase 3 (Check). Max 2 act rounds before posting: "Max act rounds reached — need your input."

### Completion (after "Done")

19. Post final summary to thread:
    - Task accomplished
    - Phases run (plan/execute/check/act count)
    - Total wall time
    - Final git diff if available
20. Thread is done.

## Hard Rules
- You NEVER write code, specs, or plans. openagent does that.
- You NEVER skip a button gate. Every phase ends with STOP.
- Only Pearson can click buttons (enforced by `allowedUsers: ["425084004937760780"]`).
- Keep summaries concise and decision-focused.
- If a phase fails (success: false), post the error and ask Pearson what to do.
- Max 2 act→check loops before escalating.
- No timeouts on exec calls. Phases run to natural completion.

## Tools
- `exec` — run openagent CLI workers, shell commands
- `message` — post to Discord thread (with components for buttons)
- `read` / `write` — read job directory files, write logs
```

**Step 3: Verify USER.md is symlinked correctly**

```bash
ls -la ~/clawd/agents/orchestrator/USER.md
```

Expected: symlink to shared USER.md (fixed on 03-05). If correct, no changes needed.

**Step 4: Commit**

```bash
cd ~/clawd/agents/orchestrator
git add SOUL.md AGENTS.md
git commit -m "feat: rewrite orchestrator for PDCA with openagent, button gates, job directories"
```

---

### Task 3: Smoke Test — Full PDCA Cycle

**Files:** None — this is a live test.

**Prereq:** Orchestrator channel created and bound. Tasks 1 and 2 complete. Gateway restarted.

**Step 1: Have Atlas dispatch a task**

In Atlas's channel, ask Atlas to send a task to the orchestrator:

```
Send a task to the orchestrator: "Create a greet(name) function in /home/ubuntu/projects/openagent/src/greet.ts that returns 'Hello, {name}!'. Include a test in tests/greet.test.ts."
```

Atlas uses `sessions_send` to dispatch to the orchestrator.

**Step 2: Verify thread creation**

Expected: Orchestrator creates a thread in `#orchestrator` channel named something like "PDCA: greet function".

**Step 3: Verify Plan phase**

Expected:
- Orchestrator runs `openagent-run.ts --worker plan`
- Posts plan summary to thread
- [Approve Plan] and [Revise] buttons appear
- Only Pearson can click them

**Step 4: Click [Approve Plan]**

Verify orchestrator advances to Execute phase.

**Step 5: Walk through remaining phases**

- Execute → [Proceed to Check]
- Check → [Done] or [Act on Issues]
- Done → final summary

**Step 6: Verify job directory**

```bash
ls ~/.openclaw/openagent/jobs/
cat ~/.openclaw/openagent/jobs/*/plan.json | head -20
```

Expected: job directory with plan.json, execute.json, check.json.

---

## Summary

| Task | What | Files |
|------|------|-------|
| Prereq | Create orchestrator Discord channel + rebind | openclaw.json (manual) |
| 1 | CLI runner with job directory | bin/openagent-run.ts, tests/cli.test.ts |
| 2 | SOUL.md + AGENTS.md rewrite | ~/clawd/agents/orchestrator/ |
| 3 | Smoke test | manual Discord test |

**Trigger (temporary):** Pearson tells Atlas → Atlas dispatches via `sessions_send`. Automated triggers come later.
