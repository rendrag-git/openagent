# Question Routing via Bulletin Board — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire ParkSession/resume to the bulletin board system so SDK questions get multi-agent coordination with critique rounds, then the orchestrator synthesizes and resumes.

**Architecture:** The orchestrator catches parked questions, classifies the domain via Haiku, creates an advisory bulletin with routed subscribers, and pauses. The bulletin-tools plugin runs discussion + critique, then posts a `closedNotify` callback to the orchestrator's PDCA thread. The orchestrator synthesizes and resumes the SDK session. 3-minute timeout prevents permanent parking.

**Tech Stack:** TypeScript (ESM), openagent library, bulletin-tools plugin (SQLite), claude-haiku-4-5, OpenClaw `exec` + `message` tools.

**Design doc:** `docs/plans/2026-03-13-question-routing-design.md`

**Parallelization:** Tasks 2, 3, 4 are independent of each other. Tasks 5, 6, 7 form a chain. After all complete, Tasks 8 and 9.

```
Pre-req (Task 1)
    ↓
┌───────────────────┬────────────────────┬──────────────────────┐
│ Task 2: routing   │ Task 3: classify   │ Task 5: closedNotify │
│ table (config)    │ worker (CLI)       │ (bulletin-tools)     │
│                   │                    │         ↓            │
│                   │ Task 4: resume     │ Task 6: timeout      │
│                   │ worker (CLI)       │ (bulletin-tools)     │
│                   │                    │         ↓            │
│                   │                    │ Task 7: CLI flags    │
│                   │                    │ (bulletin-post)      │
└───────────────────┴────────────────────┴──────────────────────┘
                            ↓
                   Task 8: Orchestrator update
                            ↓
                   Task 9: E2E smoke test
```

---

### Task 1: Pre-req — Verify ParkSession/resume Works End-to-End

**Files:**
- Test: `tests/resume.test.ts`

The entire question routing pipeline depends on resume() working. Verify it before building on top.

**Step 1: Write the test**

Create `tests/resume.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parkSession, loadParkedSession, removeParkedSession } from "../src/feedback.ts";
import { resume } from "../src/resume.ts";
import type { ParkedSession } from "../src/types.ts";

const TEST_DIR = "/tmp/openagent-test-resume";

describe("ParkSession/resume flow", () => {
  it("parks a session and loads it back", async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const parked: ParkedSession = {
      sessionId: "sess_resume_test",
      question: {
        id: "q_resume_1",
        text: "Which database?",
        timestamp: new Date().toISOString(),
        answered: false,
      },
      originalFrom: "orchestrator",
      threadId: "thread_test",
      taskContext: { cwd: "/home/ubuntu/projects/openagent" },
      createdAt: new Date().toISOString(),
    };

    await parkSession(parked, TEST_DIR);
    const loaded = await loadParkedSession("sess_resume_test", TEST_DIR);

    assert.ok(loaded);
    assert.equal(loaded!.question.text, "Which database?");
    assert.equal(loaded!.originalFrom, "orchestrator");

    // Cleanup
    await removeParkedSession("sess_resume_test", TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("resume function exists and is callable", () => {
    assert.equal(typeof resume, "function");
  });
});
```

**Step 2: Run test**

```bash
npm test -- tests/resume.test.ts
```

Expected: both tests pass.

**Step 3: Commit**

```bash
git add tests/resume.test.ts
git commit -m "test: verify ParkSession/resume flow for question routing prereq"
```

---

### Task 2: Routing Table Config

**Files:**
- Create: `~/.openclaw/openagent/question-routing.json`

**Can run in parallel with Tasks 3, 4, 5.**

**Step 1: Create the config file**

```bash
mkdir -p ~/.openclaw/openagent
```

Create `~/.openclaw/openagent/question-routing.json`:

```json
{
  "routes": {
    "architecture": ["dev", "soren"],
    "database": ["db", "dev"],
    "api": ["dev", "aws"],
    "infrastructure": ["aws", "dev"],
    "compliance": ["legal", "compliance"],
    "product": ["product"],
    "ux": ["product"],
    "security": ["dev", "aws"],
    "budget": ["pearson"],
    "deployment": ["pearson", "dev"],
    "human": ["pearson"],
    "default": ["dev"]
  },
  "alwaysSubscribe": ["pm"]
}
```

**Step 2: Verify it parses**

