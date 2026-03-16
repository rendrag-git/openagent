# Orchestra Phase Ownership Map

Date: 2026-03-16
Related docs:
- `~/clawd/orchestra/delegated-questing-thompson.md`
- `~/clawd/orchestra/2026-02-26-session-summary.md`
- `~/clawd/orchestra/2026-03-16-phase-6-templates-temporal-patterns-design.md`
- `~/clawd/orchestra/2026-03-16-phase-6-templates-temporal-patterns-plan.md`
- `docs/plans/2026-03-13-orchestrator-rewrite.md`
- `docs/plans/2026-03-16-plan-feedback-transport-matrix.md`
- `docs/plans/2026-03-16-plan-feedback-event-schema.md`
- `docs/plans/2026-03-16-plan-feedback-state-machine.md`

## Purpose

Map the full Orchestra plan to concrete code and runtime ownership.

This document answers:

- which artifact is the canonical Orchestra plan
- which repo or runtime owns each phase
- where `openagent` fits
- which later design revisions changed original phase ownership
- what is still missing at the integration boundaries

## Canonical Source

The canonical Orchestra master plan is:

- `~/clawd/orchestra/delegated-questing-thompson.md`

This was explicitly called out in:

- `~/clawd/orchestra/2026-02-26-session-summary.md`

That summary also says the Thompson copy is canonical and the original copy should be archived.

## System Layers

The Orchestra is not a single repo. It spans several layers.

| Layer | Owns | Main location |
|---|---|---|
| Orchestra strategy/docs | phase plans, sequencing, operating model | `~/clawd/orchestra/` |
| OpenClaw runtime | gateway, hooks, plugins, cron, session plumbing | `~/.openclaw/`, `~/.openclaw-rescue/`, OpenClaw source |
| Coordinator / orchestrator | thread workflow, approvals, routing, authority enforcement | `~/clawd/agents/orchestrator/` and surrounding runtime |
| Bulletin discussion system | multi-agent asynchronous discussion and resolution | `~/projects/bulletin-tools` plus `~/.openclaw/mailroom/` |
| Lobster workflow engine | temporal workflows, approval gates, resume semantics, workflow state | `~/projects/lobster` |
| Worker runtime | PDCA work sessions, parked SDK sessions, plan-feedback state | this repo: `openagent` |
| Agent definitions | PM/dev/legal/security/etc. identity, skills, scope, authority text | `~/clawd/agents/*` |

## Where Openagent Fits

`openagent` is not the Orchestra.

`openagent` owns:

- PDCA worker execution (`plan`, `execute`, `check`, `act`)
- Claude Agent SDK session lifecycle
- parked session / resume mechanics
- plan-feedback state and event artifacts
- structured plan interaction contracts

`openagent` does not own:

- multi-agent bulletin discussion
- cron or temporal orchestration
- company-wide score compilation
- authority policy enforcement
- Lobster approval workflows
- Discord thread governance

The correct mental model is:

- Orchestra is the company-operating system
- the orchestrator is the conductor for a thread or job
- `openagent` is one worker runtime the orchestrator can call

## Phase Ownership

### Phase 1: Prompt Caching

Goal:
- reduce cost and latency for agent invocations

Primary owner:
- OpenClaw runtime / auth config / request builder

Likely locations:
- `~/.openclaw/openclaw.json`
- OpenClaw source or extension layer

Openagent role:
- none directly

Status notes:
- operational/runtime concern, not an `openagent` concern

### Phase 2: Bulletin Board Foundation

Goal:
- async group discussion piggybacked onto existing sessions

Primary owner:
- OpenClaw coordinator hook + bulletin-tools plugin

Likely locations:
- `~/.openclaw/hooks/agent-coordinator/`
- `~/.openclaw/extensions/bulletin-tools/`
- `~/.openclaw/mailroom/`
- later externalized into `~/projects/bulletin-tools`

Openagent role:
- none initially

Status notes:
- this phase predates the `openagent` plan-feedback work
- the original architecture was discussion-centric, not PDCA-centric

### Phase 3: Counterpoint + Dissent

Goal:
- richer bulletin discussions with dissent surfaced and follow-on discussion possible

Primary owner:
- bulletin injection/capture flow
- bulletin-tools plugin

Likely locations:
- `agent-coordinator` hook
- `bulletin-tools`

Openagent role:
- none directly

Status notes:
- later revised by Phase 4 docs to move from binary `dissent` to ternary positions

### Phase 4: Decision Protocols / Critique / Auto-Close

Goal:
- make bulletin discussions resolve themselves when appropriate

Primary owner:
- bulletin state model and closure logic

Likely locations:
- `bulletin-tools`
- mailroom bulletin store
- Discord notification helpers

Openagent role:
- none directly

Status notes:
- this is where bulletin protocols become more than a mailbox
- still not a PDCA planner feedback system

### Phase 5: Score Compiler

