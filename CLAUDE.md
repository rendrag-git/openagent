# Claude Code Instructions — openagent

## Stack
- TypeScript (strict mode), ESM (`"type": "module"`)
- Node >= 22 (uses `--experimental-strip-types` — no build step)
- Runtime dependency: `@anthropic-ai/claude-agent-sdk`
- No bundler, no linter, no formatter — just `tsc --noEmit` for type checking

## Setup / Test / Lint
```bash
./scripts/bootstrap   # npm install + typecheck
./scripts/test        # node --test --experimental-strip-types tests/**/*.test.ts
./scripts/lint        # tsc --noEmit (no ESLint/Prettier configured)
```

## What This Project Does
openagent wraps the Claude Agent SDK to run Claude Code sessions as specialized PDCA workers:

- **plan** — explores a codebase and produces an implementation plan (read-only, runs in a git worktree)
- **execute** — implements a plan (can write files, runs `acceptEdits` mode)
- **check** — reviews work against a plan (read-only, Write/Edit denied, runs in a worktree snapshot)
- **act** — applies surgical fixes for specific issues (can write files)

Each worker has a profile in `src/profiles.ts` that controls allowed tools, permission mode, max turns, and system prompt.

Workers are orchestrated externally. When a worker needs clarification, it throws `ParkSession` to pause the SDK session, and the orchestrator routes the question.

## Architecture

### Core flow
1. Caller invokes a worker function (e.g., `plan({ task, cwd })`)
2. Worker selects its profile from `src/profiles.ts`
3. `src/run-session.ts` calls `@anthropic-ai/claude-agent-sdk.query()` with profile options
4. If the SDK's `canUseTool` callback intercepts `AskUserQuestion`, it either returns answers inline or throws `ParkSession`
5. Result is returned as a `TaskResult` (defined in `src/types.ts`)

### Key modules
| File | Purpose |
|------|---------|
| `src/types.ts` | All shared interfaces (TaskResult, TaskContext, WorkerProfile, etc.) |
| `src/profiles.ts` | Worker profiles — tools, permissions, system prompts |
| `src/session.ts` | `buildSessionOptions`, `extractResult`, `computeCost`, `ParkSession` class |
| `src/run-session.ts` | `runSession` — the actual SDK call, message iteration, canUseTool wiring |
| `src/workers/*.ts` | Thin wrappers: `plan`, `execute`, `check`, `act` |
| `src/can-use-tool.ts` | `createCanUseTool` factory — intercepts AskUserQuestion, enforces deny lists |
| `src/feedback.ts` | Persist/load/remove parked sessions to `~/.openclaw/openagent/parked/` |
| `src/worktree.ts` | Create/cleanup git worktrees for plan and check isolation |
| `src/context-chain.ts` | Chain phase outputs (plan -> execute -> check -> act) via job dir JSON files |
| `src/plan-feedback.ts` | Plan feedback control plane — state machine, interactions, events, dispatch artifacts |
| `src/plan-feedback-*.ts` | Interactions, routing, dispatch, resume, guards for the plan feedback system |
| `src/acp-runtime.ts` | ACP-facing adapter — wraps workers into a `runTurn`/`resumeTurn` interface |
| `src/orchestrator-questions.ts` | Question handler that parks sessions when workers ask questions |
| `bin/openagent-run.ts` | CLI entry point — parses `--worker --task --cwd` args, runs workers |

### Data paths
- Parked sessions: `~/.openclaw/openagent/parked/<sessionId>.json`
- Question routing config: `~/.openclaw/openagent/question-routing.json`
- Bulletin system: `~/.openclaw/mailroom/bulletins/bulletins.db`
- Job artifacts: `<jobDir>/plan.json`, `execute.json`, `check.json`, etc.
- Worktrees: `/tmp/openagent-<worker>-<jobId>`

## How To: Common Tasks

### Add a new worker
1. Define its profile in `src/profiles.ts` (tools, permissions, maxTurns, systemPromptAppend)
2. Create `src/workers/<name>.ts` following the pattern in existing workers (thin wrapper calling `runSession`)
3. Add its request type to `src/types.ts`
4. Export from `src/index.ts`
5. Add to `WORKERS` map in `bin/openagent-run.ts` and `DEFAULT_WORKERS` in `src/acp-runtime.ts`
6. Add tests in `tests/<name>.test.ts`