```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('$HOME/.openclaw/openagent/question-routing.json', 'utf-8')))"
```

Expected: prints the JSON object without errors.

---

### Task 3: Classify Worker (Haiku Domain Classifier)

**Files:**
- Modify: `bin/openagent-run.ts`
- Test: `tests/cli.test.ts`

**Can run in parallel with Tasks 2, 4, 5.**

**Step 1: Write the failing test**

Add to `tests/cli.test.ts`:

```typescript
  it("classify worker returns a valid route key", () => {
    const routingTable = JSON.stringify({
      routes: {
        architecture: ["dev", "soren"],
        database: ["db", "dev"],
        api: ["dev", "aws"],
        infrastructure: ["aws", "dev"],
        compliance: ["legal", "compliance"],
        product: ["product"],
        human: ["pearson"],
        default: ["dev"],
      },
    });
    const output = execSync(
      `${CLI} --worker classify --task "Which database adapter should we use for pagination?" --cwd /tmp --routing '${routingTable}'`,
      { encoding: "utf-8", timeout: 30000 },
    );
    const result = JSON.parse(output);
    assert.equal(typeof result.routeKey, "string");
    assert.ok(
      ["architecture", "database", "api", "infrastructure", "compliance", "product", "human", "default"].includes(result.routeKey),
      `unexpected route key: ${result.routeKey}`,
    );
    // A database question should classify as "database"
    assert.equal(result.routeKey, "database");
  });
```

**Step 2: Run test to verify it fails**

```bash
npm test -- tests/cli.test.ts --test-name-pattern="classify"
```

Expected: FAIL — classify not in WORKERS.

**Step 3: Implement the classify worker**

In `bin/openagent-run.ts`, add after the existing WORKERS definition:

```typescript
import { createSession } from "../src/index.ts";

// --- Classify worker (Haiku domain classifier) ---

async function classify(task: string, routingJson: string): Promise<{ routeKey: string }> {
  let routeKeys: string[];
  try {
    const routing = JSON.parse(routingJson);
    routeKeys = Object.keys(routing.routes ?? routing);
  } catch {
    return { routeKey: "default" };
  }

  const prompt =
    `Classify this question into exactly ONE of these categories: ${routeKeys.join(", ")}\n\n` +
    `Question: "${task}"\n\n` +
    `Reply with ONLY the category name, nothing else.`;

  try {
    const result = await createSession({
      prompt,
      cwd: "/tmp",
      overrides: {
        maxTurns: 1,
        allowedTools: [],
      },
      systemPrompt: "You are a classifier. Reply with exactly one word — the category name.",
    });

    const key = result.output.trim().toLowerCase().replace(/[^a-z_-]/g, "");
    return { routeKey: routeKeys.includes(key) ? key : "default" };
  } catch {
    return { routeKey: "default" };
  }
}
```

Then update the `main()` function to handle the classify case:

```typescript
async function main() {
  // Handle classify worker separately (different args)
  if (worker === "classify") {
    const routingJson = args.routing ?? "{}";
    const result = await classify(task, routingJson);
    console.log(JSON.stringify(result));
    process.exit(0);
  }

  const fn = WORKERS[worker];
  if (!fn) {
    // ... existing error handling
  }
  // ... rest of main()
}
```

**Step 4: Run tests**

```bash
npm test -- tests/cli.test.ts
```

Expected: all CLI tests pass including classify.

**Step 5: Commit**

```bash
git add bin/openagent-run.ts tests/cli.test.ts
git commit -m "feat: add classify worker (Haiku domain classifier) to openagent CLI"
```

---

### Task 4: Resume Worker in CLI

**Files:**
- Modify: `bin/openagent-run.ts`
- Test: `tests/cli.test.ts`

**Can run in parallel with Tasks 2, 3, 5.**

**Step 1: Write the failing test**

Add to `tests/cli.test.ts`:

```typescript
  it("resume worker requires session-id and answer", () => {
    try {
      execSync(`${CLI} --worker resume --task "ignored" --cwd /tmp`, { encoding: "utf-8" });
      assert.fail("should exit non-zero");
    } catch (err: any) {
      assert.ok(err.stderr.includes("--session-id") || err.stdout.includes("--session-id"));
    }
  });
```

**Step 2: Run test to verify it fails**

```bash
npm test -- tests/cli.test.ts --test-name-pattern="resume"
```

