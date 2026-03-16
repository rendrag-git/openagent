# Plan Feedback Implementation Plan

Date: 2026-03-16
Branch: `codex/plan-feedback-design`
Related docs:
- `docs/plans/2026-03-16-plan-feedback-transport-matrix.md`
- `docs/plans/2026-03-16-plan-feedback-event-schema.md`
- `docs/plans/2026-03-16-plan-feedback-state-machine.md`

## Goal

Replace the current plan-phase `AskUserQuestion -> bulletin -> poll -> synthesize` loop with an orchestrator-owned feedback system that:

- treats clarification, approval, review, and human gates as distinct interaction types
- uses the correct transport for each interaction type
- persists durable state for restart and recovery
- prefers native Anthropic Agent SDK session resume for async planner gates
- preserves thread visibility and auditability for human-facing workflow steps

## Non-Goals

- redesigning execute/check/act behavior
- changing the actual `superpowers` skill content
- building a generic orchestration platform for every future workflow
- replacing bulletin or Discord; both remain part of the transport mix

## Current Baseline

Today the openagent planner effectively has one external feedback primitive:

- the worker emits `AskUserQuestion`
- openagent routes it to bulletin
- openagent polls for responses
- openagent synthesizes responses back into the same run

That model is mismatched to the `brainstorming` and `writing-plans` skill flow because:

- clarifying questions are not always advisory
- approach selection is a directed PM approval, not a vote
- design-section review is a gated PM conversation with possible human escalation
- spec review is delegated work, not audience polling
- human review belongs in Discord, not bulletin

## Implementation Principles

1. The event schema is the contract.
2. The orchestrator owns workflow state and transport routing.
3. Openagent emits structured interaction requests and consumes structured resolutions.
4. Every external interaction gets a durable handle.
5. Async waits prefer `sdk_resume`; rerun-with-feedback is fallback only.
6. Bulletins stay advisory-only.
7. PM and specialist interactions use directed session primitives, not multicast.

## Deliverables

Implementation is complete when all of the following exist:

- openagent can emit structured plan interaction requests
- orchestrator can persist and route all supported interaction kinds
- planner sessions can be parked and resumed by SDK session id
- PM-directed approval loops work without bulletin
- design-section escalation to human works through the PDCA Discord thread
- spec review runs as delegated child work
- final user spec review occurs before `writing-plans`
- tests cover state transitions, routing, resume, and failure recovery

## Work Breakdown

### Phase 1: Persisted Control Plane

Objective:
- establish durable job state and event logging before changing routing behavior

Changes:
- add job-dir writers/readers for:
  - `plan-state.json`
  - `sessions.json`
  - `interactions/<id>.json`
  - `events/<timestamp>-<eventId>.json`
  - `spec-review/<round>.json`
- add a shared event writer that emits the canonical envelope from the schema doc
- add state helpers for:
  - active interaction lookup
  - planner session binding
  - interaction resolution
  - restart recovery

Likely files in `openagent`:
- `bin/openagent-run.ts`
- `src/session.ts`
- new `src/plan-feedback/state.ts`
- new `src/plan-feedback/events.ts`
- new `src/plan-feedback/types.ts`

Likely files in orchestrator:
- the worker launcher that invokes `openagent-run`
- job persistence utilities

Exit criteria:
- plan jobs write schema-conformant state and event artifacts even if they still use current bulletin behavior

### Phase 2: Planner Interaction Contract

Objective:
- make the planner emit typed interactions instead of free-form "user questions"

Changes:
- define a planner-side interaction API
- normalize planner output into these interaction kinds:
  - `clarify`
  - `approach_decision`
  - `design_section_review`
  - `spec_user_review`
- add planner-side validation:
  - one active interaction at a time
  - required fields per interaction kind
  - explicit owner and transport intent
- encode `resume` blocks with:
  - `sdk_resume`
  - `sdkSessionId`
  - optional rerun fallback

Implementation note:
- if the Anthropic SDK integration only exposes `AskUserQuestion`, wrap it with a JSON envelope contract rather than inventing a second ad hoc side channel
- if a richer tool hook is available, use that instead

Likely files in `openagent`:
- `bin/openagent-run.ts`
- `src/can-use-tool.ts`
- new `src/plan-feedback/interaction-parser.ts`
- new `src/plan-feedback/interaction-contract.ts`

Exit criteria:
- planner emits structured interaction requests into persisted state and event logs

### Phase 3: Orchestrator Router

Objective:
- move interaction routing out of the planner runtime and into the orchestrator

Changes:
- implement a transport router keyed by:
  - `interactionKind`
  - `decisionOwner`
  - `transport`
  - escalation policy
- add route handlers for:
  - PM directed session
  - specialist directed session
  - bulletin advisory request
  - human Discord gate
  - delegated spec review
- add route policy config replacing question-category-as-routing:
  - `clarify.product -> pm`
  - `clarify.specialist -> specialist`
  - `clarify.advisory -> bulletin`
  - `approach_decision -> pm`
  - `design_section_review -> pm`
  - `design_section_review.escalated -> human`
  - `spec_review -> reviewer child`
  - `spec_user_review -> human`

Likely files in orchestrator:
- orchestrator runtime
- routing config under `~/.openclaw/openagent/`
- thread message handlers

Exit criteria:
- route selection is derived from structured interaction data, not bulletin-only fallback behavior

### Phase 4: Directed Session Transport

Objective:
- make PM and specialist loops use directed sessions correctly and durably

Changes:
- add a session binding helper:
  - establish with `sessions_spawn(thread=true, mode="session")`
  - persist returned `childSessionKey`
  - follow up with `sessions_send`