### Modify worker permissions
Edit the profile in `src/profiles.ts`. The `denyTools` array is enforced by `createCanUseTool` at runtime (not just advisory). The `allowedTools` list controls what the SDK offers to Claude.

### Change how questions are routed
The plan worker uses a structured interaction system (`src/plan-feedback-interactions.ts`). Other workers use `createOrchestratorQuestionHandler` which simply throws `ParkSession`. The CLI (`bin/openagent-run.ts`) adds bulletin-board integration on top.

### Write a test
Use `node:test` and `node:assert/strict`. No mocking framework — tests construct inputs and call exported functions directly. SDK calls are injected via `deps` parameters (e.g., `runSession` accepts a `queryFactory` dep).

## Gotchas

- **All imports use `.ts` extensions** — `import { foo } from "./bar.ts"`, not `./bar` or `./bar.js`. Node's strip-types requires this.
- **No build step** — `tsconfig.json` has `noEmit: true`. Code runs directly via `--experimental-strip-types`.
- **ParkSession is control flow** — it's an Error subclass thrown to interrupt a session. Don't catch it unless you're building orchestration logic.
- **check worker denies Write/Edit** — both in `allowedTools` (SDK level) and `denyTools`/`createCanUseTool` (runtime callback). If you add a new tool, check both paths.
- **Worktrees are created under /tmp** — plan and check run in isolated git worktrees. Plan worker copies `docs/plans/*.md` back on cleanup. Don't assume worker cwd is the real repo.
- **Session cost tracking is stubbed** — `costUsd`, `inputTokens`, `outputTokens` are zeroed in `extractResult`. The `computeCost` function exists but isn't wired in.
- **The CLI (`bin/openagent-run.ts`) is large** — it duplicates some patterns from `src/acp-runtime.ts`. These are two parallel integration paths (CLI vs ACP adapter).

## Plan Feedback System
The plan feedback subsystem (`src/plan-feedback*.ts`) is the most complex part of the codebase:

- **PlanState** tracks a workflow status machine with ~15 states (see `PlanWorkflowStatus` type)
- **PlanInteraction** represents a question the planner needs answered, with kind (clarify_product, approach_decision, design_section_review, etc.), owner, routing, and resume config
- **Events** are appended to a log (`events.jsonl` in the job dir) for auditability
- **Dispatch** routes interactions to external systems (bulletin board, etc.)
- **Resume** records answers and completes interaction resolution before re-entering the SDK session

Invariants to maintain when modifying plan feedback:
- `PlanState.activeInteractionId` must match the currently open interaction (or null)
- `PlanState.status` must be consistent with the interaction's state
- Every state change should produce an event via `appendPlanEvent`

## Environment Variables
The codebase uses very few env vars. `HOME` locates `~/.openclaw/`. Git identity vars (`GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`) are used in worktree snapshot commits. There is no `.env` loading — env vars come from the shell.

## Testing Patterns
- Tests are pure unit tests — they import functions and pass constructed inputs
- SDK dependency is injectable: `runSession` accepts a `deps.queryFactory` parameter
- Plan feedback tests create temp directories, write JSON state files, and verify transitions
- No mocking library — tests use plain objects and dependency injection
- Test file naming: `tests/<module>.test.ts` mirrors `src/<module>.ts`

## Style Conventions
- No default exports — everything is named exports
- Interfaces over type aliases for object shapes
- Functions are standalone, not class methods (except `ParkSession` which extends `Error`)
- Async functions return `Promise` explicitly in type signatures
- Error handling: try/catch with empty catch blocks for "best effort" operations (e.g., git cleanup)

## Files To Be Careful With
- `src/types.ts` — changing interfaces here ripples across the entire codebase
- `src/profiles.ts` — worker permissions; mistakes here change what Claude can do
- `src/run-session.ts` — the core SDK integration; ParkSession/canUseTool wiring is subtle
- `src/plan-feedback.ts` — large state machine with many exported types; easy to break invariants
- `bin/openagent-run.ts` — 770-line CLI with complex orchestration logic; has its own canUseTool wiring that parallels `src/acp-runtime.ts`