Expected: FAIL — resume not handled.

**Step 3: Implement the resume worker**

In `bin/openagent-run.ts`, add to the `main()` function before the `classify` check:

```typescript
  // Handle resume worker separately (different args)
  if (worker === "resume") {
    const sessionId = args["session-id"];
    const answer = args.answer ?? args.task;
    if (!sessionId) {
      console.error("resume worker requires --session-id <id> and --answer <text>");
      process.exit(1);
    }

    const { resume } = await import("../src/index.ts");
    try {
      const result = await resume(sessionId, answer);
      if (jobDir) {
        fs.mkdirSync(jobDir, { recursive: true });
        fs.writeFileSync(
          path.join(jobDir, "resume.json"),
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
      console.log(JSON.stringify(errorResult));
      process.exit(1);
    }
    process.exit(0);
  }
```

**Step 4: Run tests**

```bash
npm test -- tests/cli.test.ts
```

Expected: all CLI tests pass.

**Step 5: Commit**

```bash
git add bin/openagent-run.ts tests/cli.test.ts
git commit -m "feat: add resume worker to openagent CLI for parked session continuation"
```

---

### Task 5: Bulletin-Tools — closedNotify

**Files:**
- Modify: `~/.openclaw/extensions/bulletin-tools/lib/bulletin-db.ts`
- Modify: `~/.openclaw/extensions/bulletin-tools/index.ts`

**Can run in parallel with Tasks 2, 3, 4.**

**Step 1: Add `closed_notify` column to bulletins table**

In `bulletin-db.ts`, find the CREATE TABLE statement for bulletins (around line 96). The schema already exists — add the column with an ALTER TABLE migration at the end of the `initDb()` function:

```typescript
// After existing CREATE TABLE statements, add migration:
try {
  db.exec(`ALTER TABLE bulletins ADD COLUMN closed_notify TEXT`);
} catch {
  // Column already exists, ignore
}
```

**Step 2: Update `createBulletin()` to accept closedNotify**

In `bulletin-db.ts`, update the `createBulletin()` function signature (around line 174) to accept the new field:

Add `closedNotify?: string;` to the opts parameter.

Update the INSERT statement to include `closed_notify`:

```sql
INSERT INTO bulletins (id, topic, body, status, protocol, round, urgent, created_by, created_at, parent_id, closed_notify)
VALUES (?, ?, ?, 'open', ?, 'discussion', ?, ?, ?, ?, ?)
```

Pass `opts.closedNotify ?? null` as the last parameter.

**Step 3: Update `closeBulletin()` to fire closedNotify**

In `bulletin-db.ts`, in the `closeBulletin()` function (around line 500), after the UPDATE statement succeeds and returns the closed bulletin, add:

