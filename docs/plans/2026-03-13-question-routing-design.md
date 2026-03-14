# Question Routing via Bulletin Board — Design

**Goal:** When an openagent SDK session surfaces a question (ParkSession), route it through the existing bulletin board system for multi-agent coordination, then resume the session with a synthesized answer.

**Architecture:** The orchestrator catches parked questions, classifies the domain via a cheap Haiku call, creates an advisory bulletin with the right agents subscribed (pm always included), and pauses the PDCA phase. The bulletin runs discussion + critique rounds. On close (or 3-minute timeout), the bulletin-tools plugin posts a callback to the orchestrator's thread. The orchestrator synthesizes responses into a direct answer and resumes the parked SDK session.

## Flow

```
SDK session hits uncertainty → throws ParkSession(question)
    ↓
Orchestrator catches parkedQuestion in phase result
    ↓
Orchestrator calls classify (Haiku) → route key (e.g., "database")
    ↓
Orchestrator looks up route key → subscriber list from question-routing.json
    ↓
Orchestrator creates bulletin (advisory, 3-min timeout, closedNotify → PDCA thread)
    ↓
Phase PAUSES — thread shows "⏸️ Question parked — bulletin blt-xxx"
Orchestrator session stops. No polling.
    ↓
Agents wake, respond (align/partial/oppose) → critique round
    ↓
Bulletin closes (all responded, or 3-min timeout → stale)
    ↓
bulletin-tools posts callback to orchestrator thread (closedNotify)
    ↓
Orchestrator session resumes from callback message
    ↓
Orchestrator reads bulletin responses, synthesizes direct answer
    ↓
Orchestrator calls resume(sessionId, answer) → SDK session continues
```

## Routing Table

Shared config at `~/.openclaw/openagent/question-routing.json`:

```json
{
  "routes": {
    "architecture":   ["dev", "soren"],
    "database":       ["db", "dev"],
    "api":            ["dev", "aws"],
    "infrastructure": ["aws", "dev"],
    "compliance":     ["legal", "compliance"],
    "product":        ["product"],
    "ux":             ["product"],
    "security":       ["dev", "aws"],
    "budget":         ["pearson"],
    "deployment":     ["pearson", "dev"],
    "human":          ["pearson"],
    "default":        ["dev"]
  },
  "alwaysSubscribe": ["pm"]
}
```

`pm` is always subscribed for visibility. `human`/`budget`/`deployment` routes to Pearson directly for questions no agent can answer.

## Haiku Classifier

A cheap claude-haiku-4-5 call that takes:
- The question text
- The list of valid route keys

Returns: a single route key. Deterministic, costs fractions of a cent, avoids the orchestrator guessing wrong.

Implemented as `--worker classify` in `bin/openagent-run.ts`. Uses createSession() with haiku model, minimal prompt, maxTurns: 1.

## Bulletin Format

Minimal, enveloped, structured:

```markdown
**Question from openagent**
**Job:** 2026-03-13-add-pagination
**Phase:** plan
**Context:** Building cursor-based pagination for /api/projects

---

Which database adapter should we use for cursor-based pagination — Prisma, Drizzle, or raw pg? The table has ~50k rows with a composite index on (created_at, id).

---

Respond with your recommendation. Use `bulletin_respond` with align/partial/oppose.
```

## Bulletin Creation Parameters

```bash
bulletin-post \
  --topic "openagent: <short question>" \
  --body "<structured body above>" \
  --subscribers "<classified agents + pm>" \
  --protocol advisory \
  --id "blt-<jobId>-<phase>" \
  --timeout 3 \
  --closed-notify "channel:<orchestrator-thread-id>"
```

## Bulletin-Tools Plugin Changes

Two additions to the existing plugin:

### 1. `closedNotify` field

On `createBulletin()`, accept an optional `closedNotify: string` (a channel/thread ID). When `closeBulletin()` fires (any resolution), post a message to that channel:

```
Bulletin `blt-xxx` closed — resolution: <resolution>. <responseCount> responses received.
```

The orchestrator's PDCA thread receives this as a normal inbound message, waking the session.

### 2. `timeoutMinutes` field

On `createBulletin()`, accept an optional `timeoutMinutes: number`. The plugin sets a timeout (setTimeout or sweeper). When the timer fires:
- If bulletin is still open, close it with resolution `stale`
- Fire `closedNotify` as normal
- Orchestrator synthesizes from whatever responses exist (may be partial or zero)

## Orchestrator Behavior (AGENTS.md addition)

When a phase returns `stopReason: "parked"` with `parkedQuestion`:

1. Read question text from `parkedQuestion.text`
2. Classify domain:
   ```bash
   exec({ command: "node --experimental-strip-types /home/ubuntu/projects/openagent/bin/openagent-run.ts --worker classify --task '<question text>' --cwd <cwd> --job-dir <jobDir>" })
   ```
3. Read route key from stdout, look up subscribers in `~/.openclaw/openagent/question-routing.json`
4. Add `alwaysSubscribe` agents (pm)
5. Create bulletin:
   ```bash
   exec({ command: "~/.openclaw/bin/bulletin-post --topic 'openagent: <short question>' --body '<structured body>' --subscribers '<agent list>' --protocol advisory --id blt-<jobId>-<phase> --timeout 3 --closed-notify channel:<threadId>" })
   ```
6. Post to PDCA thread: "⏸️ Question parked — bulletin `blt-<jobId>-<phase>` posted to [agent list]. Timeout: 3 minutes."
7. **STOP. Wait for bulletin close callback message in thread.**
8. On callback: read bulletin responses via `bulletin-list --agent <id> -v`
9. Synthesize responses into a direct answer — same format as the original question
10. Resume the parked session:
    ```bash
    exec({ command: "node --experimental-strip-types /home/ubuntu/projects/openagent/bin/openagent-run.ts --worker resume --session-id <id> --answer '<synthesized answer>' --job-dir <jobDir>" })
    ```
11. Continue the phase with the resumed result

### Timeout fallback behavior

- If 0 responses when timeout fires: post to thread "No agents responded — need your input, Pearson." and STOP.
- If partial responses: synthesize from what exists, note which agents didn't respond, resume.

## What Changes

| Component | Change |
|---|---|
| `~/.openclaw/openagent/question-routing.json` | New — routing table |
| `bin/openagent-run.ts` | Add `--worker classify` (Haiku) and `--worker resume` |
| `~/.openclaw/extensions/bulletin-tools/lib/bulletin-db.ts` | Add `closedNotify` and `timeoutMinutes` to createBulletin/closeBulletin |
| `~/.openclaw/extensions/bulletin-tools/index.ts` | Wire closedNotify posting and timeout scheduling |
| `~/.openclaw/bin/bulletin-post` | Add `--timeout` and `--closed-notify` flags |
| `~/clawd/agents/orchestrator/TOOLS.md` | Add routing table reference |
| `~/clawd/agents/orchestrator/AGENTS.md` | Add parked question → classify → bulletin → callback → resume flow |
| `~/clawd/agents/orchestrator/SOUL.md` | Mention bulletin-based question routing |

## What Doesn't Change

- Bulletin board core (discussion/critique rounds, align/partial/oppose)
- ParkSession / resume() in openagent library
- Agent wake mechanism (bulletin-tools handles it)
- openagent-dispatch hook

## Pre-requisite

Verify ParkSession/resume works end-to-end before building the bulletin integration. Write a test that parks and resumes a real SDK session.