Goal:
- synthesize bulletin activity into one readable digest

Primary owner:
- scripts / cron / score compiler output

Likely locations:
- OpenClaw runtime scripts
- `~/clawd/orchestra/`
- `~/.openclaw/cron/`

Openagent role:
- none directly

### Phase 6: Templates + Temporal Patterns

Original owner in Thompson plan:
- OpenClaw cron + bulletin creation scripts

Revised owner in March 16 docs:
- Lobster owns orchestration
- bulletin-tools owns JSON-speaking discussion steps
- cron triggers Lobster

Primary owner after revision:
- `~/projects/lobster`
- `~/projects/bulletin-tools`
- `~/.openclaw/cron/`
- `~/.openclaw-rescue/cron/`

Likely files:
- `~/clawd/orchestra/2026-03-16-phase-6-templates-temporal-patterns-design.md`
- `~/clawd/orchestra/2026-03-16-phase-6-templates-temporal-patterns-plan.md`
- `~/clawd/workflows/*.lobster`
- `~/.openclaw/mailroom/templates.json`

Openagent role:
- downstream execution target only
- Lobster workflows may invoke `openagent` or `openclaw agent invoke`, but `openagent` does not own Phase 6 orchestration

Important revision:
- this is the clearest point where later docs changed ownership
- the original orchestra plan assumed more orchestration would live near bulletins and cron
- the revised plan assigns orchestration to Lobster explicitly

### Phase 7: Tiered Authority

Goal:
- policy-based autonomy: green/yellow/red/black execution tiers

Primary owner:
- coordinator / orchestrator / policy enforcement layer

Likely locations:
- `~/.openclaw/hooks/agent-coordinator/handler.ts`
- `~/.openclaw/policies.json`
- `~/clawd/agents/*/SOUL.md`
- orchestrator Discord approval flow

Openagent role:
- can execute work once policy allows it
- does not decide whether policy allows it

Status notes:
- this is the real autonomy unlock in the master plan
- it belongs above worker runtimes, not inside them

### Phase 8: Revenue Agents

Goal:
- sales/growth/retention operations

Primary owner:
- agent definitions
- new tools and integrations
- policy layer
- bulletin patterns

Likely locations:
- `~/clawd/agents/`
- OpenClaw integrations
- possibly Lobster workflows for repeatable operational loops

Openagent role:
- optional execution engine for scoped work tasks

### Phase 9: Strategic Intelligence

Goal:
- strategy sensing, scenario modeling, portfolio-level synthesis

Primary owner:
- score compiler evolution
- agent memory and search
- rehearsal workflows
- strategy agents/tasks

Likely locations:
- `~/clawd/orchestra/`
- score compiler scripts
- memory index tooling
- Lobster or orchestrator workflows

Openagent role:
- optional execution runtime for individual planning tasks

### Phase 10: Multi-Company

Goal:
- isolated company operations with shared portfolio view

Primary owner:
- memory namespacing
- bulletin namespacing
- policy namespacing
- contamination audits
- multi-conductor topology

Likely locations:
- OpenClaw runtime config and storage
- policy config
- memory store design
- orchestrator topology

Openagent role:
- should remain company-agnostic and be invoked with the correct workspace/context

## Ownership By Repo / Runtime

### This repo: `openagent`

Owns:

- PDCA worker profiles
- `openagent-run`
- Agent SDK session lifecycle
- parked session artifacts
- plan-feedback artifacts
- structured planner interaction parsing/routing contracts

Relevant files:

- `bin/openagent-run.ts`
- `src/plan-feedback.ts`
- `src/plan-feedback-routing.ts`
- `src/plan-feedback-dispatch.ts`
- `src/plan-feedback-resume.ts`
- `src/context-chain.ts`

### Remote repo/runtime: `clawd`

Owns:

- Orchestra docs
- orchestrator agent identity/prompting
- workflow intent and authority model
- higher-level agent topology

Relevant locations:

- `~/clawd/orchestra/`
- `~/clawd/agents/orchestrator/`
- `~/clawd/agents/pm/`
- `~/clawd/agents/soren/skills/`

### Remote repo: `bulletin-tools`

Owns:

- bulletin posting, listing, closing, polling
- bulletin state and resolution protocols
- JSON-mode CLI surface for Lobster integration

Relevant locations:

- `~/projects/bulletin-tools/bin/`
- `~/projects/bulletin-tools/lib/`

### Remote repo: `lobster`

Owns:

- workflow files and workflow runtime
- approval halts
- resume tokens
- workflow state under `~/.lobster/state`
- typed pipeline semantics

Relevant locations:

- `~/projects/lobster/src/cli.ts`
- `~/projects/lobster/src/resume.ts`
- `~/projects/lobster/src/workflows/file.ts`
- `~/projects/lobster/src/sdk/`

### OpenClaw runtime state

Owns:

- gateway/plugin loading
- cron configuration
- mailroom state
- live plugin config and extensions

Relevant locations:

- `~/.openclaw/`
- `~/.openclaw-rescue/`

## Later Revisions That Matter

### Revision 1: Thompson plan became canonical

Source:
- `2026-02-26-session-summary.md`

Impact:
- establishes the canonical phase ordering and strategic direction

### Revision 2: Bulletin MVP became an actual implementation stream

Source:
- `2026-02-26-bulletin-board-design.md`
- `2026-02-26-bulletin-board-plan.md`
- `2026-02-26-session-summary.md`

Impact:
- turned the Orchestra bulletin concept into concrete hook/plugin code

### Revision 3: Phase 4 replaced binary dissent with ternary positions

Source:
- `orchestra-phase-4-critique-decision-protocols.md`

Impact:
- changed bulletin semantics from `dissent: true|false` to:
  - `align`
  - `partial`
  - `oppose`

### Revision 4: Phase 6 moved orchestration into Lobster

Source:
- `2026-03-16-phase-6-templates-temporal-patterns-design.md`
- `2026-03-16-phase-6-templates-temporal-patterns-plan.md`

Impact:
- biggest ownership shift in the whole plan
- bulletin-tools stops being an orchestration engine
- Lobster becomes the approved home for:
  - temporal patterns
  - approval gates
  - resume semantics
  - multi-step workflows

### Revision 5: Openagent added a separate plan-feedback control plane

Source:
- `docs/plans/2026-03-16-plan-feedback-*.md`

Impact:
- introduces a second async feedback/resume mechanism, but for planner sessions
- this is complementary to Lobster, not a replacement for it

## Current Boundary Assessment

The current architecture should be read like this:

- `bulletin-tools` handles discussion
- Lobster handles workflow
- orchestrator handles policy, routing, and thread ownership
- `openagent` handles worker execution and planner-session feedback state

That means `openagent` should not absorb:

- bulletin resolution protocols
- cron/temporal workflows
- generalized approval workflow state
- company-level authority decisions

And it does mean `openagent` should expose enough state for the orchestrator or Lobster to drive it safely:

- durable interaction artifacts
- durable planner session ids
- resumable planner sessions
- machine-readable pending gates

## Integration Gaps

### Gap 1: Transport execution is still above `openagent`

Current state:
- `openagent` now persists structured plan interactions and transport routing intent

Missing:
- actual PM/specialist session execution in the orchestrator runtime
- actual human gate handling bound to the planner interactions

Owner:
- orchestrator runtime, not `openagent`

### Gap 2: No formal Lobster <-> openagent adapter

Current state:
- Lobster has approval halts and resume tokens
- `openagent` has parked planner sessions and `sdkSessionId`

Missing:
- a defined adapter for:
  - Lobster workflow step emits/observes an `openagent` pending interaction
  - Lobster approval outcome resumes the parked planner session

Owner:
- orchestrator / integration layer

### Gap 3: Bulletin workflow and planner feedback are still separate systems

Current state:
- bulletin system supports advisory discussion
- `openagent` planner feedback supports structured async gates

Missing:
- one clear policy for when a planner interaction becomes:
  - direct PM session
  - bulletin advisory request
  - Lobster approval gate
  - Discord human gate

Owner:
- orchestrator policy layer

### Gap 4: Tiered authority is still outside the current `openagent` design

Current state:
- `openagent` can model planner gates

Missing:
- policy-tier enforcement for actual execution authority

Owner:
- coordinator / orchestrator / policies

## Recommended Working Model

For current implementation work, treat the stack this way:

1. `openagent`
- build worker correctness
- build planner interaction durability
- build Anthropic session park/resume correctly

2. `bulletin-tools`
- keep it discussion-first
- make it scriptable and JSON-friendly

3. Lobster
- use it for temporal and approval workflows
- especially where multi-step orchestration matters more than worker internals

4. orchestrator
- make it the policy and routing brain
- it decides which engine to call next

## Immediate Next Steps

If continuing this architecture intentionally, the next documents or implementation slices should be:

1. A Lobster-to-openagent adapter design
- define how a Lobster workflow step starts, parks, observes, and resumes a planner session

2. An orchestrator routing policy doc
- decide exactly when planner interactions go to:
  - PM direct session
  - specialist direct session
  - bulletin
  - Lobster approval
  - Discord human gate

3. A tiered-authority mapping for PDCA execution
- define which `execute` or `act` outcomes are green/yellow/red/black

4. A thread-visibility policy
- decide which agent-to-agent interactions must be surfaced into Discord threads

## Bottom Line

The Orchestra plan is broader than any one repo.

The canonical master plan lives under `~/clawd/orchestra/`.
`openagent` is one execution/runtime component inside it.
The most important ownership change since the original plan is that Lobster now owns temporal workflows and approval orchestration, while `openagent` owns PDCA worker execution and planner-session feedback state.