```typescript
// Fire closedNotify if configured
const closedNotify = db.prepare(`SELECT closed_notify FROM bulletins WHERE id = ?`).get(bulletinId) as { closed_notify: string | null } | undefined;
if (closedNotify?.closed_notify) {
  const channelId = closedNotify.closed_notify.replace("channel:", "");
  const responseCount = getResponseCount(bulletinId, "discussion");
  const critiqueCount = getResponseCount(bulletinId, "critique");
  // Post notification — use the same Discord posting pattern as index.ts
  const token = process.env.DISCORD_BOT_TOKEN ?? process.env.DISCORD_BOT_TOKEN_2;
  if (token) {
    fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `📋 Bulletin \`${bulletinId}\` closed — resolution: **${resolution}**. ${responseCount} discussion + ${critiqueCount} critique responses.`,
      }),
    }).catch(() => {});
  }
}
```

**Step 4: Export closedNotify from loadBulletin**

Make sure `loadBulletin()` includes `closed_notify` in the returned Bulletin object.

**Step 5: Commit**

```bash
cd ~/.openclaw/extensions/bulletin-tools
git add lib/bulletin-db.ts
git commit -m "feat: add closedNotify field to bulletins for callback on close"
```

---

### Task 6: Bulletin-Tools — timeoutMinutes

**Files:**
- Modify: `~/.openclaw/extensions/bulletin-tools/lib/bulletin-db.ts`
- Modify: `~/.openclaw/extensions/bulletin-tools/index.ts`

**Depends on Task 5.**

**Step 1: Add `timeout_minutes` column**

In `bulletin-db.ts`, add another ALTER TABLE migration in `initDb()`:

```typescript
try {
  db.exec(`ALTER TABLE bulletins ADD COLUMN timeout_minutes INTEGER`);
} catch {
  // Column already exists, ignore
}
```

**Step 2: Update `createBulletin()` to accept timeoutMinutes**

Add `timeoutMinutes?: number;` to the opts parameter.

Update INSERT to include `timeout_minutes`. Pass `opts.timeoutMinutes ?? null`.

**Step 3: Schedule timeout on creation**

In `index.ts`, in the plugin's `register()` function (or in the `createBulletin` call site), after a bulletin is created with `timeoutMinutes`, schedule a timeout:

```typescript
// After bulletin creation, if timeout is set:
if (opts.timeoutMinutes && opts.timeoutMinutes > 0) {
  setTimeout(async () => {
    // Check if still open
    const current = loadBulletin(bulletinId);
    if (current && current.status === "open") {
      closeBulletin(bulletinId, "stale", `Timed out after ${opts.timeoutMinutes} minutes`);
      // closedNotify fires automatically from closeBulletin (Task 5)
    }
  }, opts.timeoutMinutes * 60 * 1000);
}
```

Note: This setTimeout lives in the gateway process. If the gateway restarts, the timeout is lost. For a 3-minute timeout this is acceptable — if the gateway crashes in that window, the orchestrator can manually check and close stale bulletins.

**Step 4: Commit**

```bash
cd ~/.openclaw/extensions/bulletin-tools
git add lib/bulletin-db.ts index.ts
git commit -m "feat: add timeoutMinutes to bulletins with auto-close on expiry"
```

---

### Task 7: bulletin-post CLI — --timeout and --closed-notify Flags

**Files:**
- Modify: `~/.openclaw/bin/bulletin-post`

**Depends on Tasks 5 and 6.**

**Step 1: Add arg parsing**

In `~/.openclaw/bin/bulletin-post`, in the arg parsing section (around line 175), add:

```javascript
const timeout = getArg('timeout');            // minutes
const closedNotify = getArg('closed-notify'); // channel:<threadId>
```

**Step 2: Pass to createBulletin**

In the SQL INSERT section (around line 309), add `closed_notify` and `timeout_minutes` to the INSERT:

```sql
INSERT OR IGNORE INTO bulletins (id, topic, body, status, protocol, round, urgent, created_by, created_at, parent_id, closed_notify, timeout_minutes)
VALUES (?, ?, ?, 'open', ?, 'discussion', ?, ?, ?, ?, ?, ?)
```

Add `closedNotify ?? null` and `timeout ? parseInt(timeout, 10) : null` as parameters.

**Step 3: Schedule timeout if set**

After the bulletin is created and the Discord thread is posted, if `timeout` is set:

```javascript
if (timeout) {
  const ms = parseInt(timeout, 10) * 60 * 1000;
  setTimeout(async () => {
    const row = db.prepare(`SELECT status FROM bulletins WHERE id = ?`).get(bulletinId);
    if (row && row.status === "open") {
      db.prepare(`UPDATE bulletins SET status = 'closed', closed_at = ?, resolution = 'stale' WHERE id = ? AND status = 'open'`)
        .run(new Date().toISOString(), bulletinId);
      // Fire closedNotify
      if (closedNotify) {
        const chId = closedNotify.replace("channel:", "");
        const token = process.env.DISCORD_BOT_TOKEN ?? process.env.DISCORD_BOT_TOKEN_2;
        if (token) {
          await fetch(`https://discord.com/api/v10/channels/${chId}/messages`, {
            method: "POST",
            headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ content: `📋 Bulletin \`${bulletinId}\` timed out (${timeout}m) — closed as stale.` }),
          });
        }
      }
    }
  }, ms);
}
```

Note: `bulletin-post` runs as a one-shot CLI command, so `setTimeout` won't work here — the process exits. The timeout must be handled in the gateway process (Task 6). The CLI just passes the value to the database; the gateway-resident plugin reads it on load and schedules the timer.

**Revised approach:** The CLI writes `timeout_minutes` and `closed_notify` to the DB. The bulletin-tools plugin (running in the gateway) checks for `timeout_minutes` on any new bulletin and schedules the timer. This means Task 6's `setTimeout` logic should be triggered when a bulletin is loaded/created, not just from the TypeScript `createBulletin()` call.

Add to `index.ts` — on plugin startup or in the `before_agent_start` hook, scan for open bulletins with `timeout_minutes` that are past their deadline:

```typescript
// In register() or a startup hook:
function scheduleTimeouts() {
  const openWithTimeout = db.prepare(
    `SELECT id, created_at, timeout_minutes FROM bulletins WHERE status = 'open' AND timeout_minutes IS NOT NULL`
  ).all();

  for (const row of openWithTimeout) {
    const created = new Date(row.created_at).getTime();
    const deadline = created + (row.timeout_minutes * 60 * 1000);
    const remaining = deadline - Date.now();

    if (remaining <= 0) {
      // Already expired — close now
      closeBulletin(row.id, "stale", `Timed out after ${row.timeout_minutes} minutes`);
    } else {
      // Schedule future close
      setTimeout(() => {
        const current = loadBulletin(row.id);
        if (current && current.status === "open") {
          closeBulletin(row.id, "stale", `Timed out after ${row.timeout_minutes} minutes`);
        }
      }, remaining);
    }
  }
}