- add session invalidation and rebinding logic
- ensure PM/specalist traffic is visible in the appropriate thread context where policy requires it
- emit:
  - `plan.session.bound`
  - `plan.session.rebound`
  - `plan.session.invalidated`

Rules:
- never use `sessions_send` for first contact unless a canonical bound session already exists
- rebinding should update `sessions.json` and the event log atomically enough for recovery

Exit criteria:
- PM clarification and approach/design approvals can survive restarts and stale sessions

### Phase 5: SDK Pause/Resume Path

Objective:
- make long-running planner gates park and resume the Anthropic planner session

Changes:
- persist planner `sdkSessionId` and `resumeStrategy`
- when planner emits an async interaction request:
  - mark planner session parked
  - end the active worker run cleanly
- once the orchestrator resolves the interaction:
  - attempt native SDK resume by `sdkSessionId`
  - pass structured answer content into the planner session
  - if resume fails and fallback exists, rerun with structured feedback
- emit:
  - `plan.session.parked`
  - `plan.session.resumed`
  - `plan.session.resume_failed`

Likely files in `openagent`:
- `src/run-session.ts`
- `src/session.ts`
- `bin/openagent-run.ts`

Likely files in orchestrator:
- worker session lifecycle wrapper

Exit criteria:
- async PM or human waits do not require one long-lived blocked process

### Phase 6: Spec Review Loop

Objective:
- model the `brainstorming` post-spec review loop as delegated work instead of bulletin chatter

Changes:
- add reviewer child-session or nested subagent dispatch
- persist review rounds and findings
- allow planner to revise spec based on structured findings
- cap review rounds and escalate on repeated failure

Policy:
- reviewer loop is delegated work, not approval authority
- review approval is not final user approval

Exit criteria:
- written spec passes through delegated review before user review and before `writing-plans`

### Phase 7: Human Gates

Objective:
- wire the required human-visible plan gates into the PDCA thread

Changes:
- add human escalation for PM-uncertain design sections
- add final user spec review gate in Discord
- persist thread message ids and decision payloads
- map button clicks or thread replies back into interaction resolutions

Rules:
- only escalated design sections should hit human review
- final user spec review must happen before `writing-plans`

Exit criteria:
- human gates are visible, resumable, and correctly sequenced

### Phase 8: Planner Completion Contract

Objective:
- enforce the required completion path from brainstorming through implementation plan generation

Changes:
- add completion guards:
  - spec exists
  - spec review passed
  - user spec review passed
  - implementation plan exists
- reject `plan_complete` if any prerequisite is missing
- explicitly instruct planner to transition from `brainstorming` to `writing-plans`

Exit criteria:
- planner cannot skip required review and approval gates

## PR Sequence

The safest rollout is 6 PRs.

### PR 1: State and Event Scaffolding

Scope:
- add JSON state/event writers and readers
- add schema-conformant artifacts
- no routing behavior change yet

Verification:
- unit tests for serialization and recovery bootstrap

### PR 2: Planner Interaction Envelope

Scope:
- structured interaction request parsing and persistence
- one-active-interaction guard
- planner session metadata persistence

Verification:
- tests that a planner request writes the expected interaction file and event sequence

### PR 3: Router and Transport Abstraction

Scope:
- orchestrator route selection
- adapters for PM, specialist, bulletin, human, reviewer
- current bulletin flow moved behind advisory adapter

Verification:
- routing matrix tests by interaction kind

### PR 4: Directed Session Binding and Recovery

Scope:
- `spawn -> persist -> send follow-ups`
- rebinding and stale-session recovery

Verification:
- tests for invalid session handle recovery

### PR 5: SDK Resume and Async Gates

Scope:
- planner park/resume lifecycle
- fallback to rerun only when contract allows it

Verification:
- tests that async approvals resume the same planner session

### PR 6: Spec Review and Human Gates

Scope:
- delegated review loop
- PM escalation to human
- final user spec review
- completion guards

Verification:
- end-to-end plan flow tests through `writing-plans`

## Testing Strategy

### Unit tests

- event envelope serialization
- interaction file validation
- route selection
- timeout policy
- resume payload rendering
- completion guards

### Integration tests

- planner emits clarification -> PM route selected
- planner emits advisory clarification -> bulletin route selected
- planner emits approach decision -> PM approval required
- PM uncertain on design section -> human escalation route selected
- reviewer returns findings -> planner revises -> reviewer approves
- final user review approval -> planner advances to `writing-plans`

### Recovery tests

- restart while waiting on PM session
- restart while planner session is parked
- stale PM session handle triggers rebind
- missing reviewer announce recovered from child session history
- failed SDK resume uses explicit fallback only

### Policy tests

- no single-owner decision uses bulletin
- no design section reaches `approved` without PM or human approval
- `plan_complete` cannot occur before implementation plan exists

## Open Questions

These need to be resolved before Phase 4 or 5 lands:

1. What exact primitive should the orchestrator use for PM direct conversation?
   - preferred answer: establish with `sessions_spawn`, follow up with `sessions_send`

2. What visibility policy applies to internal PM/specialist sessions?
   - if thread-visible summaries are required, codify that now

3. How should the planner encode interaction requests through the Anthropic SDK tool surface?
   - JSON-wrapped `AskUserQuestion` is the likely minimum-change path

4. What is the canonical reviewer agent or child profile for spec review?

5. What is the hard timeout/escalation policy for PM-owned plan decisions?

## Recommendation

Start with state and event scaffolding first, even if it temporarily duplicates the existing bulletin path. The failure mode to avoid is rewriting routing and pause/resume before there is a durable, inspectable control plane.

If implementation pressure forces one shortcut, keep the transport adapters thin but do not skip the schema and state artifacts. Those are the only part that makes recovery and async planner resume reliable.