// Call on startup
scheduleTimeouts();
```

**Step 4: Commit**

```bash
cd ~/.openclaw/bin
git add bulletin-post
git commit -m "feat: add --timeout and --closed-notify flags to bulletin-post CLI"
```

---

### Task 8: Orchestrator AGENTS.md + TOOLS.md Update

**Files:**
- Modify: `~/clawd/agents/orchestrator/AGENTS.md`
- Modify: `~/clawd/agents/orchestrator/TOOLS.md`

**Depends on Tasks 3, 4, 7.**

**Step 1: Update TOOLS.md**

Add to `~/clawd/agents/orchestrator/TOOLS.md`:

```markdown
### Question Routing

Routing table: `~/.openclaw/openagent/question-routing.json`

Maps question domains to agent subscribers. `pm` is always subscribed.

| Domain | Agents |
|---|---|
| architecture | dev, soren, pm |
| database | db, dev, pm |
| api | dev, aws, pm |
| infrastructure | aws, dev, pm |
| compliance | legal, compliance, pm |
| product | product, pm |
| ux | product, pm |
| security | dev, aws, pm |
| budget | pearson, pm |
| deployment | pearson, dev, pm |
| human | pearson, pm |
| default | dev, pm |

### Bulletin CLI

```bash
# Create a bulletin with timeout and callback
~/.openclaw/bin/bulletin-post \
  --topic "openagent: <short question>" \
  --body "<structured body>" \
  --subscribers "<agent list>" \
  --protocol advisory \
  --id "blt-<jobId>-<phase>" \
  --timeout 3 \
  --closed-notify "channel:<threadId>"

# Check bulletin status
~/.openclaw/bin/bulletin-list --status open

# Read bulletin responses
~/.openclaw/bin/bulletin-list -v
```
```

**Step 2: Add question routing section to AGENTS.md**

Add after the existing "Completion" section in AGENTS.md:

```markdown
### Handling Parked Questions

When a phase returns `stopReason: "parked"` with a `parkedQuestion`:

1. Read the question text from the phase result JSON (`parkedQuestion.text`).
2. Read the routing table:
   ```bash
   exec({ command: "cat ~/.openclaw/openagent/question-routing.json" })
   ```
3. Classify the question domain:
   ```bash
   exec({ command: "node --experimental-strip-types /home/ubuntu/projects/openagent/bin/openagent-run.ts --worker classify --task \"<question text>\" --cwd \"<cwd>\" --routing '<routing table JSON>'" })
   ```
4. Parse the route key from stdout. Look up subscribers in the routing table. Add `alwaysSubscribe` agents.
5. Create the bulletin:
   ```bash
   exec({ command: "~/.openclaw/bin/bulletin-post --topic 'openagent: <short question>' --body '<structured body>' --subscribers '<comma-separated agents>' --protocol advisory --id blt-<jobId>-<phase> --timeout 3 --closed-notify channel:<threadId>" })
   ```

   Use this structured body format:
   ```
   **Question from openagent**
   **Job:** <jobId>
   **Phase:** <phase>
   **Context:** <brief task description>

   ---

   <the actual question text>

   ---

   Respond with your recommendation. Use bulletin_respond with align/partial/oppose.
   ```

6. Post to PDCA thread: "⏸️ Question parked — bulletin `blt-<jobId>-<phase>` posted to [agent list]. Timeout: 3 minutes."
7. **STOP. Wait for the bulletin close callback message in this thread.**
8. When you receive a message like "📋 Bulletin `blt-xxx` closed — resolution: ...", the bulletin is closed.
9. Read the bulletin responses:
   ```bash
   exec({ command: "~/.openclaw/bin/bulletin-list --status closed --search blt-<jobId>-<phase> -v" })
   ```
10. Synthesize responses into a direct answer. Answer in the same format as the original question. Note dissent if any agents opposed.
11. Resume the parked session:
    ```bash
    exec({ command: "node --experimental-strip-types /home/ubuntu/projects/openagent/bin/openagent-run.ts --worker resume --session-id <parkedQuestion.id> --answer \"<synthesized answer>\" --cwd \"<cwd>\" --job-dir ~/.openclaw/openagent/jobs/<jobId>" })
    ```
12. Continue the phase with the resumed result.

### Timeout fallback

- If the bulletin closed as `stale` with 0 responses: post to thread "No agents responded — need your input, Pearson." Include the original question. **STOP.**
- If stale with partial responses: synthesize from what exists, note which agents didn't respond, resume.
```

**Step 3: Commit**

```bash
cd ~/clawd/agents/orchestrator
git add AGENTS.md TOOLS.md
git commit -m "feat: add question routing via bulletin board to orchestrator"
```

---

### Task 9: End-to-End Smoke Test

**Files:** None — this is a live test.

**Depends on all previous tasks.**

**Step 1: Restart gateway**

```bash
openclaw gateway restart
```

The gateway must reload to pick up bulletin-tools changes (closedNotify, timeoutMinutes).

**Step 2: Trigger a PDCA cycle that will produce a question**

Send a task to the orchestrator that's ambiguous enough to trigger a question. Via Atlas or directly in `#🔧-orchestrator`:

```
Build a REST API endpoint for user profile updates in /home/ubuntu/projects/openagent. The endpoint should validate input and store data — but don't specify which database or validation library.
```

The plan worker should ask "Which database?" or similar.

**Step 3: Verify the bulletin flow**

Expected sequence:
1. Orchestrator runs plan phase
2. Plan worker parks with a question
3. Orchestrator catches `stopReason: "parked"`
4. Orchestrator classifies the question (Haiku call)
5. Orchestrator creates a bulletin with the right subscribers
6. Bulletin appears in the bulletin board Discord channel
7. Agents respond (or timeout fires at 3 minutes)
8. `closedNotify` posts callback to the PDCA thread
9. Orchestrator synthesizes and resumes
10. Plan phase continues with the answer

**Step 4: Verify timeout fallback**

If no agents respond within 3 minutes, verify:
- Bulletin closes as `stale`
- Orchestrator posts "No agents responded — need your input" (if 0 responses)
- Or synthesizes from partial responses

**Step 5: Check audit trail**

```bash
cat ~/.openclaw/mailroom/bulletins/bulletins.log | grep blt-
ls ~/.openclaw/openagent/jobs/*/
```

Verify bulletin lifecycle is logged and phase results are persisted.

---

## Summary

| Task | What | Files | Parallel group |
|------|------|-------|----------------|
| 1 | Pre-req: verify resume | tests/resume.test.ts | — (first) |
| 2 | Routing table config | ~/.openclaw/openagent/question-routing.json | A |
| 3 | Classify worker (Haiku) | bin/openagent-run.ts, tests/cli.test.ts | A |
| 4 | Resume worker in CLI | bin/openagent-run.ts, tests/cli.test.ts | A |
| 5 | closedNotify in bulletin-tools | bulletin-db.ts, index.ts | B |
| 6 | timeoutMinutes in bulletin-tools | bulletin-db.ts, index.ts | B (after 5) |
| 7 | --timeout --closed-notify CLI flags | bulletin-post | B (after 6) |
| 8 | Orchestrator AGENTS.md + TOOLS.md | ~/clawd/agents/orchestrator/ | C (after A+B) |
| 9 | E2E smoke test | manual | C (after 8) |

**Parallel execution:** After Task 1, dispatch Tasks 2+3+4 as one parallel group and Tasks 5→6→7 as a sequential chain. Both groups are independent. After both complete, Task 8 then Task 9.
